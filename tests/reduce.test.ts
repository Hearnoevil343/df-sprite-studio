import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_FOOT_BASELINE, buildRamps, createImage, getPixel, setPixel, templateById } from '../src/engine/index.ts';
import type { Palette, Rgba, RgbaImage, StatGroup, VanillaStats } from '../src/engine/index.ts';
import { cropToSubject, removeBackground } from '../src/engine/reduce/background.ts';
import { detectCell } from '../src/engine/reduce/grid.ts';
import { reduceImage } from '../src/engine/reduce/reduce.ts';
import { reduceBatch } from '../src/engine/reduce/batch.ts';

const WHITE: Rgba = [255, 255, 255, 255];
const RED: Rgba = [220, 20, 20, 255];
const BLUE: Rgba = [20, 20, 220, 255];
const GREEN: Rgba = [20, 160, 20, 255];
const NEAR_WHITE: Rgba = [250, 250, 250, 255]; // antialiased edge, close to white but not exact
const CLEAR: Rgba = [0, 0, 0, 0];

function fill(img: RgbaImage, c: Rgba): void {
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) setPixel(img, x, y, c);
}

function subjectOnWhite(): RgbaImage {
  const img = createImage(6, 6);
  fill(img, WHITE);
  setPixel(img, 2, 2, RED);
  setPixel(img, 3, 2, RED);
  setPixel(img, 2, 3, NEAR_WHITE); // antialiased edge pixel next to the subject
  return img;
}

test('removeBackground clears a solid corner colour and antialiased pixels near it', () => {
  const out = removeBackground(subjectOnWhite());
  assert.equal(out.issues.length, 0);
  assert.deepEqual(getPixel(out.img, 0, 0), [255, 255, 255, 0], 'corner cleared to transparent, colour kept');
  assert.deepEqual(getPixel(out.img, 2, 3), [250, 250, 250, 0], 'antialiased near-white pixel also cleared');
  assert.deepEqual(getPixel(out.img, 2, 2), RED, 'subject pixels are untouched');
  assert.deepEqual(getPixel(out.img, 3, 2), RED);
});

test('removeBackground keeps a pale cap that is within tolerance of the canvas colour but a hard step from it', () => {
  const CANVAS: Rgba = [156, 109, 172, 255];
  const CAP: Rgba = [161, 158, 147, 255]; // dwarf_miner's cap: pale grey, no dark outline against the canvas
  const img = createImage(12, 12);
  fill(img, CANVAS);
  for (let y = 3; y < 6; y++) for (let x = 4; x < 8; x++) setPixel(img, x, y, CAP);
  for (let y = 6; y < 9; y++) for (let x = 4; x < 8; x++) setPixel(img, x, y, [40, 54, 52, 255]);
  const out = removeBackground(img);
  assert.deepEqual(getPixel(out.img, 0, 0), [156, 109, 172, 0], 'canvas cleared');
  assert.deepEqual(getPixel(out.img, 5, 4), CAP, 'cap survives');
  assert.deepEqual(getPixel(out.img, 5, 7), [40, 54, 52, 255], 'outline survives');
});

test('removeBackground still clears a smooth vignette gradient in small steps', () => {
  const img = createImage(20, 20);
  for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) setPixel(img, x, y, [156 + x, 109, 172 - x, 255]);
  for (let y = 9; y < 12; y++) for (let x = 9; x < 12; x++) setPixel(img, x, y, RED);
  const out = removeBackground(img);
  assert.equal(getPixel(out.img, 19, 19)[3], 0, 'far end of the gradient cleared');
  assert.deepEqual(getPixel(out.img, 10, 10), RED);
});

test('removeBackground is a no-op and reports reduce-bg-skip when the corners are not near-uniform', () => {
  // Large enough (24x24, 92 border pixels) that the 4 corners trivially
  // "matching themselves" still stay under the 5% border-match threshold.
  const img = createImage(24, 24);
  const BUSY: Rgba[] = [[20, 20, 20, 255], [235, 235, 20, 255], [20, 235, 235, 255], [235, 20, 235, 255], [120, 235, 20, 255], [20, 120, 235, 255]];
  let i = 0;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) setPixel(img, x, y, BUSY[i++ % BUSY.length]);
  // Corners each get their own colour, chosen far (in OKLab) from every busy colour above.
  setPixel(img, 0, 0, [255, 255, 255, 255]);
  setPixel(img, 23, 0, [0, 0, 0, 255]);
  setPixel(img, 0, 23, [128, 0, 0, 255]);
  setPixel(img, 23, 23, [0, 0, 128, 255]);
  const out = removeBackground(img);
  assert.equal(out.issues.length, 1);
  assert.equal(out.issues[0].rule, 'reduce-bg-skip');
  assert.deepEqual([...out.img.data], [...img.data]);
  assert.notEqual(out.img, img, 'a clone, not the original object');
});

