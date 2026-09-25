import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRamps, createImage, getPixel, rgbToOklab, setPixel } from '../src/engine/index.ts';
import type { Palette, Rgba, RgbaImage } from '../src/engine/index.ts';
import { contrastLift, deCast, despeckle, levels, paletteAlign, quantize, repairOutline, snapToGrid } from '../src/engine/reduce/df-look.ts';

const CLEAR: Rgba = [0, 0, 0, 0];
const RED: Rgba = [220, 20, 20, 255];
const DARK_RED: Rgba = [110, 10, 10, 255];
const WHITE: Rgba = [255, 255, 255, 255];
const BLUE: Rgba = [20, 20, 220, 255];

function fill(img: RgbaImage, c: Rgba): void {
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) setPixel(img, x, y, c);
}

test('snapToGrid flattens a uniform block to the same colour and averages a mixed one in OKLab', () => {
  const img = createImage(4, 2); // two 2x2 blocks
  setPixel(img, 0, 0, RED); setPixel(img, 1, 0, RED); setPixel(img, 0, 1, RED); setPixel(img, 1, 1, RED);
  setPixel(img, 2, 0, RED); setPixel(img, 3, 0, WHITE); setPixel(img, 2, 1, RED); setPixel(img, 3, 1, WHITE);
  const out = snapToGrid(img, 2);
  assert.equal(out.width, 2);
  assert.equal(out.height, 1);
  assert.deepEqual(getPixel(out, 0, 0), RED, 'uniform block stays exactly its own colour');
  const mixed = getPixel(out, 1, 0);
  assert.equal(mixed[3], 255);
  assert.notDeepEqual(mixed, RED);
  assert.notDeepEqual(mixed, WHITE);
});

test('snapToGrid reads a block as background when fewer than half its pixels are opaque', () => {
  const img = createImage(2, 2);
  setPixel(img, 0, 0, RED); // 1 of 4 opaque
  const out = snapToGrid(img, 2);
  assert.deepEqual(getPixel(out, 0, 0), CLEAR);
});

test('snapToGrid ceils a non-exact remainder rather than dropping edge pixels', () => {
  const img = createImage(3, 1);
  fill(img, RED);
  const out = snapToGrid(img, 2);
  assert.equal(out.width, 2); // ceil(3/2)
  assert.deepEqual(getPixel(out, 1, 0), RED, 'the lone remainder pixel still forms a (1-wide) block');
});

function makePalette(): Palette {
  const colours = [CLEAR, DARK_RED, RED, WHITE, BLUE];
  return { colours, ramps: buildRamps(colours) };
}

test('paletteAlign clusters the image\'s own colours and snaps each cluster to the nearest palette colour (snapToVanilla: true)', () => {
  const img = createImage(2, 2);
  // Two colours close to RED, two close to WHITE: k=2 should recover both groups.
  setPixel(img, 0, 0, [215, 25, 25, 255]);
  setPixel(img, 1, 0, [225, 15, 15, 255]);
  setPixel(img, 0, 1, [250, 250, 250, 255]);
  setPixel(img, 1, 1, [255, 255, 255, 255]);
  const out = paletteAlign(img, makePalette(), { k: 2, snapToVanilla: true });
  assert.deepEqual(getPixel(out, 0, 0), RED);
  assert.deepEqual(getPixel(out, 1, 0), RED);
  assert.deepEqual(getPixel(out, 0, 1), WHITE);
  assert.deepEqual(getPixel(out, 1, 1), WHITE);
});

test('paletteAlign defaults to snapToVanilla: false so cluster colour stays close to the input rather than the vanilla palette', () => {
  const img = createImage(2, 2);
  setPixel(img, 0, 0, [215, 25, 25, 255]);
  setPixel(img, 1, 0, [225, 15, 15, 255]);
  setPixel(img, 0, 1, [250, 250, 250, 255]);
  setPixel(img, 1, 1, [255, 255, 255, 255]);
  const out = paletteAlign(img, makePalette(), { k: 2 });
  // Neither cluster is RED or WHITE exactly (the palette's own colours):
  // it's the image's own near-red/near-white centroid instead.
  assert.notDeepEqual(getPixel(out, 0, 0), RED);
  assert.notDeepEqual(getPixel(out, 0, 1), WHITE);
  assert.deepEqual(getPixel(out, 0, 0), getPixel(out, 1, 0), 'still clustered together');
  assert.deepEqual(getPixel(out, 0, 1), getPixel(out, 1, 1), 'still clustered together');
});

