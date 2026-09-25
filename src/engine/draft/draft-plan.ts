// Which missing template entries can be drafted from what's already drawn,
// and the chain of draftVariant kinds to get there. Never overwrites a drawn
// entry: drawnKeys is the checklist's own notion of "has a sprite".
import type { SpriteTemplate, TemplateEntry } from '../templates/template.ts';
import type { DraftKind } from './draft-variant.ts';

export type DraftStep = { key: string; from: string; kinds: DraftKind[] };

// Token name -> the draftVariant kind that turns a DEFAULT into it.
const KIND_FOR_TOKEN: Partial<Record<string, DraftKind>> = { CORPSE: 'corpse', ANIMATED: 'animated', GHOST: 'ghost' };

export function draftPlan(t: SpriteTemplate, drawnKeys: Set<string>): DraftStep[] {
  const byToken = new Map<string, TemplateEntry>();
  for (const e of t.entries) if (e.token !== 'CHILD') byToken.set(e.token, e);
  const def = byToken.get('DEFAULT');

  const plan: DraftStep[] = [];
  for (const e of t.entries) {
    if (drawnKeys.has(e.key)) continue;

    if (e.token === 'CHILD') {
      const parent = e.requires; // DEFAULT, CORPSE or ANIMATED - also that entry's own key here
      if (!parent) continue;
      if (drawnKeys.has(parent)) { plan.push({ key: e.key, from: parent, kinds: ['child'] }); continue; }
      const variantKind = KIND_FOR_TOKEN[parent];
      if (variantKind && def && drawnKeys.has(def.key)) plan.push({ key: e.key, from: def.key, kinds: ['child', variantKind] });
      continue;
    }

    const kind = KIND_FOR_TOKEN[e.token];
    if (kind && def && drawnKeys.has(def.key)) plan.push({ key: e.key, from: def.key, kinds: [kind] });
  }
  return plan;
}