test('removeBackground leaves an already-transparent background alone (no colour to reason about)', () => {
  const img = createImage(6, 6);
  setPixel(img, 2, 2, RED);
  setPixel(img, 3, 2, RED);
  const out = removeBackground(img);
  assert.equal(out.issues.length, 0);
  assert.deepEqual(getPixel(out.img, 2, 2), RED);
  assert.deepEqual(getPixel(out.img, 0, 0), CLEAR);
});

test('removeBackground mops up a noise-isolated background pocket the anchor flood could not reach', () => {
  // Real defect: per-pixel generator
  // dithering put a handful of background pixels just past `tolerance` of
  // the corner colour, walling off a pocket of true background from the
  // corner-anchored flood even though it reads as flat background by eye.
  // cropToSubject then bounding-boxed the leftover opaque pocket along with
  // the real subject, blowing a ~140x220 subject out to a 552x640 crop.
  // Reproduced minimally: a single pixel just outside `tolerance` of the
  // corner colour (so the main flood can't step onto it) but inside 2x
  // tolerance (so the mop-up may still recognise it as background), with
  // every neighbour cleared by the main flood around it.
  const img = createImage(6, 6);
  fill(img, WHITE);
  setPixel(img, 3, 3, [210, 210, 210, 255]); // OKLab distance ~0.136 from white
  const out = removeBackground(img, { tolerance: 0.09 }); // pocket: 0.09 < 0.136 < 0.18
  assert.deepEqual(getPixel(out.img, 3, 3), [210, 210, 210, 0], 'isolated background pocket cleared too');
});

test('removeBackground reports reduce-bg-thin when it clears the border floor but almost nothing else (tolerance too tight)', () => {
  // 20x20, all SUBJECT except the 4 corner pixels: each corner matches only
  // itself (distance 0), clearing just 4/76 border points (5.3%, over the 5%
  // MIN_BORDER_MATCH floor) and 4/400 pixels overall (1%, under the 30%
  // MIN_CLEARED_FRACTION floor) since flood fill can't spread past the
  // far-off SUBJECT colour surrounding each corner. This is exactly the
  // 0.08-tolerance v2 vignette failure: passes the border floor, clears
  // almost nothing, and used to report nothing wrong.
  const SUBJECT: Rgba = [40, 90, 180, 255];
  const img = createImage(20, 20);
  fill(img, SUBJECT);
  setPixel(img, 0, 0, [255, 255, 255, 255]);
  setPixel(img, 19, 0, [0, 0, 0, 255]);
  setPixel(img, 0, 19, [128, 0, 0, 255]);
  setPixel(img, 19, 19, [0, 0, 128, 255]);
  const out = removeBackground(img);
  assert.equal(out.issues.length, 1);
  assert.equal(out.issues[0].rule, 'reduce-bg-thin');
  assert.equal(out.issues[0].severity, 'warn');
  assert.deepEqual(getPixel(out.img, 0, 0), [255, 255, 255, 0], 'the corners themselves still cleared');
  assert.deepEqual(getPixel(out.img, 10, 10), SUBJECT, 'the subject is untouched');
});

