import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createImage, setPixel } from '../src/engine/image/index.ts';
import { buildRamps, nearest, offPalette, rampStep, snapToPalette } from '../src/engine/palette/index.ts';
import type { Palette } from '../src/engine/palette/index.ts';

const CLEAR: [number, number, number, number] = [0, 0, 0, 0];
const BLACK: [number, number, number, number] = [0, 0, 0, 255];
const DARK_RED: [number, number, number, number] = [120, 0, 0, 255];
const RED: [number, number, number, number] = [220, 20, 20, 255];
const BLUE: [number, number, number, number] = [20, 20, 220, 255];

function makePalette(): Palette {
  const colours = [CLEAR, BLACK, DARK_RED, RED, BLUE];
  return { colours, ramps: buildRamps(colours) };
}

test('nearest matches the closest opaque colour, transparent goes to the palette\'s transparent entry', () => {
  const palette = makePalette();
  assert.deepEqual(nearest(palette, [200, 10, 10, 255]), RED);
  assert.deepEqual(nearest(palette, [0, 0, 0, 0]), CLEAR);
  assert.deepEqual(nearest(palette, [10, 10, 10, 0]), CLEAR, 'any alpha-0 input snaps to transparent');
});

test('snapToPalette rewrites every pixel to its nearest palette colour', () => {
  const palette = makePalette();
  const img = createImage(2, 1);
  setPixel(img, 0, 0, [210, 15, 15, 255]);
  setPixel(img, 1, 0, [30, 30, 200, 255]);
  const snapped = snapToPalette(img, palette);
  assert.deepEqual([...snapped.data.slice(0, 4)], RED);
  assert.deepEqual([...snapped.data.slice(4, 8)], BLUE);
  assert.deepEqual([...img.data.slice(0, 4)], [210, 15, 15, 255], 'snapToPalette does not mutate the input');
});

test('offPalette lists only pixels that are not an exact palette entry', () => {
  const palette = makePalette();
  const img = createImage(2, 1);
  setPixel(img, 0, 0, RED);
  setPixel(img, 1, 0, [1, 2, 3, 255]);
  const off = offPalette(img, palette);
  assert.equal(off.length, 1);
  assert.deepEqual(off[0], { x: 1, y: 0, colour: [1, 2, 3, 255] });
});

test('buildRamps groups same-hue colours and orders each ramp darkest to lightest', () => {
  const palette = makePalette();
  const reds = palette.ramps.find(r => r.includes(palette.colours.indexOf(DARK_RED)));
  assert.ok(reds, 'dark red should be in some ramp');
  assert.deepEqual(reds!.map(i => palette.colours[i]), [DARK_RED, RED], 'darkest to lightest');
});

test('rampStep moves one shade lighter or darker, and clamps at the ends', () => {
  const palette = makePalette();
  assert.deepEqual(rampStep(palette, DARK_RED, 1), RED);
  assert.deepEqual(rampStep(palette, RED, -1), DARK_RED);
  assert.deepEqual(rampStep(palette, RED, 1), RED, 'already lightest in its ramp');
  assert.deepEqual(rampStep(palette, BLUE, -1), BLUE, 'a ramp with one colour has nowhere to go');
});

test('rampStep leaves an unknown colour unchanged', () => {
  const palette = makePalette();
  const unknown: [number, number, number, number] = [9, 9, 9, 255];
  assert.deepEqual(rampStep(palette, unknown, 1), unknown);
});
