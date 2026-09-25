import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createImage, drawLine, drawRectOutline, fitReference, flip, floodFill, getPixel, lightHints, mirror, outline, resizeAnchored, setPixel, stamp } from '../src/engine/image/index.ts';
import { buildRamps } from '../src/engine/palette/index.ts';
import type { Palette } from '../src/engine/palette/index.ts';

const RED: [number, number, number, number] = [255, 0, 0, 255];
const BLUE: [number, number, number, number] = [0, 0, 255, 255];
const CLEAR: [number, number, number, number] = [0, 0, 0, 0];
const DARK_RED: [number, number, number, number] = [120, 0, 0, 255];
const BLACK: [number, number, number, number] = [0, 0, 0, 255];

test('setPixel / getPixel round-trip', () => {
  const img = createImage(4, 4);
  setPixel(img, 2, 1, RED);
  assert.deepEqual(getPixel(img, 2, 1), RED);
  assert.deepEqual(getPixel(img, 0, 0), CLEAR);
});

test('floodFill fills a connected region and stops at a different colour', () => {
  const img = createImage(4, 4);
  setPixel(img, 2, 0, RED);
  setPixel(img, 2, 1, RED);
  setPixel(img, 2, 2, RED);
  floodFill(img, 0, 0, BLUE);
  assert.deepEqual(getPixel(img, 0, 0), BLUE);
  assert.deepEqual(getPixel(img, 1, 3), BLUE);
  assert.deepEqual(getPixel(img, 2, 0), RED, 'fill must not cross into the red region');
});

test('floodFill on an already-matching pixel is a no-op', () => {
  const img = createImage(3, 3);
  const changed = floodFill(img, 1, 1, CLEAR);
  assert.equal(changed.length, 0);
});

test('mirror x reflects the left half onto the right', () => {
  const img = createImage(4, 2);
  setPixel(img, 0, 0, RED);
  setPixel(img, 1, 1, BLUE);
  mirror(img, 'x');
  assert.deepEqual(getPixel(img, 3, 0), RED);
  assert.deepEqual(getPixel(img, 2, 1), BLUE);
  assert.deepEqual(getPixel(img, 0, 0), RED, 'source half is untouched');
});

test('mirror y reflects the top half onto the bottom', () => {
  const img = createImage(2, 4);
  setPixel(img, 0, 0, RED);
  setPixel(img, 1, 1, BLUE);
  mirror(img, 'y');
  assert.deepEqual(getPixel(img, 0, 3), RED);
  assert.deepEqual(getPixel(img, 1, 2), BLUE);
});

function makeRedPalette(): Palette {
  const colours = [CLEAR, BLACK, DARK_RED, RED];
  return { colours, ramps: buildRamps(colours) };
}

test('outline fills transparent pixels touching the sprite with a ramp-darker shade', () => {
  const img = createImage(3, 1);
  setPixel(img, 1, 0, RED);
  const palette = makeRedPalette();
  const changed = outline(img, palette, 'ramp');
  assert.deepEqual(getPixel(img, 0, 0), DARK_RED);
  assert.deepEqual(getPixel(img, 2, 0), DARK_RED);
  assert.deepEqual(getPixel(img, 1, 0), RED, 'the sprite pixel itself is untouched');
  assert.equal(changed.length, 2);
});

test('outline with a fixed colour ignores the palette', () => {
  const img = createImage(3, 1);
  setPixel(img, 1, 0, RED);
  outline(img, makeRedPalette(), BLACK);
  assert.deepEqual(getPixel(img, 0, 0), BLACK);
  assert.deepEqual(getPixel(img, 2, 0), BLACK);
});

test('outline leaves pixels with no opaque neighbour untouched', () => {
  const img = createImage(3, 1);
  setPixel(img, 1, 0, RED);
  const changed = outline(img, makeRedPalette(), 'ramp');
  assert.equal(changed.length, 2, 'only the two pixels touching the sprite change');
});