test('paletteAlign leaves transparent pixels alone and a blank image untouched', () => {
  const img = createImage(2, 2);
  const out = paletteAlign(img, makePalette(), { k: 4 });
  assert.deepEqual([...out.data], [...img.data]);
});

test('paletteAlign defaults k to 16 when omitted (chosen over quantize k=24 for flatter, more DF-like colour blocks)', () => {
  const img = createImage(2, 2);
  setPixel(img, 0, 0, [215, 25, 25, 255]);
  setPixel(img, 1, 0, [225, 15, 15, 255]);
  setPixel(img, 0, 1, [250, 250, 250, 255]);
  setPixel(img, 1, 1, [255, 255, 255, 255]);
  const withDefault = paletteAlign(img, makePalette(), {});
  const withExplicit16 = paletteAlign(img, makePalette(), { k: 16 });
  assert.deepEqual([...withDefault.data], [...withExplicit16.data]);
});

test('contrastLift pushes lightness away from the image mean and leaves alpha and transparency untouched', () => {
  const img = createImage(2, 1);
  setPixel(img, 0, 0, DARK_RED); // darker than mean
  setPixel(img, 1, 0, WHITE);    // lighter than mean
  const out = contrastLift(img, { lightness: 1.5, chroma: 1 });
  const meanLBefore = (rgbToOklab(DARK_RED).L + rgbToOklab(WHITE).L) / 2;
  const darkOut = rgbToOklab(getPixel(out, 0, 0));
  const lightOut = rgbToOklab(getPixel(out, 1, 0));
  assert.ok(darkOut.L < rgbToOklab(DARK_RED).L, 'darker-than-mean pixel pushed darker');
  assert.ok(lightOut.L > rgbToOklab(WHITE).L - 1e-6, 'lighter-than-mean pixel pushed lighter (or already clamped at 1)');
  assert.ok(Math.abs(meanLBefore - (darkOut.L + lightOut.L) / 2) < 0.2, 'still centred near the original mean');
  assert.equal(getPixel(out, 0, 0)[3], 255);
});

test('contrastLift skips transparent pixels and is a safe no-op on a blank image', () => {
  const img = createImage(3, 3);
  const out = contrastLift(img);
  assert.deepEqual([...out.data], [...img.data]);
});

test('despeckle replaces a pixel that agrees with none of its 4 neighbours with their majority colour', () => {
  const img = createImage(3, 3);
  fill(img, RED);
  setPixel(img, 1, 1, WHITE); // centre disagrees with all 4 RED neighbours
  const out = despeckle(img);
  assert.deepEqual(getPixel(out, 1, 1), RED);
});

test('despeckle leaves a pixel alone when it agrees with at least one neighbour', () => {
  const img = createImage(3, 3);
  fill(img, RED);
  setPixel(img, 1, 1, WHITE);
  setPixel(img, 0, 1, WHITE); // one neighbour now agrees with the centre
  const out = despeckle(img);
  assert.deepEqual(getPixel(out, 1, 1), WHITE);
});

test('despeckle leaves a pixel alone when its 4 neighbours have no majority colour', () => {
  const img = createImage(3, 3);
  setPixel(img, 1, 0, RED); setPixel(img, 1, 2, WHITE); setPixel(img, 0, 1, BLUE); setPixel(img, 2, 1, DARK_RED);
  setPixel(img, 1, 1, [1, 2, 3, 255]);
  const out = despeckle(img);
  assert.deepEqual(getPixel(out, 1, 1), [1, 2, 3, 255]);
});

