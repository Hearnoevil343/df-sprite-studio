import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RawDocument, readCreatures } from '../src/engine/index.ts';

const RAW = `creature_x

[OBJECT:CREATURE]

[CREATURE:TOAD]
\t[VERMIN_GROUNDER][VERMIN_HATEABLE]
\t[CASTE:MALE]
\t[CASTE:FEMALE]

[CREATURE:DOG]
\t[LARGE_ROAMING]
\t[CHILD:1]

[CREATURE:IMP]
\t[DOES_NOT_EXIST]

[SELECT_CREATURE:DOG]
\t[BABY:1]
`;

test('collects id, castes and only the flags the finder needs', () => {
  const defs = readCreatures(RawDocument.parse(RAW), 'creature_x.txt');
  assert.deepEqual(defs.map(d => d.id), ['TOAD', 'DOG', 'IMP']);
  const toad = defs[0];
  assert.deepEqual(toad.castes, ['MALE', 'FEMALE']);
  assert.deepEqual([...toad.flags].sort(), ['VERMIN_GROUNDER', 'VERMIN_HATEABLE']);
  assert.equal(toad.file, 'creature_x.txt');
});

test('SELECT_CREATURE reopens the same id instead of adding a new one', () => {
  const defs = readCreatures(RawDocument.parse(RAW));
  const dog = defs.find(d => d.id === 'DOG')!;
  assert.equal(defs.filter(d => d.id === 'DOG').length, 1);
  assert.deepEqual([...dog.flags].sort(), ['BABY', 'CHILD', 'LARGE_ROAMING']);
});

test('unrelated tags are ignored', () => {
  const defs = readCreatures(RawDocument.parse(RAW));
  const imp = defs.find(d => d.id === 'IMP')!;
  assert.deepEqual([...imp.flags], ['DOES_NOT_EXIST']);
  assert.deepEqual(imp.castes, []);
});
