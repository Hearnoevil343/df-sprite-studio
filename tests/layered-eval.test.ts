import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RawDocument, composite, defaultFigure, evaluateGroup, evaluateLayer, readLayered } from '../src/engine/index.ts';
import type { Figure } from '../src/engine/index.ts';

const bytes = readFileSync(new URL('./fixtures/graphics_creatures_dwarf.txt', import.meta.url));
const doc = RawDocument.fromBytes(bytes);
const lg = readLayered(doc, doc.creatureGraphics()[0].block);
const skin = { part: 'HEAD', tissue: 'SKIN', color: 'BROWN' };
const male = (over: Partial<Figure> = {}) => defaultFigure({ caste: 'MALE', professionCategory: 'STANDARD', tissues: [skin], ...over });
const names = (f: Figure) => composite(lg, f).draws.map(d => d.layer.name);

test('adult male: one layer per group in file order, shadow first', () => {
  const c = composite(lg, male());
  assert.equal(c.set, lg.sets[2]);
  assert.equal(c.draws[0].layer.name, 'SHADOW');
  const order = c.draws.map(d => lg.sets[2].groups.indexOf(d.group));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.equal(new Set(order).size, order.length);
  assert.ok(names(male()).includes('DMID_FACE_M1'));
  assert.ok(!names(male()).includes('DMID_FACE_F1'));
});

test('caste and random part index pick the face', () => {
  assert.ok(names(male({ caste: 'FEMALE' })).includes('DMID_FACE_F1'));
  assert.ok(names(male({ randomPartIndex: { HEAD: 2 } })).includes('DMID_FACE_M2'));
  assert.ok(!names(male({ randomPartIndex: { HEAD: 2 } })).includes('DMID_FACE_M1'));
});

test('first match wins: a worn helm is drawn and the bare layers are shut off', () => {
  const helm = { mode: 'BY_CATEGORY', part: 'HEAD', type: 'HELM', item: 'ITEM_HELM_HELM', materialFlags: ['ANY_WOOD_MATERIAL'] };
  const bare = names(male());
  const worn = names(male({ worn: [helm] }));
  assert.ok(!bare.some(n => n.startsWith('CLOTHING_HELM')));
  assert.ok(worn.some(n => n.startsWith('CLOTHING_HELM')));
});

test('SHUT_OFF_IF_ITEM_PRESENT fails when the item is worn, passes when not', () => {
  const raw = '[OBJECT:GRAPHICS]\n[CREATURE_GRAPHICS:TEST]\n[LAYER_SET:DEFAULT]\n[LAYER_GROUP]\n[LAYER:A:PAGE:0:0][SHUT_OFF_IF_ITEM_PRESENT:BY_CATEGORY:HEAD:HELM:ITEM_HELM_HELM]';
  const d = RawDocument.fromBytes(new TextEncoder().encode(raw));
  const layer = readLayered(d, d.creatureGraphics()[0].block).sets[0].groups[0].layers[0];
  const helm = { mode: 'BY_CATEGORY', part: 'HEAD', type: 'HELM', item: 'ITEM_HELM_HELM' };
  assert.equal(evaluateLayer(layer, male({ worn: [helm] })).verdict, 'fail');
  assert.equal(evaluateLayer(layer, male()).verdict, 'pass');
});

test('undead: syn class and ghost pick the zombie layers', () => {
  const z = names(male({ synClasses: ['ZOMBIE'] }));
  assert.ok(z.includes('Z_BODY_M'));
  assert.ok(!z.includes('DMID_BODY'));
});

test('tier B is unknown: hair with TISSUE_SWAP draws nothing and is reported', () => {
  const c = composite(lg, male({ tissues: [skin, { part: 'HEAD', tissue: 'HAIR', color: 'BROWN', length: 5 }] }));
  const hair = c.results.find(r => r.group.label === 'hair')!;
  assert.equal(hair.chosen, undefined);
  assert.ok(hair.maybeWrong);
  assert.ok(hair.unknown.length > 0);
  assert.ok(c.notes.some(n => n.startsWith('hair: nothing drawn')));
  assert.ok(hair.unknown.every(u => evaluateLayer(u.layer, male()).verdict !== 'pass'));
});

test('an unknown layer before the chosen one flags "first match may be wrong"', () => {
  const raw = ['[OBJECT:GRAPHICS]', '[CREATURE_GRAPHICS:TEST]', '[LAYER_SET:DEFAULT]', '[LAYER_GROUP]',
    '[LAYER:A:PAGE:0:0][CONDITION_BP:BY_TOKEN:X][BP_PRESENT]', '[LAYER:B:PAGE:1:0][CONDITION_CASTE:MALE]', '[LAYER:C:PAGE:2:0]'].join('\n');
  const d = RawDocument.fromBytes(new TextEncoder().encode(raw));
  const t = readLayered(d, d.creatureGraphics()[0].block);
  const r = evaluateGroup(t.sets[0].groups[0], male());
  assert.equal(r.chosen?.name, 'B');
  assert.ok(r.maybeWrong);
  assert.deepEqual(r.unknown.map(u => u.layer.name), ['A']);
  assert.equal(evaluateGroup(t.sets[0].groups[0], male({ caste: 'FEMALE' })).chosen?.name, 'C');
});

test('a figure with no skin draws no body; nothing is drawn silently', () => {
  const c = composite(lg, male({ tissues: [] }));
  assert.ok(!c.draws.some(d => d.layer.name.startsWith('DMID_BODY')));
});

test('child figures use the CHILD set, babies the BABY set', () => {
  assert.equal(composite(lg, male({ age: 'child' })).set, lg.sets[1]);
  assert.equal(composite(lg, male({ age: 'baby' })).set, lg.sets[0]);
});

test('portrait sets are not composited, and say so', () => {
  const c = composite(lg, male({ state: 'PORTRAIT' }));
  assert.equal(c.draws.length, 0);
  assert.ok(c.notes.length > 0);
});

test('evaluation does not mutate the token list', () => {
  const before = doc.nodes.length;
  composite(lg, male());
  assert.equal(doc.nodes.length, before);
  assert.deepEqual(RawDocument.fromBytes(bytes).nodes.length, before);
});
