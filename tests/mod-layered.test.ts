// Exporting a layered creature. Unlike a template ModCreature
// (packSheet + a freshly generated raw file), a layered creature's own
// RawDocument and page images are carried through from readMod, so exporting
// it is "serialize the doc back, and ship whichever page images actually
// changed" -- these three helpers, plus addLayer (tested in layers.test.ts)
// and addPaletteRow (layered-pixels.test.ts), are that path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addLayer, changedPageFiles, cloneImage, createImage, layeredPageFilePaths, layeredRawFiles, readMod, setPixel, writeTile,
} from '../src/engine/index.ts';
import type { PageImages } from '../src/engine/index.ts';

const bytes = (s: string) => new TextEncoder().encode(s);

const GRAPHICS = `graphics_layered_c

[OBJECT:GRAPHICS]

[TILE_PAGE:LP]
\t[FILE:images/lp.png]
\t[TILE_DIM:2:2]
\t[PAGE_DIM_PIXELS:4:2]

[CREATURE_GRAPHICS:LC]
\t[LAYER_SET:DEFAULT]
\tbody
\t[LAYER_GROUP]
\t\t[LAYER:BODY:LP:0:0]
\t[END_LAYER_GROUP]
`;

test('layeredRawFiles serializes each distinct source doc; untouched files stay byte-identical', () => {
  const r = readMod([{ path: 'graphics/graphics_layered_c.txt', bytes: bytes(GRAPHICS) }]);
  assert.equal(r.layered.length, 1);
  const out = layeredRawFiles(r.layered);
  assert.equal(out.length, 1);
  assert.equal(out[0].path, 'graphics/graphics_layered_c.txt');
  assert.deepEqual(out[0].bytes, bytes(GRAPHICS));
});

test('layeredRawFiles reflects an addLayer edit, and only serializes the one doc it happened on', () => {
  const r = readMod([{ path: 'graphics/graphics_layered_c.txt', bytes: bytes(GRAPHICS) }]);
  const lc = r.layered[0];
  const group = lc.graphics.sets[0].groups[0];
  addLayer(lc.graphics.doc, group, 'BODY2', { page: 'LP', rect: [1, 0, 1, 0], large: false }, group.layers[0]);
  const out = layeredRawFiles(r.layered);
  assert.equal(out.length, 1);
  assert.notDeepEqual(out[0].bytes, bytes(GRAPHICS));
  assert.ok(new TextDecoder().decode(out[0].bytes).includes('BODY2'));
});

test('layeredPageFilePaths resolves each page id to its mod-relative FILE path', () => {
  const r = readMod([{ path: 'graphics/graphics_layered_c.txt', bytes: bytes(GRAPHICS) }]);
  const paths = layeredPageFilePaths(r.layered);
  assert.deepEqual([...paths], [['LP', 'graphics/images/lp.png']]);
});

test('changedPageFiles only lists pages whose pixels actually changed', () => {
  const r = readMod([{ path: 'graphics/graphics_layered_c.txt', bytes: bytes(GRAPHICS) }]);
  const paths = layeredPageFilePaths(r.layered);
  const page = createImage(4, 2);
  setPixel(page, 0, 0, [10, 20, 30, 255]);
  const pages: PageImages = new Map([['LP', { tile: [2, 2] as [number, number], image: page }]]);
  const originals: PageImages = new Map([['LP', { tile: [2, 2] as [number, number], image: cloneImage(page) }]]);
  assert.deepEqual(changedPageFiles(pages, originals, paths), []);

  const edit = createImage(2, 2);
  setPixel(edit, 0, 0, [1, 2, 3, 255]);
  assert.ok(writeTile(pages, { page: 'LP', rect: [1, 0, 1, 0], large: false }, edit));
  const out = changedPageFiles(pages, originals, paths);
  assert.equal(out.length, 1);
  assert.equal(out[0].path, 'graphics/images/lp.png');
  assert.equal(out[0].image, pages.get('LP')!.image);

  // A page with no FILE path resolved (not part of any layered creature here) is skipped.
  pages.set('OTHER', { tile: [2, 2], image: createImage(2, 2) });
  assert.equal(changedPageFiles(pages, originals, paths).length, 1);
});
