import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildRamps, checkSprite, createImage, edgePixels, offPalette, setPixel, strayPixels, styleMetrics,
} from '../src/engine/index.ts';
import type { FloorBand, Palette, ProportionGuide, Rgba, VanillaStyle } from '../src/engine/index.ts';

const RED: Rgba = [220, 20, 20, 255];
const BLUE: Rgba = [20, 20, 220, 255];
const WHITE: Rgba = [255, 255, 255, 255];
const GREEN: Rgba = [40, 160, 40, 255];
const CLEAR: Rgba = [0, 0, 0, 0];

function makePalette(colours: Rgba[]): Palette {
  return { colours, ramps: buildRamps(colours) };
}

// Loose bands that no test sprite trips unless a test targets that rule.
function looseStyle(overrides: Partial<VanillaStyle['byToken']['ALL']> = {}): VanillaStyle {
  return { byToken: { ALL: { sprites: 20, colourCount: [0, 100], outlineLightShare: [0, 1], footBaseline: [0, 100], ...overrides } }, floors: [] };
}

test('edgePixels finds only opaque pixels touching a transparent or off-canvas neighbour', () => {
  const img = createImage(3, 3);
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) setPixel(img, x, y, RED);
  const edges = edgePixels(img);
  assert.equal(edges.length, 8, 'every pixel but the centre touches the canvas edge or nothing else opaque');
  assert.ok(!edges.some(e => e.x === 1 && e.y === 1));
});

test('strayPixels leaves a solid shape alone', () => {
  const img = createImage(3, 3);
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) setPixel(img, x, y, RED);
  assert.deepEqual(strayPixels(img), []);
});

test('strayPixels flags a small island away from the main body', () => {
  const img = createImage(5, 5);
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) setPixel(img, x, y, RED); // 4-pixel main body
  setPixel(img, 4, 4, RED); // isolated single pixel
  const stray = strayPixels(img);
  assert.deepEqual(stray, [{ x: 4, y: 4 }]);
});

test('styleMetrics reports blank for a fully transparent image', () => {
  const img = createImage(2, 2);
  assert.deepEqual(styleMetrics(img), { blank: true, colourCount: 0, edges: [], outlineLightShare: 0, footBaseline: null });
});

test('checkSprite: blank rule short-circuits every other rule', () => {
  const img = createImage(2, 2);
  const issues = checkSprite(img, { token: 'DEFAULT', palette: makePalette([CLEAR, RED]), style: looseStyle() });
  assert.deepEqual(issues, [{ rule: 'blank', severity: 'warn', message: 'Drawn but fully transparent.' }]);
});

test('checkSprite: palette rule is a warn unlocked, an error locked', () => {
  const img = createImage(1, 1);
  setPixel(img, 0, 0, [1, 2, 3, 255]);
  const palette = makePalette([CLEAR, RED]);
  const warn = checkSprite(img, { token: 'DEFAULT', palette });
  assert.equal(warn.find(i => i.rule === 'palette')?.severity, 'warn');
  const error = checkSprite(img, { token: 'DEFAULT', palette, locked: true });
  assert.equal(error.find(i => i.rule === 'palette')?.severity, 'error');
  assert.deepEqual(offPalette(img, palette).map(p => ({ x: p.x, y: p.y })), warn.find(i => i.rule === 'palette')?.pixels);
});

test('checkSprite: alpha rule flags any pixel with partial transparency', () => {
  const img = createImage(2, 1);
  setPixel(img, 0, 0, RED);
  setPixel(img, 1, 0, [220, 20, 20, 100]);
  const issues = checkSprite(img, { token: 'DEFAULT' });
  const alpha = issues.find(i => i.rule === 'alpha');
  assert.equal(alpha?.severity, 'error');
  assert.deepEqual(alpha?.pixels, [{ x: 1, y: 0 }]);
});

