import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RawDocument, spriteRects, tileGraphicsRects } from '../src/engine/index.ts';

const RAW = `graphics_x

[OBJECT:GRAPHICS]

[TILE_PAGE:PAGE_A]
\t[FILE:images/a.png]
\t[TILE_DIM:32:32]
\t[PAGE_DIM_PIXELS:320:320]

[CREATURE_GRAPHICS:ALPACA]
\t[DEFAULT:PAGE_A:0:0:AS_IS]
\t[CHILD:PAGE_A:1:0:AS_IS:DEFAULT]
\t[ANIMATED:PAGE_A:LARGE_IMAGE:2:0:3:1:AS_IS]

[CREATURE_CASTE_GRAPHICS:ALPACA:MALE]
\t[DEFAULT:PAGE_A:0:1:AS_IS]

[STATUE_CREATURE_GRAPHICS:ALPACA]
\t[DEFAULT:PAGE_A:0:2:1:3]
`;

test('spriteRects resolves single-tile, LARGE_IMAGE, caste and statue entries to pixel rects', () => {
  const doc = RawDocument.parse(RAW);
  const rects = spriteRects(doc, 'ALPACA');
  assert.deepEqual(rects.find(r => r.token === 'DEFAULT' && !r.caste && r.page === 'PAGE_A')?.rect,
    { x: 0, y: 0, w: 32, h: 32 });
  assert.deepEqual(rects.find(r => r.token === 'CHILD')?.rect, { x: 32, y: 0, w: 32, h: 32 });
  assert.deepEqual(rects.find(r => r.token === 'ANIMATED')?.rect, { x: 64, y: 0, w: 64, h: 64 });
  assert.deepEqual(rects.find(r => r.caste === 'MALE')?.rect, { x: 0, y: 32, w: 32, h: 32 });
  const statue = rects.find(r => r.rect.x === 0 && r.rect.y === 64);
  assert.deepEqual(statue?.rect, { x: 0, y: 64, w: 64, h: 64 });
});

test('spriteRects ignores other creatures and unknown pages fall back to 32x32', () => {
  const doc = RawDocument.parse(RAW.replace('PAGE_A:0:0:AS_IS', 'PAGE_B:5:5:AS_IS'));
  const rects = spriteRects(doc, 'ALPACA');
  const def = rects.find(r => r.token === 'DEFAULT' && r.page === 'PAGE_B');
  assert.deepEqual(def?.rect, { x: 160, y: 160, w: 32, h: 32 });
  assert.equal(spriteRects(doc, 'NOPE').length, 0);
});

test('tileGraphicsRects resolves plain TILE_GRAPHICS entries to pixel rects, matching vanilla graphics_tiles.txt syntax', () => {
  const doc = RawDocument.parse(`graphics_tiles

[OBJECT:GRAPHICS]

[TILE_GRAPHICS:FLOORS:0:0:GRASS_1]
[TILE_GRAPHICS:FLOORS:0:3:STONE_FLOOR_1]
[TILE_GRAPHICS:SNOW:1:4:SPATTER_SNOW:FULL_NSWE_C]
`);
  const floors = tileGraphicsRects(doc, 'FLOORS', [32, 32]);
  assert.deepEqual(floors.find(r => r.name === 'GRASS_1')?.rect, { x: 0, y: 0, w: 32, h: 32 });
  assert.deepEqual(floors.find(r => r.name === 'STONE_FLOOR_1')?.rect, { x: 0, y: 96, w: 32, h: 32 });
  assert.equal(floors.length, 2, 'other pages excluded');
  assert.deepEqual(tileGraphicsRects(doc, 'SNOW', [32, 32]).find(r => r.name === 'SPATTER_SNOW')?.rect,
    { x: 32, y: 128, w: 32, h: 32 }, 'extra trailing args beyond the name are ignored, same as vanilla spatter variants');
  assert.deepEqual(tileGraphicsRects(doc, 'FLOORS')[0].rect, { x: 0, y: 0, w: 32, h: 32 }, 'defaults to 32x32 tiles');
});