test('removeBackground auto-retries a too-tight default tolerance and clears past the thin floor', () => {
  // 20x20: SUBJECT fills the interior 16x16, a 2px background ring around it.
  // The ring's own colour (BG1) sits ~0.18 OKLab from the corner anchor
  // colour (BG0, exact at the 4 corners) -- outside the default 0.15
  // tolerance, so the first pass only clears the 4 corner pixels (1%,
  // under MIN_CLEARED_FRACTION) exactly like the reduce-bg-thin case above.
  // The auto-retry (tolerance ~0.15 -> ~0.24, opts.tolerance left
  // unspecified) should then clear the whole ring (36%, past the 30% floor)
  // without ever approaching SUBJECT, so the final result reports no issue.
  const SUBJECT: Rgba = [20, 20, 180, 255];
  const BG0: Rgba = [255, 255, 255, 255];
  const BG1: Rgba = [235, 235, 235, 255];
  const img = createImage(20, 20);
  fill(img, SUBJECT);
  for (let x = 0; x < 20; x++) for (let y = 0; y < 20; y++) {
    if (x < 2 || x > 17 || y < 2 || y > 17) setPixel(img, x, y, BG1);
  }
  setPixel(img, 0, 0, BG0); setPixel(img, 19, 0, BG0); setPixel(img, 0, 19, BG0); setPixel(img, 19, 19, BG0);
  const out = removeBackground(img);
  assert.equal(out.issues.length, 0, 'the retry cleared past the thin floor, so no reduce-bg-thin warning');
  assert.deepEqual(getPixel(out.img, 0, 0), [...BG0.slice(0, 3), 0] as Rgba, 'ring cleared');
  assert.deepEqual(getPixel(out.img, 1, 1), [...BG1.slice(0, 3), 0] as Rgba, 'ring cleared past the corner too');
  assert.deepEqual(getPixel(out.img, 10, 10), SUBJECT, 'the subject is untouched by the retry');
});

test('removeBackground does not retry when the caller gave an explicit tolerance', () => {
  const SUBJECT: Rgba = [20, 20, 180, 255];
  const BG0: Rgba = [255, 255, 255, 255];
  const BG1: Rgba = [235, 235, 235, 255];
  const img = createImage(20, 20);
  fill(img, SUBJECT);
  for (let x = 0; x < 20; x++) for (let y = 0; y < 20; y++) {
    if (x < 2 || x > 17 || y < 2 || y > 17) setPixel(img, x, y, BG1);
  }
  setPixel(img, 0, 0, BG0); setPixel(img, 19, 0, BG0); setPixel(img, 0, 19, BG0); setPixel(img, 19, 19, BG0);
  // Tight enough that even the ring (BG1) stays out of reach, same shape as
  // the plain reduce-bg-thin case above; the point here is only that a
  // caller-supplied tolerance is never grown automatically.
  const out = removeBackground(img, { tolerance: 0.02 });
  assert.equal(out.issues.length, 1, 'an explicit tolerance is respected exactly, no auto-retry');
  assert.equal(out.issues[0].rule, 'reduce-bg-thin');
});

test('cropToSubject tightens to the opaque bounding box, with optional padding', () => {
  const img = createImage(10, 10);
  setPixel(img, 3, 4, RED);
  setPixel(img, 5, 6, RED);
  const tight = cropToSubject(img);
  assert.equal(tight.issues.length, 0);
  assert.equal(tight.img.width, 3); // 3..5 inclusive
  assert.equal(tight.img.height, 3); // 4..6 inclusive
  assert.deepEqual(getPixel(tight.img, 0, 0), RED);
  assert.deepEqual(getPixel(tight.img, 2, 2), RED);

  const padded = cropToSubject(img, 1);
  assert.equal(padded.img.width, 5);
  assert.equal(padded.img.height, 5);
  assert.deepEqual(getPixel(padded.img, 1, 1), RED, 'subject shifted by the padding margin');
  assert.deepEqual(getPixel(padded.img, 0, 0), CLEAR, 'padding itself is transparent');
});

test('cropToSubject on a fully transparent image is a no-op and reports reduce-blank', () => {
  const img = createImage(4, 4);
  const out = cropToSubject(img);
  assert.equal(out.issues.length, 1);
  assert.equal(out.issues[0].rule, 'reduce-blank');
  assert.equal(out.img.width, 4);
  assert.equal(out.img.height, 4);
});

// A real 4x4-per-cell "fake pixel art" source: each 4x4 block is one flat
// colour, like a LoRA upscale of native 8x8 pixel art rendered at 32x32.
function blockyImage(cell: number, cellsW: number, cellsH: number): RgbaImage {
  const img = createImage(cell * cellsW, cell * cellsH);
  const palette: Rgba[] = [RED, WHITE, [20, 20, 220, 255], [20, 160, 20, 255]];
  for (let by = 0; by < cellsH; by++) {
    for (let bx = 0; bx < cellsW; bx++) {
      const c = palette[(bx + by * 3) % palette.length];
      for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) setPixel(img, bx * cell + x, by * cell + y, c);
    }
  }
  return img;
}

