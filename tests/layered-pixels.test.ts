import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RawDocument, addPaletteRow, buildPageImages, composite, createImage, defaultFigure, getPixel, paletteRow, readLayered, readTile, renderComposite, setPixel, swapPalette, tileRect, writeTile } from '../src/engine/index.ts';
import type { Rgba } from '../src/engine/index.ts';

const RED: Rgba = [255, 0, 0, 255], BLUE: Rgba = [0, 0, 255, 255], GREEN: Rgba = [0, 255, 0, 255];

function pageFor(file: string) {
  const doc = RawDocument.fromBytes(new TextEncoder().encode(`g\n\n[OBJECT:TILE_PAGE]\n\n[TILE_PAGE:P]\n\t[FILE:${file}]\n\t[TILE_DIM:2:2]\n\t[PAGE_DIM_PIXELS:8:8]\n`));
  return doc.tilePages();
}

test('page map, tile rect read and write-back', () => {
  const sheet = createImage(8, 8);
  setPixel(sheet, 2, 2, RED);
  const pages = buildPageImages(pageFor('images/p.png'), f => (f === 'images/p.png' ? sheet : undefined));
  const ref = { page: 'P', rect: [1, 1, 1, 1] as [number, number, number, number], large: false };
  assert.deepEqual(tileRect(ref, [2, 2]), { x: 2, y: 2, w: 2, h: 2 });
  assert.deepEqual(getPixel(readTile(pages, ref)!, 0, 0), RED);
  const t = createImage(2, 2);
  setPixel(t, 1, 1, BLUE);
  assert.ok(writeTile(pages, ref, t));
  assert.deepEqual(getPixel(sheet, 3, 3), BLUE);
  assert.deepEqual(getPixel(sheet, 2, 2), [0, 0, 0, 0]);
  assert.ok(!writeTile(pages, ref, createImage(3, 3)));
  const large = { page: 'P', rect: [0, 0, 1, 1] as [number, number, number, number], large: true };
  assert.equal(readTile(pages, large)!.width, 4);
  assert.equal(readTile(pages, { ...ref, page: 'X' }), undefined);
});

test('palette row read and swap', () => {
  const pal = createImage(2, 2);
  setPixel(pal, 0, 0, RED); setPixel(pal, 1, 0, BLUE);
  setPixel(pal, 0, 1, GREEN); setPixel(pal, 1, 1, RED);
  assert.deepEqual(paletteRow(pal, 1), [GREEN, RED]);
  assert.equal(paletteRow(pal, 2), undefined);
  const img = createImage(2, 1);
  setPixel(img, 0, 0, RED); setPixel(img, 1, 0, BLUE);
  const out = swapPalette(img, paletteRow(pal, 0)!, paletteRow(pal, 1)!);
  assert.deepEqual([getPixel(out, 0, 0), getPixel(out, 1, 0)], [GREEN, RED]);
  assert.deepEqual(getPixel(img, 0, 0), RED);
});

test('addPaletteRow grows the palette PNG by one row without touching the rest', () => {
  const pal = createImage(2, 2);
  setPixel(pal, 0, 0, RED); setPixel(pal, 1, 0, BLUE);
  setPixel(pal, 0, 1, GREEN); setPixel(pal, 1, 1, RED);
  const { image, row } = addPaletteRow(pal, [BLUE, GREEN]);
  assert.equal(row, 2);
  assert.equal(image.height, 3);
  assert.equal(image.width, 2);
  assert.deepEqual(paletteRow(image, 0), [RED, BLUE]);
  assert.deepEqual(paletteRow(image, 1), [GREEN, RED]);
  assert.deepEqual(paletteRow(image, 2), [BLUE, GREEN]);
  assert.deepEqual(getPixel(pal, 0, 0), RED); // original image untouched
  assert.equal(pal.height, 2);
  // Fewer colours than the palette is wide leaves the rest of the row blank.
  const { image: short } = addPaletteRow(pal, [RED]);
  assert.deepEqual(paletteRow(short, 2), [RED, [0, 0, 0, 0]]);
});

test('renderComposite draws the dwarf fixture with page images and palette swap', () => {
  const doc = RawDocument.fromBytes(readFileSync(new URL('./fixtures/graphics_creatures_dwarf.txt', import.meta.url)));
  const lg = readLayered(doc, doc.creatureGraphics()[0].block);
  const c = composite(lg, defaultFigure({ caste: 'MALE', professionCategory: 'STANDARD', tissues: [{ part: 'HEAD', tissue: 'SKIN', color: 'BROWN' }] }));
  const sheet = createImage(64, 64);
  for (let i = 0; i < 64 * 64; i++) setPixel(sheet, i % 64, Math.floor(i / 64), RED);
  const pages = new Map([['DWARF_BODY', { tile: [32, 32] as [number, number], image: sheet }]]);
  const empty = renderComposite(c, new Map(), new Map());
  assert.ok(empty.notes.some(n => n.includes('has no image')));
  const r = renderComposite(c, pages, new Map());
  assert.ok(r.image.width >= 32 && r.image.height >= 32);
  assert.deepEqual(getPixel(r.image, r.origin[0] + 1, r.origin[1] + 1), RED);
  const ls = c.set!.palettes.find(p => p.file)!;
  const pal = createImage(1, 20);
  for (let y = 0; y < 20; y++) setPixel(pal, 0, y, y === ls.defaultRow ? RED : BLUE);
  const r2 = renderComposite(c, pages, new Map([[ls.file!, pal]]));
  assert.ok(r2.image.data.length > 0);
});
