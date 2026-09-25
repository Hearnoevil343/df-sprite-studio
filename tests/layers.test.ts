import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RawDocument, addLayer, layeredTokens, readLayered, readMod, setPaletteDefaultRow } from '../src/engine/index.ts';
import type { LayeredLayer as Layer } from '../src/engine/index.ts';

const bytes = readFileSync(new URL('./fixtures/graphics_creatures_dwarf.txt', import.meta.url));
const dwarf = () => {
  const doc = RawDocument.fromBytes(bytes);
  return { doc, lg: readLayered(doc, doc.creatureGraphics()[0].block) };
};

// The design note counts 19 "groups" in DEFAULT; that is the 19 one-tab headings
// (shadow ... wound). The file has 58 LAYER_GROUP tokens, several per heading, and
// the last heading ("wound") has none. One token = one group, so the model has 58.
test('dwarf block: 3 sets, 58 groups in DEFAULT (19 headings), 925 layers', () => {
  const { lg } = dwarf();
  assert.deepEqual(lg.sets.map(s => [s.stage, s.state]), [['BABY', 'DEFAULT'], ['CHILD', 'DEFAULT'], [undefined, 'DEFAULT']]);
  const def = lg.sets[2];
  assert.equal(def.groups.length, 58);
  assert.equal(def.groups.reduce((n, g) => n + g.layers.length, 0), 925);
  assert.equal(lg.sets.flatMap(s => s.groups).reduce((n, g) => n + g.layers.length, 0), 1438);
  assert.equal(def.groups[0].label, 'shadow');
  const headings = ['shadow', 'cape', 'right arm shield', 'right shoulder', 'right hand', 'right leg', 'right foot', 'left leg', 'left foot',
    'lower body clothes hanging over legs', 'torso', 'left shoulder', 'head', 'hair', 'head clothing', 'beard', 'top head - clothes', 'left hand'];
  const labels = def.groups.map(g => g.label).filter(Boolean);
  assert.deepEqual(labels.filter(l => headings.includes(l!)), headings);
  assert.equal(labels.length, 26);
  assert.deepEqual(lg.simple.map(t => t.args[0]), ['SKELETON_WITH_SKULL', 'SKELETON']);
});

test('every token of the block lands in exactly one place, nothing unknown', () => {
  const { lg } = dwarf();
  const held = layeredTokens(lg);
  assert.equal(held.length, lg.block.children.length);
  assert.equal(new Set(held).size, held.length);
  assert.deepEqual(new Set(held), new Set(lg.block.children));
  const unknown = lg.sets.flatMap(s => [...s.unknown, ...s.palettes.flatMap(p => p.unknown), ...s.groups.flatMap(g => [...g.unknown, ...g.layers.flatMap(l => l.unknown)])]);
  assert.deepEqual(unknown, []);
});

test('building views does not change the file', () => {
  const { doc } = dwarf();
  assert.deepEqual(doc.toBytes(), new Uint8Array(bytes));
});

test('layers, conditions and palettes are read', () => {
  const { lg } = dwarf();
  const baby = lg.sets[0];
  assert.deepEqual(baby.palettes.map(p => [p.name, p.file, p.defaultRow]), [['BODY', 'images/dwarf/dwarf_body_palettes.png', 0]]);
  const z: Layer = baby.groups[1].layers[0];
  assert.equal(z.name, 'Z_BABY');
  assert.deepEqual(z.ref, { page: 'DWARF_BODY', rect: [7, 6, 7, 6], large: false });
  assert.deepEqual(z.palette, { name: 'BODY', row: 6 });
  assert.equal(z.conditions[0].kind, 'CONDITION_SYN_CLASS');
  const all = lg.sets.flatMap(s => s.groups.flatMap(g => g.layers));
  const tissue = all.flatMap(l => l.conditions).find(c => c.kind === 'CONDITION_TISSUE_LAYER' && c.children.length)!;
  assert.ok(tissue.children.every(t => /^TISSUE_/.test(t.args[0])));
  assert.ok(all.some(l => l.palette === 'FROM_ITEM'));
  assert.ok(all.flatMap(l => l.conditions).some(c => c.tier === 'B' && c.children.some(t => t.args[0] === 'TISSUE_SWAP')));
});