test('detectCell finds the block size of blocky "fake pixel art"', () => {
  const { size, confidence } = detectCell(blockyImage(4, 8, 8));
  assert.equal(size, 4);
  assert.ok(confidence > 0, 'a real grid should score clearly better than the next candidate');
});

test('detectCell on real per-pixel art (no upscale) comes back with a low, flat-curve size', () => {
  const img = blockyImage(1, 32, 32); // every pixel its own colour: no larger grid to find
  const { size } = detectCell(img);
  assert.equal(size, 1);
});

function makePalette(): Palette {
  const colours = [CLEAR, RED, WHITE, BLUE, GREEN];
  return { colours, ramps: buildRamps(colours) };
}

const BLOCK_PALETTE: Rgba[] = [RED, WHITE, BLUE, GREEN];
// Same colour-per-cell formula blockyImage uses, so the downscaled output can
// be predicted exactly rather than re-deriving it from pixels.
function blockColour(bx: number, by: number): Rgba {
  return BLOCK_PALETTE[(bx + by * 3) % BLOCK_PALETTE.length];
}

// A black 40x40 scene holding blockyImage's 32x32 "fake pixel art" subject
// (cell 4, 8x8 cells, including a WHITE cell) at (4,4). Black, not white, is
// the background here so the subject's own WHITE cell isn't 4-connected to
// the border and doesn't get eaten by background removal.
function sceneWithSubject(): RgbaImage {
  const scene = createImage(40, 40);
  fill(scene, [0, 0, 0, 255]);
  const block = blockyImage(4, 8, 8);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) setPixel(scene, 4 + x, 4 + y, getPixel(block, x, y));
  return scene;
}

function statsWithFootBaseline(footBaseline: number): VanillaStats {
  const g: StatGroup = {
    sprites: 100,
    bbox: { x: 0, y: 0, w: 2, h: 2 },
    footBaseline,
    headFound: 0,
    headSide: {},
    bySide: {},
    band: { x0: [0, 0], y0: [0, 0], x1: [2, 2], y1: [2, 2], footBaseline: [footBaseline, footBaseline] },
  };
  return { proportions: { all: g, byToken: {}, byPage: {}, byPageToken: {} } };
}

test('reduceImage wires background removal, crop, grid detection, fit-to-tile and palette snap together', () => {
  // tileSpan 8 x cell 4 = 32, exactly the cropped subject's size, so
  // fit-to-tile needs no padding and each downscale cell lines up 1:1 with
  // one of blockyImage's own 4x4 cells: the output should reproduce the same
  // (bx + by*3) % 4 colour formula, one pixel per original cell.
  const footBaseline = 7; // last row of an 8-row canvas: bottomAlign is then a no-op
  const out = reduceImage(sceneWithSubject(), makePalette(), { tileSpan: 8, stats: statsWithFootBaseline(footBaseline) });
  assert.equal(out.issues.length, 0);
  assert.equal(out.cell, 4, 'grid detection ran on the cropped 32x32 subject, not the 40x40 scene');
  assert.equal(out.img.width, 8);
  assert.equal(out.img.height, 8);
  for (let by = 0; by < 8; by++) for (let bx = 0; bx < 8; bx++) assert.deepEqual(getPixel(out.img, bx, by), blockColour(bx, by), `cell (${bx},${by})`);
});

test('reduceImage takes its foot baseline from the vanilla stats guide when supplied', () => {
  // footBaseline 6 (one row above where every cell already sits, since the
  // grid is fully opaque and bottoms out at row 7) shifts everything up by a
  // row; the row it vacates comes back at the bottom because outline() then
  // fills that now-transparent row from its (opaque) neighbour above, one
  // ramp step darker where the palette has one - here every colour is alone
  // on its own ramp, so the fill colour comes back unchanged.
  const out = reduceImage(sceneWithSubject(), makePalette(), { tileSpan: 8, stats: statsWithFootBaseline(6) });
  for (let bx = 0; bx < 8; bx++) {
    for (let by = 0; by < 7; by++) assert.deepEqual(getPixel(out.img, bx, by), blockColour(bx, by + 1), `row ${by} shifted up from row ${by + 1}`);
    assert.deepEqual(getPixel(out.img, bx, 7), blockColour(bx, 7), 'bottom row outlined from its row-6 neighbour, same colour formula');
  }
});

