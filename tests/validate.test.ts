import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createImage, setPixel, validateMod, validateMods } from '../src/engine/index.ts';
import type { ModFile, VanillaIndex } from '../src/engine/index.ts';

const bytes = (s: string) => new TextEncoder().encode(s);
const file = (path: string, text: string): ModFile => ({ path, bytes: bytes(text) });

const KNOWN: VanillaIndex = {
  creatures: {},
  tilePageIds: ['CREATURE_ABILITY_LIST_ICONS'],
  graphicsFiles: ['vanilla_shared.txt'],
  tokens: ['DEFAULT', 'ANIMATED', 'CORPSE', 'GHOST', 'CHILD', 'CDI_LIST_ICON'],
};

const GOOD_IMAGE = createImage(64, 32);
setPixel(GOOD_IMAGE, 0, 0, [10, 20, 30, 255]); // tile (0,0) opaque, tile (1,0) stays blank

const CREATURES = `creature_c\n\n[OBJECT:CREATURE]\n\n[CREATURE:CG1]\n[CREATURE:CG2]\n[CREATURE:CG3]\n`;

const GRAPHICS = `graphics_c

[OBJECT:GRAPHICS]

[TILE_PAGE:GOOD]
\t[FILE:images/good.png]
\t[TILE_DIM:32:32]
\t[PAGE_DIM_PIXELS:64:32]

[TILE_PAGE:MISSING]
\t[FILE:images/missing.png]
\t[TILE_DIM:32:32]
\t[PAGE_DIM_PIXELS:32:32]

[TILE_PAGE:BADSIZE]
\t[FILE:images/good.png]
\t[TILE_DIM:32:32]
\t[PAGE_DIM_PIXELS:999:999]

[CREATURE_GRAPHICS:CG1]
\t[DEFAULT:GOOD:0:0:AS_IS]
\t[UNKNOWNTOK:GOOD:0:0]
\t[CHILD:GOOD:0:0:AS_IS:NOPE]

[CREATURE_GRAPHICS:CG2]
\t[DEFAULT:GOOD:5:5:AS_IS]

[CREATURE_GRAPHICS:CG3]
\t[DEFAULT:GOOD:1:0:AS_IS]

[CREATURE_GRAPHICS:GHOSTCREATURE]
\t[DEFAULT:GOOD:0:0:AS_IS]
`;

const BAD_INFO = '[ID:My-Mod!]\r\n[NUMERIC_VERSION:abc]\r\n[DISPLAYED_VERSION:1]\r\n[AUTHOR:Me]\r\n[NAME:Test]\r\n';

const FILES: ModFile[] = [
  { path: 'info.txt', bytes: bytes(BAD_INFO) },
  file('objects/creature_c.txt', CREATURES),
  file('graphics/graphics_c.txt', GRAPHICS),
  { path: 'graphics/images/good.png', image: GOOD_IMAGE },
];

const rules = (files: ModFile[]) => validateMod(files, KNOWN).map(i => i.rule).sort();

test('info.txt: empty field, bad id and non-numeric version all flagged', () => {
  const r = rules(FILES);
  assert.ok(r.includes('info-field'), r.join(','));
  assert.ok(r.includes('info-id'), r.join(','));
  assert.ok(r.includes('info-numeric-version'), r.join(','));
});

test('missing info.txt is its own error and nothing else', () => {
  assert.deepEqual(validateMod(FILES.filter(f => f.path !== 'info.txt'), KNOWN).map(i => i.rule).filter(r => r.startsWith('info')), ['info-missing']);
});

test('tile page whose image is not in the file set', () => {
  assert.ok(rules(FILES).includes('page-missing'));
});

test('tile page whose declared size does not match the actual image', () => {
  assert.ok(rules(FILES).includes('page-size'));
});

test('a token no vanilla raw uses is a warning', () => {
  const issue = validateMod(FILES, KNOWN).find(i => i.rule === 'token-unknown');
  assert.equal(issue?.severity, 'warn');
  assert.equal(issue?.value, 'UNKNOWNTOK');
});

test('CHILD with no matching sibling entry to replace', () => {
  const issue = validateMod(FILES, KNOWN).find(i => i.rule === 'child-orphan');
  assert.equal(issue?.creature, 'CG1');
});

test('a rect that falls outside its page', () => {
  const issue = validateMod(FILES, KNOWN).find(i => i.rule === 'rect-bounds');
  assert.equal(issue?.creature, 'CG2');
});

test('a rect that is fully transparent', () => {
  const issue = validateMod(FILES, KNOWN).find(i => i.rule === 'rect-blank');
  assert.equal(issue?.creature, 'CG3');
});

test('a creature id not defined in this mod or vanilla', () => {
  const issue = validateMod(FILES, KNOWN).find(i => i.rule === 'creature-unknown');
  assert.equal(issue?.creature, 'GHOSTCREATURE');
});

test('a valid entry raises none of the above for CG1\'s DEFAULT', () => {
  const issues = validateMod(FILES, KNOWN).filter(i => i.creature === 'CG1');
  assert.ok(!issues.some(i => i.rule === 'rect-bounds' || i.rule === 'rect-blank'));
});

const modA = { id: 'mod_a', files: [file('graphics/shared.txt', GRAPHICS), { path: 'graphics/images/good.png', image: GOOD_IMAGE }] };
const modB = { id: 'mod_b', files: [file('graphics/shared.txt', GRAPHICS), { path: 'graphics/images/good.png', image: GOOD_IMAGE }] };
const modVanillaName = { id: 'mod_c', files: [file('vanilla_shared.txt', GRAPHICS)] };

