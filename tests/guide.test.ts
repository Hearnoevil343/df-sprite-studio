import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proportionGuide } from '../src/engine/index.ts';
import type { StatGroup, VanillaStats } from '../src/engine/index.ts';

function group(overrides: Partial<StatGroup> = {}): StatGroup {
  return {
    sprites: 100,
    bbox: { x: 4, y: 6, w: 24, h: 22 },
    footBaseline: 28,
    headFound: 0.5,
    headSide: { top: 40, left: 5, right: 5 },
    bySide: { top: { head: { x: 5, y: 5, w: 20, h: 10 }, body: { x: 6, y: 16, w: 18, h: 12 } } },
    band: { x0: [2, 6], y0: [4, 8], x1: [26, 30], y1: [26, 30], footBaseline: [26, 30] },
    ...overrides,
  };
}

const STATS: VanillaStats = {
  proportions: {
    all: group({ sprites: 2000 }),
    byToken: { CHILD: group({ sprites: 50, headSide: { left: 10, right: 10 }, bbox: { x: 8, y: 12, w: 16, h: 16 } }) },
    byPage: { CREATURES_DOMESTIC: group({ sprites: 30 }) },
    byPageToken: { 'CREATURES_DOMESTIC|CHILD': group({ sprites: 25, headSide: { top: 20 } }) },
  },
};

test('proportionGuide prefers the page x token group when it has enough sprites', () => {
  const g = proportionGuide(STATS, { page: 'CREATURES_DOMESTIC', token: 'CHILD' });
  assert.equal(g.sprites, 25);
  assert.ok(g.head, 'all-top headSide should get a head box');
});

test('proportionGuide falls back to token, then page, then all when a group is too thin', () => {
  assert.equal(proportionGuide(STATS, { page: 'NOPE', token: 'CHILD' }).sprites, 50);
  assert.equal(proportionGuide(STATS, { page: 'CREATURES_DOMESTIC' }).sprites, 30);
  assert.equal(proportionGuide(STATS, { page: 'NOPE', token: 'NOPE' }).sprites, 2000);
  assert.equal(proportionGuide(STATS).sprites, 2000);
});

test('proportionGuide omits the head box unless most found heads are on top', () => {
  const sideOn = proportionGuide(STATS, { token: 'CHILD' });
  assert.equal(sideOn.head, undefined, 'CHILD group has no top heads, so no head box');
  const topHeavy = proportionGuide(STATS);
  assert.deepEqual(topHeavy.head, { x: 5, y: 5, w: 20, h: 10 });
});
