import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RawDocument, decodeBytes, encodeString } from '../src/engine/index.ts';

const CRLF = 'tile_page_x\r\n\r\n[OBJECT:TILE_PAGE]\r\n\r\n[TILE_PAGE:A] comment\r\n\t[FILE:images/a.png]\r\n\t[TILE_DIM:32:32]\r\n';

test('bytes 0-255 round-trip', () => {
  const b = new Uint8Array(256).map((_, i) => i);
  assert.deepEqual(encodeString(decodeBytes(b)), b);
});

test('odd input survives: stray brackets, unclosed token, no trailing newline', () => {
  const s = 'x\n] [A:B [C:D]\n[E:[F]] [ :: ][G';
  assert.equal(RawDocument.parse(s).toString(), s);
});

test('changing one argument changes only that token', () => {
  const doc = RawDocument.parse(CRLF);
  doc.tilePages()[0].tileDim = [16, 16];
  assert.equal(doc.toString(), CRLF.replace('[TILE_DIM:32:32]', '[TILE_DIM:16:16]'));
});

test('added child uses file line endings and sibling indent', () => {
  const doc = RawDocument.parse(CRLF);
  doc.tilePages()[0].pageDimPixels = [64, 32];
  assert.equal(doc.toString(), CRLF + '\t[PAGE_DIM_PIXELS:64:32]\r\n');
});

test('insert after a token keeps its trailing comment on its line', () => {
  const doc = RawDocument.parse(CRLF);
  const page = doc.tilePages()[0];
  doc.insertAfter(page.block.header, ['X'], '\t');
  assert.equal(doc.toString(), CRLF.replace('comment\r\n', 'comment\r\n\t[X]\r\n'));
});

test('removing a token alone on its line removes the line', () => {
  const doc = RawDocument.parse(CRLF);
  doc.remove(doc.tilePages()[0].block.children[0]);
  assert.equal(doc.toString(), CRLF.replace('\t[FILE:images/a.png]\r\n', ''));
});

test('appendBlock adds a blank-line-separated block', () => {
  const doc = RawDocument.parse('graphics_x\n\n[OBJECT:GRAPHICS]\n');
  doc.appendBlock(['CREATURE_GRAPHICS', 'CAT'], [['DEFAULT', 'P', '0', '0', 'AS_IS']]);
  assert.equal(doc.toString(), 'graphics_x\n\n[OBJECT:GRAPHICS]\n\n[CREATURE_GRAPHICS:CAT]\n\t[DEFAULT:P:0:0:AS_IS]\n');
  const cg = doc.creatureGraphics()[0];
  assert.equal(cg.creatureId, 'CAT');
  assert.equal(cg.entries.length, 1);
});

test("quoted character arguments may be brackets or colons", () => {
  const s = "x\n[ASCII_GRAPHICS:'[':5:0]\n[A:':':']']\n[NAME:giant's:b]\n";
  const doc = RawDocument.parse(s);
  assert.deepEqual(doc.tokens().map(t => t.args), [["ASCII_GRAPHICS", "'['", '5', '0'], ['A', "':'", "']'"], ['NAME', "giant's", 'b']]);
  assert.equal(doc.toString(), s);
});