test('lightHints classifies silhouette edges by whether they face the light', () => {
  const img = createImage(3, 3);
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) setPixel(img, x, y, RED);
  const hints = lightHints(img, 'top-left');
  const at = (x: number, y: number) => hints.find(h => h.x === x && h.y === y);
  assert.equal(at(0, 0)?.kind, 'lit', 'top-left corner faces a top-left light');
  assert.equal(at(2, 2)?.kind, 'shadow', 'bottom-right corner faces away from a top-left light');
  assert.equal(at(1, 1), undefined, 'the centre pixel has no transparent neighbour, so it is not an edge');
});

test('lightHints has no opinion when a pixel is open on all sides equally', () => {
  const img = createImage(1, 1);
  setPixel(img, 0, 0, RED);
  assert.equal(lightHints(img, 'top').length, 0, 'symmetric opening has no directional bias');
});

test('lightHints classifies a single open side toward the light as lit', () => {
  const img = createImage(2, 1);
  setPixel(img, 0, 0, RED);
  setPixel(img, 1, 0, RED);
  const hints = lightHints(img, 'left');
  assert.deepEqual(hints.find(h => h.x === 0 && h.y === 0)?.kind, 'lit');
  assert.deepEqual(hints.find(h => h.x === 1 && h.y === 0)?.kind, 'shadow');
});

test('fitReference returns the same image when it already matches the target size', () => {
  const img = createImage(32, 32);
  setPixel(img, 0, 0, RED);
  const out = fitReference(img, 32, 32);
  assert.equal(out, img, 'no scaling work when sizes already match');
});

test('fitReference scales a 1x1 reference up to a multi-tile entry, anchored bottom-centre', () => {
  const ref = createImage(32, 32);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) setPixel(ref, x, y, RED);
  const out = fitReference(ref, 96, 64);
  assert.equal(out.width, 96);
  assert.equal(out.height, 64);
  // Square 32x32 scaled to fit 96x64 keeping proportions -> 64x64, centred
  // horizontally (ox = (96-64)/2 = 16) and flush with the bottom (oy = 0).
  assert.deepEqual(getPixel(out, 0, 0), [0, 0, 0, 0], 'left margin stays transparent');
  assert.deepEqual(getPixel(out, 16, 0), RED, 'scaled image starts at the horizontal centre offset');
  assert.deepEqual(getPixel(out, 79, 63), RED, 'scaled image reaches the bottom-right of its 64x64 box');
  assert.deepEqual(getPixel(out, 95, 63), [0, 0, 0, 0], 'right margin stays transparent');
});

test('resizeAnchored returns the same image unchanged when the size already matches', () => {
  const img = createImage(32, 32);
  const { image, clipped } = resizeAnchored(img, 32, 32);
  assert.equal(image, img);
  assert.equal(clipped, false);
});

test('resizeAnchored growing pads with transparency, keeping the sprite bottom-anchored', () => {
  const img = createImage(32, 32);
  setPixel(img, 0, 31, RED); // bottom-left pixel
  const { image, clipped } = resizeAnchored(img, 96, 64);
  assert.equal(clipped, false);
  assert.equal(image.width, 96);
  assert.equal(image.height, 64);
  // dx = floor((96-32)/2) = 32, dy = 64-32 = 32
  assert.deepEqual(getPixel(image, 32, 63), RED, 'original bottom-left pixel lands on the new bottom row');
  assert.deepEqual(getPixel(image, 0, 0), [0, 0, 0, 0], 'new area is transparent');
});

test('resizeAnchored shrinking crops from the top and sides, flagging clipped opaque pixels', () => {
  const img = createImage(32, 32);
  setPixel(img, 16, 31, RED); // bottom-centre, survives a shrink to the same width
  setPixel(img, 0, 0, RED);   // top-left, will be cropped away
  const { image, clipped } = resizeAnchored(img, 32, 16);
  assert.equal(clipped, true, 'the top-left opaque pixel was dropped');
  assert.deepEqual(getPixel(image, 16, 15), RED, 'bottom-centre pixel survives, still on the bottom row');
});

test('resizeAnchored shrinking that drops only transparent pixels is not clipped', () => {
  const img = createImage(32, 32);
  setPixel(img, 16, 31, RED);
  const { clipped } = resizeAnchored(img, 32, 16);
  assert.equal(clipped, false);
});

