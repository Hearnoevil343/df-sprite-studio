import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bottomAlign, buildRamps, createImage, downscale, draftPlan, draftVariant, getPixel, rotate90, setPixel, templateById,
} from '../src/engine/index.ts';
import type { Palette, Rgba } from '../src/engine/index.ts';

const RED: Rgba = [220, 20, 20, 255];
const DARK_RED: Rgba = [110, 10, 10, 255];
const CLEAR: Rgba = [0, 0, 0, 0];

function makePalette(): Palette {
  const colours = [CLEAR, DARK_RED, RED];
  return { colours, ramps: buildRamps(colours) };
}

test('rotate90 clockwise swaps dimensions and maps corners', () => {
  const img = createImage(3, 2);
  setPixel(img, 0, 0, RED); // top-left
  const out = rotate90(img, 1);
  assert.equal(out.width, 2);
  assert.equal(out.height, 3);
  assert.deepEqual(getPixel(out, 1, 0), RED, 'top-left goes to top-right under a clockwise turn');
});

test('rotate90 counter-clockwise is the inverse of clockwise', () => {
  const img = createImage(4, 3);
  setPixel(img, 1, 2, RED);
  const roundTrip = rotate90(rotate90(img, 1), -1);
  assert.deepEqual(getPixel(roundTrip, 1, 2), RED);
  assert.equal(roundTrip.width, img.width);
  assert.equal(roundTrip.height, img.height);
});

test('downscale takes the most common opaque colour per cell', () => {
  const img = createImage(4, 2);
  setPixel(img, 0, 0, RED); setPixel(img, 1, 0, RED); setPixel(img, 0, 1, RED);
  setPixel(img, 2, 0, DARK_RED); setPixel(img, 3, 0, DARK_RED); setPixel(img, 2, 1, DARK_RED); setPixel(img, 3, 1, DARK_RED);
  const out = downscale(img, 2, 1);
  assert.deepEqual(getPixel(out, 0, 0), RED, 'left cell is 3/4 red');
  assert.deepEqual(getPixel(out, 1, 0), DARK_RED, 'right cell is all dark red');
});

test('downscale leaves a cell transparent when under half its pixels are opaque', () => {
  const img = createImage(2, 2);
  setPixel(img, 0, 0, RED);
  const out = downscale(img, 1, 1);
  assert.deepEqual(getPixel(out, 0, 0), CLEAR);
});

test('bottomAlign shifts the sprite so its lowest opaque row lands on footBaseline', () => {
  const img = createImage(2, 5);
  setPixel(img, 0, 1, RED);
  const out = bottomAlign(img, 3);
  assert.deepEqual(getPixel(out, 0, 3), RED);
  assert.deepEqual(getPixel(out, 0, 1), CLEAR, 'the source position is empty after the shift');
});

test('bottomAlign on an empty sprite is a no-op', () => {
  const img = createImage(2, 2);
  const out = bottomAlign(img, 1);
  assert.deepEqual([...out.data], [...img.data]);
});

function filledSquare(size: number, colour: Rgba): ReturnType<typeof createImage> {
  const img = createImage(size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) setPixel(img, x, y, colour);
  return img;
}

test('draftVariant child shrinks and re-centres the sprite, then snaps and outlines', () => {
  const src = filledSquare(8, RED);
  const palette = makePalette();
  const out = draftVariant(src, 'child', palette, { childRatio: 0.5, footBaseline: 7 });
  assert.equal(out.width, 8);
  assert.equal(out.height, 8);
  assert.deepEqual(getPixel(out, 0, 0), CLEAR, 'corners outside the shrunk body stay empty');
  assert.deepEqual(getPixel(out, 4, 7), RED, 'the shrunk body sits on the shared foot baseline');
});

test('draftVariant corpse rotates onto its side and is one ramp step darker', () => {
  const src = createImage(4, 4);
  setPixel(src, 1, 0, RED);
  const palette = makePalette();
  const out = draftVariant(src, 'corpse', palette, { footBaseline: 3 });
  let sawDark = false;
  for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) if (getPixel(out, x, y)[3] !== 0 && getPixel(out, x, y).slice(0, 3).join() === DARK_RED.slice(0, 3).join()) sawDark = true;
  assert.ok(sawDark, 'the rotated body is darkened by one ramp step');
});

test('draftVariant ghost remaps every opaque pixel onto the palette\'s coolest ramp', () => {
  const blue: Rgba = [30, 30, 220, 255];
  const paleBlue: Rgba = [180, 180, 255, 255];
  const palette: Palette = { colours: [CLEAR, blue, paleBlue], ramps: buildRamps([CLEAR, blue, paleBlue]) };
  const src = filledSquare(2, RED);
  const out = draftVariant(src, 'ghost', palette);
  const c = getPixel(out, 0, 0);
  assert.ok(c[2] > c[0], 'ghosted pixel favours the cool (blue) ramp over the original red');
});

test('draftVariant animated pulls colour toward green-grey and darkens, without erasing the shape', () => {
  const src = filledSquare(2, RED);
  const palette = makePalette();
  const out = draftVariant(src, 'animated', palette);
  assert.notDeepEqual(getPixel(out, 0, 0), CLEAR);
});

test('draftPlan chains corpse and child recipes off a drawn DEFAULT, and skips already-drawn keys', () => {
  const t = templateById('simple-creature')!;
  const drawn = new Set(['DEFAULT']);
  const plan = draftPlan(t, drawn);
  const byKey = new Map(plan.map(s => [s.key, s]));
  assert.deepEqual(byKey.get('ANIMATED'), { key: 'ANIMATED', from: 'DEFAULT', kinds: ['animated'] });
  assert.deepEqual(byKey.get('CORPSE'), { key: 'CORPSE', from: 'DEFAULT', kinds: ['corpse'] });
  assert.deepEqual(byKey.get('CHILD_DEFAULT'), { key: 'CHILD_DEFAULT', from: 'DEFAULT', kinds: ['child'] });
  assert.deepEqual(byKey.get('CHILD_CORPSE'), { key: 'CHILD_CORPSE', from: 'DEFAULT', kinds: ['child', 'corpse'] });
  assert.equal(byKey.has('DEFAULT'), false, 'a key that is already drawn is never planned');
});

test('draftPlan prefers a drawn CORPSE over drafting one for CHILD_CORPSE', () => {
  const t = templateById('simple-creature')!;
  const drawn = new Set(['DEFAULT', 'CORPSE']);
  const plan = draftPlan(t, drawn);
  const childCorpse = plan.find(s => s.key === 'CHILD_CORPSE');
  assert.deepEqual(childCorpse, { key: 'CHILD_CORPSE', from: 'CORPSE', kinds: ['child'] });
});