test('checkSprite: stray rule reports the stray pixels', () => {
  const img = createImage(5, 5);
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) setPixel(img, x, y, RED);
  setPixel(img, 4, 4, RED);
  const issues = checkSprite(img, { token: 'DEFAULT' });
  assert.deepEqual(issues.find(i => i.rule === 'stray')?.pixels, [{ x: 4, y: 4 }]);
});

test('checkSprite: colour-count warns only above the vanilla band', () => {
  const img = createImage(3, 1);
  setPixel(img, 0, 0, RED); setPixel(img, 1, 0, BLUE); setPixel(img, 2, 0, WHITE);
  const tight = checkSprite(img, { token: 'DEFAULT', style: looseStyle({ colourCount: [0, 2] }) });
  assert.ok(tight.some(i => i.rule === 'colour-count'));
  const loose = checkSprite(img, { token: 'DEFAULT', style: looseStyle({ colourCount: [0, 10] }) });
  assert.ok(!loose.some(i => i.rule === 'colour-count'));
});

test('checkSprite: outline warns when more of the edge reads light than vanilla usually does', () => {
  const img = createImage(1, 1);
  setPixel(img, 0, 0, WHITE);
  const tight = checkSprite(img, { token: 'DEFAULT', style: looseStyle({ outlineLightShare: [0, 0.1] }) });
  const outline = tight.find(i => i.rule === 'outline');
  assert.equal(outline?.severity, 'warn');
  assert.deepEqual(outline?.pixels, [{ x: 0, y: 0 }]);
});

test('checkSprite: baseline warns when the foot row falls outside the vanilla band', () => {
  const img = createImage(2, 8);
  setPixel(img, 0, 6, RED); // footBaseline = 6
  const outside = checkSprite(img, { token: 'DEFAULT', style: looseStyle({ footBaseline: [0, 3] }) });
  assert.ok(outside.some(i => i.rule === 'baseline'));
  const inside = checkSprite(img, { token: 'DEFAULT', style: looseStyle({ footBaseline: [0, 6] }) });
  assert.ok(!inside.some(i => i.rule === 'baseline'));
});

test('checkSprite: a token with too few vanilla sprites falls back to the ALL band, or is skipped entirely', () => {
  const img = createImage(2, 8);
  setPixel(img, 0, 6, RED);
  const style: VanillaStyle = {
    byToken: { RARE: { sprites: 2, colourCount: [0, 0], outlineLightShare: [0, 0], footBaseline: [0, 0] } },
    floors: [],
  };
  assert.deepEqual(checkSprite(img, { token: 'RARE', style }).filter(i => i.rule === 'baseline'), [], 'no ALL band to fall back to, so the rule is skipped rather than firing on a near-empty sample');
});

test('checkSprite: floor-contrast warns when the outline blends into the floor colours', () => {
  const img = createImage(3, 3);
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) setPixel(img, x, y, GREEN);
  const floor: FloorBand = { id: 'grass', label: 'Grass', colours: [GREEN], distanceThreshold: 0.05, closeShare: [0, 0.1] };
  const issues = checkSprite(img, { token: 'DEFAULT', floors: [floor] });
  const contrast = issues.find(i => i.rule === 'floor-contrast');
  assert.equal(contrast?.severity, 'warn');
  assert.equal(contrast?.pixels?.length, 8, 'every edge pixel matches the floor colour exactly');
});

test('checkSprite: proportions is info-only and only runs when a guide is supplied', () => {
  const img = createImage(4, 4);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) setPixel(img, x, y, RED);
  const guide: ProportionGuide = { bbox: { x: 0, y: 0, w: 4, h: 4 }, band: { x0: [0, 0], y0: [0, 0], x1: [4, 4], y1: [4, 4], footBaseline: [3, 3] }, footBaseline: 3, sprites: 40 };
  const withGuide = checkSprite(img, { token: 'DEFAULT', guide });
  assert.equal(withGuide.find(i => i.rule === 'proportions')?.severity, 'info');
  const withoutGuide = checkSprite(img, { token: 'DEFAULT' });
  assert.ok(!withoutGuide.some(i => i.rule === 'proportions'));
});