test('despeckle never touches border pixels (they lack a full set of 4 neighbours)', () => {
  const img = createImage(2, 2);
  setPixel(img, 0, 0, RED); setPixel(img, 1, 0, WHITE); setPixel(img, 0, 1, BLUE); setPixel(img, 1, 1, DARK_RED);
  const out = despeckle(img);
  assert.deepEqual([...out.data], [...img.data]);
});

test('repairOutline darkens an opaque pixel touching background by one ramp step, hue preserved', () => {
  const palette = makePalette(); // DARK_RED/RED share a ramp (same hue bucket), ordered darkest to lightest
  const img = createImage(3, 1);
  setPixel(img, 0, 0, CLEAR);
  setPixel(img, 1, 0, RED); // touches background at x=0: an edge pixel
  setPixel(img, 2, 0, RED); // interior-ish, but touches the canvas edge at x=2 too
  const out = repairOutline(img, palette);
  assert.deepEqual(getPixel(out, 1, 0), DARK_RED, 'edge pixel stepped one shade darker, same hue');
});

test('repairOutline is a safe no-op on a colour already at the darkest end of its ramp', () => {
  const palette = makePalette();
  const img = createImage(2, 1);
  setPixel(img, 0, 0, CLEAR);
  setPixel(img, 1, 0, DARK_RED); // already darkest on its ramp
  const out = repairOutline(img, palette);
  assert.deepEqual(getPixel(out, 1, 0), DARK_RED);
});

test('deCast strips chroma from the cast hue and leaves a far-off hue alone', () => {
  const img = createImage(2, 1);
  const magenta: Rgba = [180, 90, 180, 255];          // near the 317deg cast hue
  setPixel(img, 0, 0, magenta);
  setPixel(img, 1, 0, [40, 170, 60, 255]);            // green, well outside the span
  const out = deCast(img);
  const [r, g, b] = getPixel(out, 0, 0);
  assert.ok(Math.abs(r - g) < 20 && Math.abs(b - g) < 20, `cast hue should go near-neutral, got ${r},${g},${b}`);
  assert.deepEqual(getPixel(out, 1, 0), [40, 170, 60, 255], 'a hue outside the span is untouched');
});

test('deCast leaves transparent pixels alone and strength 0 is a no-op', () => {
  const img = createImage(2, 1);
  setPixel(img, 0, 0, [180, 90, 180, 255]);
  const out = deCast(img, { strength: 0 });
  assert.deepEqual(getPixel(out, 0, 0), [180, 90, 180, 255]);
  assert.deepEqual(getPixel(out, 1, 0), CLEAR);
});

test('levels stretches a narrow dark band out to the full range', () => {
  const img = createImage(3, 1);
  setPixel(img, 0, 0, [30, 30, 30, 255]);
  setPixel(img, 1, 0, [45, 45, 45, 255]);
  setPixel(img, 2, 0, [60, 60, 60, 255]);
  const out = levels(img);
  const lo = rgbToOklab(getPixel(out, 0, 0)).L;
  const hi = rgbToOklab(getPixel(out, 2, 0)).L;
  assert.ok(hi - lo > 0.7, `range should open up, got ${(hi - lo).toFixed(3)}`);
  assert.ok(rgbToOklab(getPixel(out, 1, 0)).L > lo, 'the middle stays between the ends');
});

test('levels is a safe no-op on a flat image and on a blank one', () => {
  const flat = createImage(2, 1);
  fill(flat, RED);
  assert.deepEqual(getPixel(levels(flat), 0, 0), RED);
  const blank = createImage(2, 1);
  assert.deepEqual(getPixel(levels(blank), 0, 0), CLEAR);
});

