// Tier A condition evaluation and the composite draw list. Pure: a layer is
// tested against a Figure, giving pass / fail / unknown. Tier B conditions (and
// anything unrecognised) are unknown, which is never drawn and never hidden:
// the result says what could not be evaluated. Group semantics (first passing
// layer wins, groups in file order) are the design note's assumptions, to be
// confirmed by eye in 6-6.
import type { Condition, Layer, LayerGroup, LayerSet, LayeredGraphics } from '../raw/layers.ts';
import type { Figure, WornItem } from './figure.ts';
import { pickSet } from './figure.ts';

export type Verdict = 'pass' | 'fail' | 'unknown';

// What tests a worn item: [BY_CATEGORY|BY_TOKEN, part, type, item, item...].
function wornMatches(worn: WornItem[], args: string[]): WornItem | undefined {
  const [mode, part, type, ...items] = args;
  return worn.find(w => w.mode === mode && w.part === part && w.type === type && (items.includes('ANY') || items.includes(w.item)));
}

// A material condition refines the item worn condition before it, so `item`
// carries the last one seen through a layer's conditions.
type ItemState = { last?: WornItem; seen: boolean };

function evalCondition(c: Condition, fig: Figure, item: ItemState): Verdict {
  if (c.tier === 'B') return 'unknown';
  const a = c.token.args.slice(1);
  switch (c.kind) {
    case 'CONDITION_CASTE': return fig.caste !== undefined && a.includes(fig.caste) ? 'pass' : 'fail';
    case 'CONDITION_CHILD': return fig.age !== 'adult' ? 'pass' : 'fail';
    case 'CONDITION_NOT_CHILD': return fig.age === 'adult' ? 'pass' : 'fail';
    case 'CONDITION_GHOST': return fig.ghost ? 'pass' : 'fail';
    case 'CONDITION_SYN_CLASS': return a.some(s => fig.synClasses.includes(s)) ? 'pass' : 'fail';
    case 'CONDITION_PROFESSION_CATEGORY': return fig.professionCategory !== undefined && a.includes(fig.professionCategory) ? 'pass' : 'fail';
    case 'CONDITION_ITEM_WORN':
      item.seen = true;
      item.last = wornMatches(fig.worn, a);
      return item.last ? 'pass' : 'fail';
    case 'SHUT_OFF_IF_ITEM_PRESENT': return wornMatches(fig.worn, a) ? 'fail' : 'pass';
    case 'CONDITION_RANDOM_PART_INDEX': return fig.randomPartIndex[a[0]] === Number(a[1]) ? 'pass' : 'fail';
    case 'CONDITION_MATERIAL_FLAG': {
      if (!item.seen) return 'unknown';
      const flags = item.last?.materialFlags ?? [];
      // NOT_ARTIFACT is the absence of IS_CRAFTED_ARTIFACT, not a flag items carry.
      return item.last && a.every(f => (f === 'NOT_ARTIFACT' ? !flags.includes('IS_CRAFTED_ARTIFACT') : flags.includes(f))) ? 'pass' : 'fail';
    }
    case 'CONDITION_MATERIAL_TYPE':
      if (!item.seen) return 'unknown';
      return item.last?.materialType !== undefined && a.includes(item.last.materialType) ? 'pass' : 'fail';
    case 'CONDITION_TISSUE_LAYER': {
      const [, part, tissue] = a;                       // BY_CATEGORY:part:tissue
      const t = fig.tissues.find(x => (part === 'ALL' || x.part === part) && x.tissue === tissue);
      if (!t) return 'fail';
      for (const ch of c.children) {
        const [k, ...v] = ch.args;
        const ok = k === 'TISSUE_MAY_HAVE_COLOR' ? t.color !== undefined && v.includes(t.color)
          : k === 'TISSUE_MIN_LENGTH' ? (t.length ?? 0) >= Number(v[0])
          : k === 'TISSUE_MAX_LENGTH' ? (t.length ?? 0) <= Number(v[0])
          : k === 'TISSUE_NOT_SHAPED' ? t.shaping === undefined
          : k === 'TISSUE_MAY_HAVE_SHAPING' ? t.shaping !== undefined && v.includes(t.shaping)
          : undefined;
        if (ok === undefined) return 'unknown';
        if (!ok) return 'fail';
      }
      return 'pass';
    }
    default: return 'unknown';
  }
}

