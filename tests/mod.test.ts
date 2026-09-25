import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RawDocument, createImage, decodeBytes, infoTxt, modFiles, numericVersion, packSheet, parseInfoTxt, readMod, setPixel, spriteRects,
} from '../src/engine/index.ts';
import type { ModCreature, ModFile, ModProject, RgbaImage } from '../src/engine/index.ts';

// A sprite with a few seeded opaque pixels, so every sprite is distinct.
function sprite(w: number, h: number, seed: number): RgbaImage {
  const img = createImage(w * 32, h * 32);
  for (let i = 0; i < 20; i++) {
    const n = (seed * 97 + i * 31) % (img.width * img.height);
    setPixel(img, n % img.width, Math.floor(n / img.width), [seed % 256, i * 10, 200, 255]);
  }
  return img;
}

const CREATURES: ModCreature[] = [
  { id: 'GOBBO', templateId: 'simple-creature', include: [], omit: [], sprites: { DEFAULT: sprite(1, 1, 1), CHILD_DEFAULT: sprite(1, 1, 2), CORPSE: sprite(1, 1, 3) } },
  { id: 'BIG_THING', templateId: 'multi-tile-creature', include: [], omit: ['CORPSE'], sprites: { DEFAULT: sprite(3, 2, 4), CHILD_DEFAULT: sprite(1, 1, 5) } },
  { id: 'BUGLET', templateId: 'vermin', include: ['VERMIN_ALT'], omit: [], sprites: { VERMIN: sprite(1, 1, 6), VERMIN_ALT: sprite(1, 1, 7) } },
  { id: 'GOBBO', caste: 'FEMALE', templateId: 'simple-creature', include: [], omit: [], sprites: { DEFAULT: sprite(1, 1, 8) } },
  { id: 'GOBBO', templateId: 'statue', include: [], omit: [], sprites: { DEFAULT: sprite(1, 2, 9) } },
];

const PROJECT: ModProject = {
  mod: { id: 'Test Mod', name: 'Test: [mod]', version: '1.2.3', author: 'Me', description: 'Line one\nline two' },
  palette: { colours: [[0, 0, 0, 0], [10, 20, 30, 255]], ramps: [[1]] },
  paletteLocked: true,
  customColours: [],
  creatures: CREATURES,
};

const sameImage = (a: RgbaImage | undefined, b: RgbaImage | undefined) =>
  assert.deepEqual(a && [a.width, a.height, Array.from(a.data)], b && [b.width, b.height, Array.from(b.data)]);

function checkCreatures(got: ModCreature[], want: ModCreature[]) {
  assert.equal(got.length, want.length);
  got.forEach((g, i) => {
    const w = want[i];
    assert.deepEqual([g.id, g.caste, g.templateId], [w.id, w.caste, w.templateId]);
    assert.deepEqual(Object.keys(g.sprites).sort(), Object.keys(w.sprites).sort(), `${w.id} sprite keys`);
    for (const k of Object.keys(w.sprites)) sameImage(g.sprites[k], w.sprites[k]);
  });
}

test('mod file set: paths, info.txt, raw header and page', () => {
  const files = modFiles(PROJECT);
  assert.deepEqual(files.map(f => f.path), [
    'info.txt', 'preview.png', 'studio.json', 'graphics/graphics_test_mod_creatures.txt', 'graphics/images/test_mod_creatures.png',
  ]);
  const raw = RawDocument.fromBytes(files[3].bytes!);
  assert.equal(raw.header, 'graphics_test_mod_creatures');
  assert.equal(raw.objectType(), 'GRAPHICS');
  assert.equal(RawDocument.parse(raw.toString()).toString(), raw.toString());
  const [page] = raw.tilePages();
  assert.equal(page.id, 'TEST_MOD_CREATURES');
  assert.equal(page.file, 'images/test_mod_creatures.png');
  const sheet = files[4].image!;
  assert.deepEqual(page.pageDimPixels, [sheet.width, sheet.height]);
  // Only drawn entries are written: GOBBO has DEFAULT, CHILD, CORPSE.
  const gobbo = spriteRects(raw, 'GOBBO').filter(r => !r.caste && r.rect.h === 32);
  assert.equal(gobbo.length, 3);
  assert.ok(raw.toString().includes('[STATUE_CREATURE_GRAPHICS:GOBBO]'));
  assert.ok(raw.toString().includes('[CREATURE_CASTE_GRAPHICS:GOBBO:FEMALE]'));
});

test('studio.json round trip reconstructs the project', () => {
  const back = readMod(modFiles(PROJECT));
  assert.deepEqual(back.warnings, []);
  assert.deepEqual(back.mod, PROJECT.mod);
  assert.deepEqual(back.palette, PROJECT.palette);
  assert.equal(back.paletteLocked, true);
  checkCreatures(back.creatures, CREATURES);
  back.creatures.forEach((c, i) => assert.deepEqual([c.include, c.omit], [CREATURES[i].include, CREATURES[i].omit]));
});

test('without studio.json, creatures are rebuilt from the raws', () => {
  const files: ModFile[] = modFiles(PROJECT).filter(f => f.path !== 'studio.json');
  const back = readMod(files);
  assert.deepEqual(back.warnings, []);
  assert.equal(back.mod.id, 'test_mod');
  checkCreatures(back.creatures, CREATURES);
  assert.deepEqual(back.creatures[2].include, ['VERMIN_ALT']);
});

test('blocks no template describes are skipped with a warning', () => {
  const raw = 'graphics_x\n\n[OBJECT:GRAPHICS]\n\n[CREATURE_GRAPHICS:ODD]\n\t[DEFAULT:P:0:0:AS_IS:WEIRD]\n';
  const back = readMod([{ path: 'graphics/graphics_x.txt', bytes: new TextEncoder().encode(raw) }]);
  assert.equal(back.creatures.length, 0);
  assert.match(back.warnings[0], /ODD.*no template/);
});

test('info.txt: sanitised tokens, numeric version, parses back', () => {
  const txt = infoTxt(PROJECT.mod);
  assert.ok(!/\[[^\]]*\[/.test(txt));
  const info = parseInfoTxt(decodeBytes(new TextEncoder().encode(txt)));
  assert.deepEqual(info, { id: 'test_mod', name: 'Test - mod', version: '1.2.3', author: 'Me', description: 'Line one line two' });
  assert.equal(numericVersion('1.2.3'), 10203);
  assert.equal(numericVersion('7'), 7);
  assert.equal(numericVersion('beta'), 1);
});

test('packer stacks template footprints and keeps layout independent of drawn sprites', () => {
  const a = packSheet(CREATURES);
  const b = packSheet(CREATURES.map(c => ({ ...c, sprites: {} })));
  assert.deepEqual(a.origins, b.origins);
  assert.deepEqual(a.origins, [[0, 0], [0, 1], [0, 3], [0, 5], [0, 6]]);
  assert.deepEqual(a.tiles, [8, 8]);
});