test('quantize cuts the colour count without snapping to the vanilla palette', () => {
  const img = createImage(6, 1);
  // three tight pairs: each pair should collapse to one centroid
  const pairs: Rgba[] = [[200, 20, 20, 255], [204, 24, 24, 255], [20, 200, 20, 255], [24, 204, 24, 255], [20, 20, 200, 255], [24, 24, 204, 255]];
  pairs.forEach((c, i) => setPixel(img, i, 0, c));
  const out = quantize(img, { k: 3, seed: 1 });
  const seen = new Set<string>();
  for (let x = 0; x < 6; x++) seen.add(getPixel(out, x, 0).join(','));
  assert.equal(seen.size, 3, 'six colours collapse to three centroids');
  // red stays red: the centroid is the cluster mean, not a palette entry
  const red = getPixel(out, 0, 0);
  assert.ok(red[0] > red[1] + 100 && red[0] > red[2] + 100, `red must stay red, got ${red}`);
});

test('quantize leaves transparency alone and is a no-op on a blank image', () => {
  const img = createImage(2, 1);
  setPixel(img, 0, 0, RED);
  const out = quantize(img, { k: 4, seed: 1 });
  assert.deepEqual(getPixel(out, 1, 0), CLEAR);
  assert.deepEqual(getPixel(out, 0, 0), RED, 'a single colour survives as its own centroid');
});

test('trueGridSample finds an 8 px grid, clears canvas, halos and enclosed holes, keeps native size', async () => {
  const { trueGridSample } = await import('../src/engine/reduce/true-grid.ts');
  const CANVAS: Rgba = [200, 190, 200, 255];
  const cells = 14, S = 8;
  const img = createImage(cells * S, cells * S);
  fill(img, CANVAS);
  const block = (cx: number, cy: number, c: Rgba) => { for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) setPixel(img, cx * S + x, cy * S + y, c); };
  // 6x6 red body with a 2x2 canvas-coloured hole, black outline ring around it.
  for (let cy = 3; cy < 9; cy++) for (let cx = 3; cx < 9; cx++) {
    const edge = cx === 3 || cx === 8 || cy === 3 || cy === 8;
    block(cx, cy, edge ? [20, 20, 20, 255] : ((cx === 5 || cx === 6) && (cy === 5 || cy === 6) ? CANVAS : ((cx + cy) % 2 ? RED : DARK_RED)));
  }
  const tg = trueGridSample(img);
  assert.ok(tg);
  assert.ok(Math.abs(tg.period - 8) < 0.3);
  assert.equal(tg.img.width, 6);
  assert.equal(tg.img.height, 6);
  assert.equal(getPixel(tg.img, 2, 2)[3], 0, 'enclosed canvas hole cleared');
  assert.equal(getPixel(tg.img, 0, 0)[3], 255, 'outline kept');
});

test('trueGridSample returns null on an empty canvas', async () => {
  const { trueGridSample } = await import('../src/engine/reduce/true-grid.ts');
  const img = createImage(64, 64); fill(img, [200, 190, 200, 255]);
  assert.equal(trueGridSample(img), null);
});

test('edgeDarken darkens silhouette pixels and leaves the interior', async () => {
  const { edgeDarken } = await import('../src/engine/reduce/true-grid.ts');
  const img = createImage(3, 3); fill(img, RED);
  const out = edgeDarken(img);
  assert.deepEqual(getPixel(out, 1, 1), RED);
  assert.ok(rgbToOklab(getPixel(out, 0, 0)).L < rgbToOklab(RED).L);
});

test('trueGridSample drops a detached speck instead of stretching the crop', async () => {
  const { trueGridSample } = await import('../src/engine/reduce/true-grid.ts');
  const S = 8, img = createImage(16 * S, 16 * S);
  fill(img, [200, 190, 200, 255]);
  const block = (cx: number, cy: number, c: Rgba) => { for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) setPixel(img, cx * S + x, cy * S + y, c); };
  for (let cy = 2; cy < 8; cy++) for (let cx = 2; cx < 8; cx++) block(cx, cy, (cx + cy) % 2 ? RED : DARK_RED);
  block(14, 14, [20, 20, 20, 255]);
  const tg = trueGridSample(img);
  assert.ok(tg);
  assert.equal(tg.img.width, 6);
  assert.equal(tg.img.height, 6);
});