// Fail beats unknown beats pass, so a layer that surely fails is never reported
// as merely unknown.
function evalAll(cs: Condition[], fig: Figure): { verdict: Verdict; unknown: Condition[] } {
  const item: ItemState = { seen: false };
  const unknown: Condition[] = [];
  let failed = false;
  for (const c of cs) {
    const v = evalCondition(c, fig, item);
    if (v === 'fail') failed = true;
    else if (v === 'unknown') unknown.push(c);
  }
  return { verdict: failed ? 'fail' : unknown.length ? 'unknown' : 'pass', unknown };
}

export function evaluateLayer(layer: Layer, fig: Figure): { verdict: Verdict; unknown: Condition[] } {
  const r = evalAll(layer.conditions, fig);
  // A layer that names a template ARG_* has no sprite until the template is expanded (deferred).
  if ('arg' in layer.ref && r.verdict === 'pass') return { verdict: 'unknown', unknown: r.unknown };
  return r;
}

export type GroupResult = {
  group: LayerGroup;
  chosen?: Layer;                                        // first layer whose conditions all pass
  unknown: { layer: Layer; conditions: Condition[] }[];  // layers that could not be evaluated
  maybeWrong: boolean;                                   // an unknown layer sits before the chosen one, or none was chosen
};

export function evaluateGroup(group: LayerGroup, fig: Figure): GroupResult {
  const res: GroupResult = { group, unknown: [], maybeWrong: false };
  // LG_CONDITION_BP is tier B: the whole group is unknown and draws nothing.
  const g = evalAll(group.conditions, fig);
  if (g.verdict !== 'pass') {
    if (g.verdict === 'unknown') {
      res.maybeWrong = true;
      res.unknown.push(...group.layers.map(layer => ({ layer, conditions: g.unknown })));
    }
    return res;
  }
  for (const layer of group.layers) {
    const r = evaluateLayer(layer, fig);
    if (r.verdict === 'pass') { res.chosen = layer; return res; }
    if (r.verdict === 'unknown') { res.unknown.push({ layer, conditions: r.unknown }); res.maybeWrong = true; }
  }
  return res;
}

export function evaluateSet(set: LayerSet, fig: Figure): GroupResult[] {
  return set.groups.map(g => evaluateGroup(g, fig));
}

export type Draw = { group: LayerGroup; layer: Layer; offset: [number, number] };
export type Composite = {
  set?: LayerSet;
  draws: Draw[];                 // in file order, bottom first
  results: GroupResult[];
  notes: string[];               // what was not composited or not evaluated
};

export function composite(lg: LayeredGraphics, fig: Figure): Composite {
  const set = pickSet(lg, fig);
  const out: Composite = { set, draws: [], results: [], notes: [] };
  if (!set) { out.notes.push(`no layer set for ${fig.age} ${fig.state}`); return out; }
  if (set.state === 'PORTRAIT') { out.notes.push('portrait sets are shown as art but not composited'); return out; }
  if (set.templateUse) out.notes.push(`USE_LAYER_SET_TEMPLATE:${set.templateUse.name} is not expanded`);
  out.results = evaluateSet(set, fig);
  out.results.forEach((r, i) => {
    if (r.chosen) out.draws.push({ group: r.group, layer: r.chosen, offset: r.group.offset ?? [0, 0] });
    if (!r.maybeWrong) return;
    const label = r.group.label ?? `group ${i + 1}`;
    const kinds = [...new Set(r.unknown.flatMap(u => u.conditions.map(c => c.kind)))].join(', ') || 'template art';
    out.notes.push(r.chosen ? `${label}: first match may be wrong (unevaluated: ${kinds})` : `${label}: nothing drawn, could not evaluate ${kinds}`);
  });
  return out;
}
