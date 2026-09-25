import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMissingArt, suggestTemplate } from '../src/engine/index.ts';
import type { ModFile, ModSource } from '../src/engine/index.ts';

const bytes = (s: string) => new TextEncoder().encode(s);
const file = (path: string, text: string): ModFile => ({ path, bytes: bytes(text) });

const CREATURES = `creature_c

[OBJECT:CREATURE]

[CREATURE:GOBBO]
[CREATURE:PARTIAL]
[CREATURE:FULL]
[CREATURE:BUGLET]
\t[VERMIN_GROUNDER]
[CREATURE:STATUEONLY]
[CREATURE:CASTED]
\t[CASTE:MALE]
\t[CASTE:FEMALE]
`;

const GRAPHICS = `graphics_c

[OBJECT:GRAPHICS]

[TILE_PAGE:P]
\t[FILE:images/p.png]
\t[TILE_DIM:32:32]
\t[PAGE_DIM_PIXELS:320:320]

[CREATURE_GRAPHICS:PARTIAL]
\t[DEFAULT:P:0:0:AS_IS]

[CREATURE_GRAPHICS:FULL]
\t[DEFAULT:P:0:0:AS_IS]
\t[ANIMATED:P:1:0:AS_IS]
\t[CORPSE:P:2:0:AS_IS]
\t[GHOST:P:3:0:AS_IS]

[STATUE_CREATURE_GRAPHICS:STATUEONLY]
\t[DEFAULT:P:0:0:0:1]

[CREATURE_CASTE_GRAPHICS:CASTED:MALE]
\t[DEFAULT:P:0:0:AS_IS]
\t[ANIMATED:P:1:0:AS_IS]
\t[CORPSE:P:2:0:AS_IS]
\t[GHOST:P:3:0:AS_IS]
`;

const source: ModSource = { id: 'test', root: '.', files: [file('objects/creature_c.txt', CREATURES), file('graphics/graphics_c.txt', GRAPHICS)] };

test('suggestTemplate: vermin flag picks vermin, otherwise the simple creature', () => {
  assert.equal(suggestTemplate({ flags: new Set(['VERMIN_GROUNDER']) }), 'vermin');
  assert.equal(suggestTemplate({ flags: new Set() }), 'simple-creature');
});

test('no graphics at all: status none, every active entry missing', () => {
  const found = findMissingArt([source]).find(m => m.id === 'GOBBO')!;
  assert.equal(found.status, 'none');
  assert.deepEqual(found.missing.sort(), ['ANIMATED', 'CORPSE', 'DEFAULT', 'GHOST']);
  assert.deepEqual(found.graphicsIn, []);
  assert.equal(found.template, 'simple-creature');
});

test('some entries drawn: status partial, only the undrawn ones listed', () => {
  const found = findMissingArt([source]).find(m => m.id === 'PARTIAL')!;
  assert.equal(found.status, 'partial');
  assert.deepEqual(found.missing.sort(), ['ANIMATED', 'CORPSE', 'GHOST']);
  assert.deepEqual(found.graphicsIn, ['graphics/graphics_c.txt']);
});

test('every active entry drawn: not reported', () => {
  assert.equal(findMissingArt([source]).find(m => m.id === 'FULL'), undefined);
});

test('vermin creature suggests the vermin template', () => {
  const found = findMissingArt([source]).find(m => m.id === 'BUGLET')!;
  assert.equal(found.template, 'vermin');
  assert.deepEqual(found.missing.sort(), ['REMAINS', 'SWARM_LARGE', 'SWARM_MEDIUM', 'SWARM_SMALL', 'VERMIN']);
});

test('a statue block does not count as the (non-statue) template being covered', () => {
  const found = findMissingArt([source]).find(m => m.id === 'STATUEONLY')!;
  assert.equal(found.status, 'none');
  assert.deepEqual(found.graphicsIn, []);
});

test('castes are independent: one caste fully covered does not cover another', () => {
  const results = findMissingArt([source]).filter(m => m.id === 'CASTED');
  assert.deepEqual(results.map(r => r.caste).sort(), ['FEMALE']);
  const female = results[0];
  assert.equal(female.status, 'none');
  assert.deepEqual(female.missing.sort(), ['ANIMATED', 'CORPSE', 'DEFAULT', 'GHOST']);
});

test('a layered creature (LAYER_SET) is left out, not reported as missing', () => {
  const layered: ModFile = file('graphics/layered.txt', `layered\n\n[OBJECT:GRAPHICS]\n\n[CREATURE_GRAPHICS:LAYERED]\n\t[LAYER_SET:DEFAULT]\n\t\t[USE_LAYER_SET_TEMPLATE:ANIMAL_PEOPLE]\n`);
  const creature: ModFile = file('objects/layered_creature.txt', `layered_creature\n\n[OBJECT:CREATURE]\n\n[CREATURE:LAYERED]\n`);
  const src: ModSource = { id: 'layered', root: '.', files: [creature, layered] };
  assert.equal(findMissingArt([src]).find(m => m.id === 'LAYERED'), undefined);
});

test('graphics from a second source count too', () => {
  const extra: ModSource = { id: 'extra', root: '.', files: [file('graphics/more.txt', `more\n\n[OBJECT:GRAPHICS]\n\n[TILE_PAGE:P]\n\t[FILE:images/p.png]\n\t[TILE_DIM:32:32]\n\t[PAGE_DIM_PIXELS:320:320]\n\n[CREATURE_GRAPHICS:PARTIAL]\n\t[ANIMATED:P:1:0:AS_IS]\n\t[CORPSE:P:2:0:AS_IS]\n\t[GHOST:P:3:0:AS_IS]\n`)] };
  assert.equal(findMissingArt([source, extra]).find(m => m.id === 'PARTIAL'), undefined);
});
