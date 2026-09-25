import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RawDocument, TEMPLATES, activeEntries, applyTemplate, buildTemplate, resolveEntries, templateFootprint } from '../src/engine/index.ts';

const BASES = {
  empty: '',
  lf: 'graphics_x\n\n[OBJECT:GRAPHICS]\n\n[CREATURE_GRAPHICS:A]\n\t[DEFAULT:P:0:0:AS_IS]\n',
  crlf: 'graphics_x\r\n\r\n[OBJECT:GRAPHICS]\r\n',
};

for (const t of TEMPLATES) {
  const all = { creature: 'TEST_BEAST', page: 'TEST_PAGE', x: 2, y: 5, include: t.entries.map(e => e.key) };
  for (const [name, base] of Object.entries(BASES)) {
    for (const caste of [undefined, 'FEMALE']) {
      test(`${t.id} parses back (${name} file${caste ? ', caste' : ''})`, () => {
        const p = { ...all, caste };
        const want = buildTemplate(t, p);
        const doc = RawDocument.parse(base);
        applyTemplate(doc, t, p);
        const src = doc.toString();
        assert.ok(src.startsWith(base), 'existing text untouched');
        const back = RawDocument.parse(src);
        assert.equal(back.toString(), src, 'round-trips');
        const cg = back.creatureGraphics().at(-1)!;
        assert.deepEqual(cg.block.header.args, want.header);
        assert.deepEqual(cg.entries.map(e => e.args), want.children);
        assert.equal(cg.caste, caste);
      });
    }
  }
}

test('defaults, omit, and CHILD follows its parent', () => {
  const t = TEMPLATES.find(t => t.id === 'simple-creature')!;
  const keys = (omit: string[]) =>
    buildTemplate(t, { creature: 'C', page: 'P', omit }).children.map(a => a[0] + (a[a.length - 1] === 'AS_IS' ? '' : ':' + a[a.length - 1]));
  assert.deepEqual(keys([]), ['DEFAULT', 'CHILD:DEFAULT', 'ANIMATED', 'CHILD:ANIMATED', 'CORPSE', 'CHILD:CORPSE', 'GHOST']);
  assert.deepEqual(keys(['ANIMATED', 'GHOST']), ['DEFAULT', 'CHILD:DEFAULT', 'CORPSE', 'CHILD:CORPSE']);
  const v = TEMPLATES.find(t => t.id === 'vermin')!;
  assert.ok(!buildTemplate(v, { creature: 'C', page: 'P' }).children.some(a => a[0] === 'HIVE'));
});

test('multi-tile and statue coordinates match vanilla syntax', () => {
  const m = TEMPLATES.find(t => t.id === 'multi-tile-creature')!;
  assert.deepEqual(buildTemplate(m, { creature: 'C', page: 'P', y: 6 }).children[0], ['DEFAULT', 'P', 'LARGE_IMAGE', '0', '6', '2', '7', 'AS_IS']);
  const s = TEMPLATES.find(t => t.id === 'statue')!;
  assert.deepEqual(buildTemplate(s, { creature: 'C', page: 'P', y: 2 }).children, [['DEFAULT', 'P', '0', '2', '0', '3']]);
});

test('activeEntries agrees with buildTemplate on which entries are on, for the sprite checklist', () => {
  const s = TEMPLATES.find(t => t.id === 'simple-creature')!;
  for (const p of [{}, { omit: ['ANIMATED', 'GHOST'] }, { include: [] }]) {
    const wantTokens = buildTemplate(s, { creature: 'C', page: 'P', ...p }).children.map(a => a[0]);
    const gotKeys = activeEntries(s, p).map(e => e.key);
    assert.deepEqual(gotKeys.map(k => s.entries.find(e => e.key === k)!.token), wantTokens);
  }
  const v = TEMPLATES.find(t => t.id === 'vermin')!;
  assert.ok(!activeEntries(v, {}).some(e => e.key === 'VERMIN_ALT'), 'off by default');
  assert.ok(activeEntries(v, { include: ['VERMIN_ALT'] }).some(e => e.key === 'VERMIN_ALT'));
});

test('resolveEntries with no size override returns the template\'s own at/size, matching activeEntries', () => {
  const m = TEMPLATES.find(t => t.id === 'multi-tile-creature')!;
  const resolved = resolveEntries(m, {});
  const active = activeEntries(m, {});
  assert.deepEqual(resolved.map(e => e.key), active.map(e => e.key));
  for (const [r, a] of resolved.map((r, i) => [r, active[i]] as const)) {
    assert.deepEqual(r.at, a.at);
    assert.deepEqual(r.size, a.size ?? [1, 1]);
  }
});

test('resolveEntries with a size override lays entries out on a shelf and recomputes at', () => {
  const m = TEMPLATES.find(t => t.id === 'multi-tile-creature')!;
  const defaultEntry = m.entries.find(e => e.key === m.entries[0].key)!;
  const [fw] = templateFootprint(m);
  const resolved = resolveEntries(m, { sizes: { [defaultEntry.key]: [4, 4] } });
  // The resized entry starts at the origin; nothing overlaps it, and every
  // entry lands within the shelf's band width (footprint or widest, whichever
  // is larger -- here the resized entry itself, 4 tiles wide).
  const first = resolved.find(e => e.key === defaultEntry.key)!;
  assert.deepEqual(first.at, [0, 0]);
  assert.deepEqual(first.size, [4, 4]);
  const bandWidth = Math.max(fw, 4);
  for (const e of resolved) assert.ok(e.at[0] + e.size[0] <= bandWidth, `${e.key} stays within the shelf band`);
  // No two entries overlap.
  for (let i = 0; i < resolved.length; i++) {
    for (let j = i + 1; j < resolved.length; j++) {
      const a = resolved[i], b = resolved[j];
      const overlapX = a.at[0] < b.at[0] + b.size[0] && b.at[0] < a.at[0] + a.size[0];
      const overlapY = a.at[1] < b.at[1] + b.size[1] && b.at[1] < a.at[1] + a.size[1];
      assert.ok(!(overlapX && overlapY), `${a.key} and ${b.key} must not overlap`);
    }
  }
});

test('resolveEntries never resizes a plain-rect template (statue) even if sizes are passed', () => {
  const s = TEMPLATES.find(t => t.id === 'statue')!;
  assert.equal(s.rect, 'plain');
  const resolved = resolveEntries(s, { sizes: { [s.entries[0].key]: [3, 3] } });
  const plain = activeEntries(s, {});
  assert.deepEqual(resolved.map(e => e.size), plain.map(e => e.size ?? [1, 1]), 'plain templates ignore size overrides');
});

test('buildTemplate writes a 1x1 override as a plain tile and anything bigger as LARGE_IMAGE', () => {
  const m = TEMPLATES.find(t => t.id === 'multi-tile-creature')!;
  const key = m.entries[0].key;
  const shrunk = buildTemplate(m, { creature: 'C', page: 'P', sizes: { [key]: [1, 1] } });
  assert.deepEqual(shrunk.children[0].slice(0, 4), [m.entries[0].token, 'P', '0', '0'], '1x1 override writes plain coords, no LARGE_IMAGE');
  const grown = buildTemplate(m, { creature: 'C', page: 'P', sizes: { [key]: [4, 4] } });
  assert.ok(grown.children[0].includes('LARGE_IMAGE'));
});