test('reduceImage falls back to DEFAULT_FOOT_BASELINE when no vanilla stats are supplied', () => {
  // DEFAULT_FOOT_BASELINE (28) sits far below an 8-row canvas, so both calls
  // shift every row out of bounds; what matters is that they land on exactly
  // the same (blank) result, proving the fallback is wired to that constant.
  const scene = sceneWithSubject();
  const palette = makePalette();
  const withDefault = reduceImage(scene, palette, { tileSpan: 8 });
  const withExplicitDefault = reduceImage(scene, palette, { tileSpan: 8, stats: statsWithFootBaseline(DEFAULT_FOOT_BASELINE) });
  assert.deepEqual([...withDefault.img.data], [...withExplicitDefault.img.data]);
});

test('reduceImage forwards issues from earlier stages (e.g. a blank source)', () => {
  const out = reduceImage(createImage(4, 4), makePalette(), { tileSpan: 1 });
  assert.ok(out.issues.some(i => i.rule === 'reduce-blank'));
});

test('reduceImage skips background/crop/cell-detection for an already sprite-scale source when opted in', () => {
  // A 40x40 scene at or under ALREADY_SPRITE_SCALE (64): with the flag on,
  // the source should be fit-to-tile directly rather than run through
  // removeBackground/cropToSubject/detectCell, which on a real near-final,
  // already-reduced generator export can mistakenly detect a cell and
  // crush a recognisable sprite down to 4x4.
  const scene = sceneWithSubject(); // see the fixture above: 40x40, opaque
  const palette = makePalette();
  const skipped = reduceImage(scene, palette, { tileSpan: 8, skipIfAlreadySpriteScale: true });
  assert.ok(skipped.issues.some(i => i.rule === 'reduce-already-sprite-scale'));
  assert.equal(skipped.cell, 1, 'cell detection never ran');
  assert.equal(skipped.img.width, 8);
  assert.equal(skipped.img.height, 8);

  // Off (the default) behaves exactly as before: full chain, no new issue.
  const notSkipped = reduceImage(scene, palette, { tileSpan: 8 });
  assert.ok(!notSkipped.issues.some(i => i.rule === 'reduce-already-sprite-scale'));
});

test('reduceBatch matches files to template entries by filename ("<key>.png") and reduces each', () => {
  const vermin = templateById('vermin')!;
  const files = [{ name: 'VERMIN.png', img: sceneWithSubject() }];
  const { creature, issues } = reduceBatch(files, makePalette(), vermin, { id: 'test_creature' });
  assert.equal(creature.id, 'test_creature');
  assert.equal(creature.templateId, 'vermin');
  assert.ok(creature.sprites.VERMIN);
  assert.equal(creature.sprites.VERMIN.width, 32, 'defaults to TILE (32) for a single-tile entry');
  assert.ok(issues.some(i => i.rule === 'reduce-cell' && i.key === 'VERMIN'));
});

test('reduceBatch reports reduce-unmatched and skips a file with no matching template entry', () => {
  const vermin = templateById('vermin')!;
  const files = [{ name: 'NOT_A_REAL_ENTRY.png', img: sceneWithSubject() }];
  const { creature, issues } = reduceBatch(files, makePalette(), vermin, { id: 'test_creature' });
  assert.deepEqual(creature.sprites, {});
  assert.equal(issues.length, 1);
  assert.equal(issues[0].rule, 'reduce-unmatched');
});

test('reduceBatch adds a matched default:false entry to include, so activeEntries turns it on', () => {
  const vermin = templateById('vermin')!;
  const files = [{ name: 'VERMIN_ALT.png', img: sceneWithSubject() }]; // VERMIN_ALT: "default": false
  const { creature } = reduceBatch(files, makePalette(), vermin, { id: 'test_creature' });
  assert.deepEqual(creature.include, ['VERMIN_ALT']);
});