test('flip x reverses every pixel left to right, unlike mirror which only copies half', () => {
  const img = createImage(3, 2);
  setPixel(img, 0, 0, RED);
  setPixel(img, 2, 1, BLUE);
  const out = flip(img, 'x');
  assert.deepEqual(getPixel(out, 2, 0), RED);
  assert.deepEqual(getPixel(out, 0, 1), BLUE);
  assert.deepEqual(getPixel(img, 0, 0), RED, 'source image is untouched');
});

test('flip y reverses every pixel top to bottom', () => {
  const img = createImage(2, 3);
  setPixel(img, 0, 0, RED);
  setPixel(img, 1, 2, BLUE);
  const out = flip(img, 'y');
  assert.deepEqual(getPixel(out, 0, 2), RED);
  assert.deepEqual(getPixel(out, 1, 0), BLUE);
});

test('drawLine draws a straight horizontal line and stops exactly at the endpoint', () => {
  const img = createImage(5, 5);
  const changed = drawLine(img, 0, 2, 4, 2, RED);
  assert.equal(changed.length, 5);
  for (let x = 0; x < 5; x++) assert.deepEqual(getPixel(img, x, 2), RED);
});

test('drawLine draws a diagonal via Bresenham', () => {
  const img = createImage(4, 4);
  drawLine(img, 0, 0, 3, 3, RED);
  for (let i = 0; i < 4; i++) assert.deepEqual(getPixel(img, i, i), RED);
});

test('drawLine clips points outside the image bounds', () => {
  const img = createImage(3, 3);
  const changed = drawLine(img, -2, 0, 2, 0, RED);
  assert.equal(changed.length, 3, 'only the three in-bounds points are recorded');
  assert.deepEqual(getPixel(img, 0, 0), RED);
});

test('drawRectOutline draws the border only, leaving the interior untouched', () => {
  const img = createImage(5, 5);
  drawRectOutline(img, 1, 1, 3, 3, RED);
  assert.deepEqual(getPixel(img, 1, 1), RED);
  assert.deepEqual(getPixel(img, 3, 3), RED);
  assert.deepEqual(getPixel(img, 2, 1), RED);
  assert.deepEqual(getPixel(img, 2, 2), [0, 0, 0, 0], 'the interior is not filled');
});

test('drawRectOutline accepts corners in either order', () => {
  const img = createImage(5, 5);
  const changed = drawRectOutline(img, 3, 3, 1, 1, RED);
  assert.deepEqual(getPixel(img, 1, 1), RED);
  assert.ok(changed.length > 0);
});

test('stamp pastes a sub-image onto another, overwriting including transparent pixels', () => {
  const dest = createImage(4, 4);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) setPixel(dest, x, y, RED);
  const src = createImage(2, 2);
  setPixel(src, 0, 0, BLUE);
  stamp(dest, 1, 1, src);
  assert.deepEqual(getPixel(dest, 1, 1), BLUE);
  assert.deepEqual(getPixel(dest, 2, 1), CLEAR, 'transparent src pixels overwrite, not compose');
  assert.deepEqual(getPixel(dest, 0, 0), RED, 'pixels outside the pasted rect are untouched');
});

test('stamp clips to the destination bounds', () => {
  const dest = createImage(3, 3);
  const src = createImage(2, 2);
  setPixel(src, 0, 0, RED);
  setPixel(src, 1, 1, BLUE);
  stamp(dest, 2, 2, src);
  assert.deepEqual(getPixel(dest, 2, 2), RED, 'in-bounds corner pastes normally');
});

test('fitReference keeps proportions for a non-square reference and never overflows the target', () => {
  const ref = createImage(16, 32);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 16; x++) setPixel(ref, x, y, RED);
  const out = fitReference(ref, 64, 64);
  assert.equal(out.width, 64);
  assert.equal(out.height, 64);
  // 16x32 scaled by min(64/16, 64/32)=2 -> 32x64, full height, centred.
  assert.deepEqual(getPixel(out, 15, 0), [0, 0, 0, 0]);
  assert.deepEqual(getPixel(out, 16, 0), RED);
  assert.deepEqual(getPixel(out, 47, 63), RED);
  assert.deepEqual(getPixel(out, 48, 63), [0, 0, 0, 0]);
});