test('unknown tokens are kept on the innermost open thing; forms of LAYER and sets', () => {
  const src = 'x\n\n[OBJECT:GRAPHICS]\n\n[CREATURE_GRAPHICS:T]\n\t[LAYER_SET:PORTRAIT]\n\t[USE_LAYER_SET_TEMPLATE:ANIMAL_PEOPLE]\n\t\t[ARG_A:1]\n\t\t[ARG_B:2]\n'
    + '\thead\n\t[LAYER_GROUP]\n\t\t[LG_OFFSET:1:2]\n\t\t[LAYER:BIG:P:LARGE_IMAGE:0:0:1:1]\n\t\t\t[MYSTERY:1]\n\t\t[LAYER:WING:ARG_WING]\n\t\t\t[CONDITION_BP:BY_TYPE:X]\n\t\t\t[BP_PRESENT]\n\t[END_LAYER_GROUP]\n\t[LAYER:ORPHAN:P:0:0]\n';
  const doc = RawDocument.parse(src);
  const lg = readLayered(doc, doc.creatureGraphics()[0].block);
  const set = lg.sets[0];
  assert.equal(set.state, 'PORTRAIT');
  assert.deepEqual(set.templateUse?.args.map(t => t.args[0]), ['ARG_A', 'ARG_B']);
  const g = set.groups[0];
  assert.equal(g.label, 'head');
  assert.deepEqual(g.offset, [1, 2]);
  assert.deepEqual(g.layers[0].ref, { page: 'P', rect: [0, 0, 1, 1], large: true });
  assert.equal(g.layers[0].unknown.length, 1);
  assert.deepEqual(g.layers[1].ref, { arg: 'ARG_WING' });
  assert.deepEqual([g.layers[1].conditions[0].kind, g.layers[1].conditions[0].children.length, g.layers[1].conditions[0].tier], ['CONDITION_BP', 1, 'B']);
  assert.ok(g.end);
  assert.equal(set.unknown.length, 1);  // the LAYER after END_LAYER_GROUP has no group
  assert.equal(layeredTokens(lg).length, lg.block.children.length);
});

test('addLayer copies a sibling\'s conditions and palette; a lone condition edit does not touch the sibling', () => {
  const { doc, lg } = dwarf();
  const before = doc.toBytes();
  const def = lg.sets[2];
  const group = def.groups.find(g => g.layers.some(l => l.conditions.length && l.palette && l.palette !== 'FROM_ITEM'))!;
  const sibling = group.layers.find(l => l.conditions.length && l.palette && l.palette !== 'FROM_ITEM')!;
  const added = addLayer(doc, group, 'NEW_TEST_LAYER', { page: 'DWARF_BODY', rect: [0, 0, 0, 0], large: false }, sibling);

  assert.equal(added.name, 'NEW_TEST_LAYER');
  assert.deepEqual(added.palette, sibling.palette);
  assert.equal(added.conditions.length, sibling.conditions.length);
  assert.deepEqual(added.conditions.map(c => c.kind), sibling.conditions.map(c => c.kind));
  assert.notEqual(added.conditions[0].token, sibling.conditions[0].token); // its own TokenNode
  assert.equal(group.layers[group.layers.length - 1], added);

  // Change one of the new layer's conditions; the sibling it was copied from is untouched.
  const siblingArgsBefore = [...sibling.conditions[0].token.args];
  added.conditions[0].token.args = [added.conditions[0].kind, 'CHANGED'];
  assert.deepEqual(sibling.conditions[0].token.args, siblingArgsBefore);

  // Re-parsing the serialized doc finds the same layer with the same edit, and
  // every other layer (the whole rest of the 1438) is untouched.
  const doc2 = RawDocument.parse(doc.toString());
  const lg2 = readLayered(doc2, doc2.creatureGraphics()[0].block);
  const all2 = lg2.sets.flatMap(s => s.groups.flatMap(g => g.layers));
  const found = all2.find(l => l.name === 'NEW_TEST_LAYER')!;
  assert.ok(found);
  assert.equal(found.conditions[0].token.args[1], 'CHANGED');
  assert.equal(lg2.sets.flatMap(s => s.groups).reduce((n, g) => n + g.layers.length, 0), 1439);

  // A document that never called addLayer still round-trips byte-identical.
  const doc3 = RawDocument.fromBytes(bytes);
  readLayered(doc3, doc3.creatureGraphics()[0].block);
  assert.deepEqual(doc3.toBytes(), before);
});