test('reduceBatch skips a non-square multi-tile entry (reduceImage only outputs a square) with reduce-unmatched', () => {
  const multiTile = templateById('multi-tile-creature')!; // DEFAULT is 3x2 tiles
  const files = [{ name: 'DEFAULT.png', img: sceneWithSubject() }];
  const { creature, issues } = reduceBatch(files, makePalette(), multiTile, { id: 'test_creature' });
  assert.deepEqual(creature.sprites, {});
  assert.equal(issues.length, 1);
  assert.equal(issues[0].rule, 'reduce-unmatched');
  assert.match(issues[0].message, /not square/);
});

// Bilinear (alpha-premultiplied irrelevant here: opaque source) upscale by k.
function bilinearUp(img: RgbaImage, k: number): RgbaImage {
  const out = createImage(img.width * k, img.height * k);
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const fx = Math.max(0, Math.min(img.width - 1, (x + 0.5) / k - 0.5));
      const fy = Math.max(0, Math.min(img.height - 1, (y + 0.5) / k - 0.5));
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const x1 = Math.min(img.width - 1, x0 + 1), y1 = Math.min(img.height - 1, y0 + 1);
      const tx = fx - x0, ty = fy - y0;
      const px: Rgba = [0, 0, 0, 255];
      for (let c = 0; c < 3; c++) {
        const top = getPixel(img, x0, y0)[c] * (1 - tx) + getPixel(img, x1, y0)[c] * tx;
        const bot = getPixel(img, x0, y1)[c] * (1 - tx) + getPixel(img, x1, y1)[c] * tx;
        px[c] = Math.round(top * (1 - ty) + bot * ty);
      }
      setPixel(out, x, y, px);
    }
  }
  return out;
}

// Pseudo-random native-res "sprite": varied colours, no upscale structure.
function nativeArt(): RgbaImage {
  const img = createImage(32, 32);
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const cols: Rgba[] = [RED, WHITE, [20, 20, 220, 255], [20, 160, 20, 255], [90, 60, 30, 255]];
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) setPixel(img, x, y, cols[Math.floor(rnd() * cols.length)]);
  return img;
}

test('detectCell finds 4 in a bilinear 4x upscale of native pixel art', () => {
  const { size } = detectCell(bilinearUp(nativeArt(), 4));
  assert.equal(size, 4);
});

test('detectCell on native-res pixel art returns 1', () => {
  assert.equal(detectCell(nativeArt()).size, 1);
});

test('detectCell on a noisy image returns 1 with low confidence', () => {
  const img = createImage(64, 64);
  let seed = 999;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) setPixel(img, x, y, [Math.floor(rnd() * 256), Math.floor(rnd() * 256), Math.floor(rnd() * 256), 255]);
  const { size, confidence } = detectCell(img);
  assert.equal(size, 1);
  assert.ok(confidence < 0.15);
});

test('cropToSubject with a cell snaps the crop out to the canvas grid, killing the half-cell phase that smears every block', () => {
  // A subject at y=12 on a cell-8 grid has a phase of 4: exactly half a cell,
  // so every later 8x8 block straddles two of the generator's own pixels.
  const img = createImage(32, 32);
  for (let y = 12; y < 20; y++) for (let x = 8; x < 16; x++) setPixel(img, x, y, [200, 30, 30, 255]);

  const tight = cropToSubject(img).img;
  assert.equal(tight.width, 8);
  assert.equal(tight.height, 8);

  const aligned = cropToSubject(img, 0, 8).img;
  assert.equal(aligned.width, 8, 'x already sat on the grid, so it does not grow');
  assert.equal(aligned.height, 16, 'y snapped out from 12..19 to 8..23');
  // The subject now sits at a multiple of the cell inside the crop.
  assert.deepEqual(getPixel(aligned, 0, 4), [200, 30, 30, 255]);
  assert.deepEqual(getPixel(aligned, 0, 0), [0, 0, 0, 0], 'the snapped-in rows are transparent padding');
});

test('cropToSubject with a cell of 0 or 1 is the old tight crop', () => {
  const img = createImage(16, 16);
  for (let y = 5; y < 9; y++) for (let x = 5; x < 9; x++) setPixel(img, x, y, [10, 10, 200, 255]);
  for (const cell of [0, 1]) {
    const out = cropToSubject(img, 0, cell).img;
    assert.equal(out.width, 4, `cell ${cell} crops tight`);
    assert.equal(out.height, 4);
  }
});
