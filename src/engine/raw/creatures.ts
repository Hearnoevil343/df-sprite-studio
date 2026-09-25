// Reads creature object raws (OBJECT:CREATURE), not graphics raws. Only the
// tokens the finder needs are kept: CASTE names, and the flags that decide
// which template to suggest.
import type { RawDocument } from './document.ts';

export type CreatureDef = { id: string; castes: string[]; flags: Set<string>; file: string };

// VERMIN_* covers every vermin-behaviour flag (VERMIN_GROUNDER, VERMIN_SOIL,
// VERMIN_FISH, ...), not just the literal token VERMIN.
function isFlag(name: string): boolean {
  return name === 'CHILD' || name === 'BABY' || name === 'LARGE_ROAMING' || name === 'DOES_NOT_EXIST' || name.startsWith('VERMIN_');
}

// SELECT_CREATURE reopens an existing id (a later raw file editing an
// earlier one) rather than starting a new creature.
export function readCreatures(doc: RawDocument, file = ''): CreatureDef[] {
  const out: CreatureDef[] = [];
  const byId = new Map<string, CreatureDef>();
  let cur: CreatureDef | undefined;
  for (const t of doc.tokens()) {
    const name = t.args[0];
    if (name === 'CREATURE' || name === 'SELECT_CREATURE') {
      const id = t.args[1] ?? '';
      cur = byId.get(id);
      if (!cur) { cur = { id, castes: [], flags: new Set(), file }; byId.set(id, cur); out.push(cur); }
    } else if (cur && name === 'CASTE') {
      const caste = t.args[1];
      if (caste && !cur.castes.includes(caste)) cur.castes.push(caste);
    } else if (cur && isFlag(name)) {
      cur.flags.add(name);
    }
  }
  return out;
}