// Regression: addLayer anchored the insertion right
// after the copyFrom sibling's own bare LAYER line instead of after all of
// its condition/palette lines, so readLayered's next pass reattached the
// sibling's own trailing tokens to the *new* layer instead -- the sibling
// silently lost its conditions/palette, exactly the "copy the group's last
// layer" case the layer-tree.ts "Add layer" button always hits.
test('addLayer copying the group\'s actual last layer leaves that layer\'s own conditions and palette intact', () => {
  const { doc, lg } = dwarf();
  const def = lg.sets[2];
  const group = def.groups.find(g => {
    const last = g.layers[g.layers.length - 1];
    return last && last.conditions.length && last.palette && last.palette !== 'FROM_ITEM';
  })!;
  const lastBefore = group.layers[group.layers.length - 1];
  const lastName = lastBefore.name;
  const lastConditionKinds = lastBefore.conditions.map(c => c.kind);
  const lastPalette = lastBefore.palette;

  addLayer(doc, group, 'NEW_TEST_LAYER_2', { page: 'DWARF_BODY', rect: [0, 0, 0, 0], large: false }, lastBefore);

  const doc2 = RawDocument.parse(doc.toString());
  const lg2 = readLayered(doc2, doc2.creatureGraphics()[0].block);
  const all2 = lg2.sets.flatMap(s => s.groups.flatMap(g => g.layers));
  const reread = all2.find(l => l.name === lastName)!;
  assert.ok(reread, `"${lastName}" should still exist after addLayer`);
  assert.deepEqual(reread.conditions.map(c => c.kind), lastConditionKinds);
  assert.deepEqual(reread.palette, lastPalette);
  const added = all2.find(l => l.name === 'NEW_TEST_LAYER_2')!;
  assert.deepEqual(added.conditions.map(c => c.kind), lastConditionKinds);
  assert.deepEqual(added.palette, lastPalette);
});

test('addLayer on an empty-conditions layer (no copyFrom) just adds the LAYER token', () => {
  const src = 'x\n\n[OBJECT:GRAPHICS]\n\n[CREATURE_GRAPHICS:T]\n\t[LAYER_SET:PORTRAIT]\n\t[LAYER_GROUP]\n\t\t[LAYER:A:P:0:0]\n\t[END_LAYER_GROUP]\n';
  const doc = RawDocument.parse(src);
  const lg = readLayered(doc, doc.creatureGraphics()[0].block);
  const group = lg.sets[0].groups[0];
  const added = addLayer(doc, group, 'B', { page: 'P', rect: [1, 1, 1, 1], large: false });
  assert.equal(group.layers.length, 2);
  assert.equal(added.conditions.length, 0);
  assert.equal(added.palette, undefined);
  const doc2 = RawDocument.parse(doc.toString());
  const lg2 = readLayered(doc2, doc2.creatureGraphics()[0].block);
  assert.deepEqual(lg2.sets[0].groups[0].layers.map(l => l.name), ['A', 'B']);
  assert.deepEqual(lg2.sets[0].groups[0].layers[1].ref, { page: 'P', rect: [1, 1, 1, 1], large: false });
});

test('setPaletteDefaultRow writes LS_PALETTE_DEFAULT, adding the token if it was missing', () => {
  const src = 'x\n\n[OBJECT:GRAPHICS]\n\n[CREATURE_GRAPHICS:T]\n\t[LAYER_SET:DEFAULT]\n\t[LS_PALETTE:BODY]\n\t\t[LS_PALETTE_FILE:images/p.png]\n';
  const doc = RawDocument.parse(src);
  const lg = readLayered(doc, doc.creatureGraphics()[0].block);
  const pal = lg.sets[0].palettes[0];
  assert.equal(pal.defaultToken, undefined);
  setPaletteDefaultRow(doc, pal, 4);
  assert.equal(pal.defaultRow, 4);
  const doc2 = RawDocument.parse(doc.toString());
  const lg2 = readLayered(doc2, doc2.creatureGraphics()[0].block);
  assert.equal(lg2.sets[0].palettes[0].defaultRow, 4);
  setPaletteDefaultRow(doc, pal, 7); // second call updates the existing token in place
  assert.equal(doc.toString().match(/LS_PALETTE_DEFAULT/g)?.length, 1);
});

test('readMod keeps a layered block instead of skipping it', () => {
  const r = readMod([{ path: 'graphics/graphics_creatures_dwarf.txt', bytes: new Uint8Array(bytes) }]);
  assert.equal(r.creatures.length, 0);
  assert.equal(r.layered.length, 1);
  assert.equal(r.layered[0].id, 'DWARF');
  assert.equal(r.layered[0].graphics.sets.length, 3);
  assert.deepEqual(r.warnings.filter(w => /skipped/.test(w)), []);
});