test('validateMods: a graphics file name shared with vanilla', () => {
  const issues = validateMods([modVanillaName], KNOWN);
  assert.ok(issues.some(i => i.rule === 'file-shared-vanilla'));
});

test('validateMods: the same file name written by two mods', () => {
  const issues = validateMods([modA, modB], KNOWN);
  assert.ok(issues.some(i => i.rule === 'file-shared-mod' && i.mod === 'mod_b'));
});

test('validateMods: the same tile page id defined by two mods', () => {
  const issues = validateMods([modA, modB], KNOWN);
  assert.ok(issues.some(i => i.rule === 'page-id-shared' && i.mod === 'mod_b'));
});

test('validateMods: two mods giving graphics to the same creature is only an info', () => {
  const issues = validateMods([modA, modB], KNOWN).filter(i => i.rule === 'creature-shared');
  assert.ok(issues.length > 0);
  assert.ok(issues.every(i => i.severity === 'info'));
});

// A layered block's LAYER/LAYER_SET/CONDITION_* tokens are not the flat
// "token:page:x:y" sprite entries the generic loop above checks -- before
// the 6-5 fix, reading a LAYER's own name as a page id (LAYER:SHADOW:P:0:0
// -> page "SHADOW") fired a page-unknown error on every single layer.
const LAYERED_GRAPHICS = `graphics_layered
[OBJECT:GRAPHICS]

[TILE_PAGE:GOOD]
\t[FILE:images/good.png]
\t[TILE_DIM:32:32]
\t[PAGE_DIM_PIXELS:64:32]

[CREATURE_GRAPHICS:CG2]
\t[LAYER_SET:DEFAULT]
\tbody
\t[LAYER_GROUP]
\t\t[LAYER:SHADOW:GOOD:0:0]
\t\t[LAYER:OUT_OF_BOUNDS:GOOD:5:5]
\t\t[LAYER:BLANK:GOOD:1:0]
\t\t[LAYER:UNKNOWN_PAGE:NOPE:0:0]
\t\t[LAYER:REVERSED:GOOD:LARGE_IMAGE:0:1:1:0]
\t[END_LAYER_GROUP]
`;
const LAYERED_FILES: ModFile[] = [
  { path: 'info.txt', bytes: bytes(BAD_INFO) },
  file('objects/creature_c.txt', CREATURES),
  file('graphics/graphics_layered.txt', LAYERED_GRAPHICS),
  { path: 'graphics/images/good.png', image: GOOD_IMAGE },
];

test('a layered block: valid layer raises nothing, unknown page/out-of-bounds/blank each their own rule, and no generic token-unknown noise', () => {
  const issues = validateMod(LAYERED_FILES, KNOWN);
  const layered = issues.filter(i => i.creature === 'CG2');
  assert.ok(layered.some(i => i.rule === 'page-unknown' && i.key === 'UNKNOWN_PAGE'), layered.map(i => i.rule).join(','));
  assert.ok(layered.some(i => i.rule === 'rect-bounds' && i.key === 'OUT_OF_BOUNDS'));
  assert.ok(layered.some(i => i.rule === 'rect-blank' && i.key === 'BLANK'));
  assert.ok(!layered.some(i => i.key === 'SHADOW'));
  assert.ok(!layered.some(i => i.rule === 'token-unknown' || i.rule === 'child-orphan'));
});

// Found live in Topples' Orcs (graphics_orc_gb.txt): a LARGE_IMAGE layer with
// its corners reversed (y2 < y1) produced a negative height, and
// isBlank(crop(...)) crashed the whole validate run with a RangeError from
// new Uint8ClampedArray(negative length) instead of reporting an issue.
test('a layered LARGE_IMAGE layer with reversed corners (negative span) is a rect-bounds error, not a crash', () => {
  const issues = validateMod(LAYERED_FILES, KNOWN);
  const layered = issues.filter(i => i.creature === 'CG2');
  assert.ok(layered.some(i => i.rule === 'rect-bounds' && i.key === 'REVERSED'), layered.map(i => i.rule).join(','));
});

// Found live in Mcnuggy's Mythical Beasts: CDI_LIST_ICON's shape is
// [CDI_LIST_ICON:<interaction token>:<page>:x:y] -- one extra field before
// the page compared to every other entry's [token:page:x:y]. Reading args[1]
// as the page there matched the interaction token instead (e.g.
// CDI_LIST_ICON:SPIT:CREATURE_ABILITY_LIST_ICONS:0:0 -> page "SPIT"),
// misfiring page-unknown on every icon -- including ones on a page vanilla
// defines that the mod never redeclares.
const CDI_GRAPHICS = `graphics_cdi
[OBJECT:GRAPHICS]

[CREATURE_GRAPHICS:CG3]
\t[CDI_LIST_ICON:SPIT:CREATURE_ABILITY_LIST_ICONS:0:0]
`;
const CDI_FILES: ModFile[] = [
  { path: 'info.txt', bytes: bytes(BAD_INFO) },
  file('objects/creature_c.txt', CREATURES),
  file('graphics/graphics_cdi.txt', CDI_GRAPHICS),
];

test('CDI_LIST_ICON reads the page from the right field, and a vanilla-only page it reuses is not page-unknown', () => {
  const issues = validateMod(CDI_FILES, KNOWN);
  assert.ok(!issues.some(i => i.rule === 'page-unknown'), issues.map(i => i.rule).join(','));
});
