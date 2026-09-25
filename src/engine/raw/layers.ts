// Layered creature graphics: LAYER_SET / LAYER_GROUP / LAYER and their
// conditions, read as views over a creature block's tokens. Raws are flat and
// indentation is decorative, so the nesting is recovered by one scan in file
// order: each token attaches to the innermost open thing it belongs to, and a
// token the table does not know is kept verbatim on that thing (`unknown`).
// Nothing is copied or dropped: every token of the block is reachable from the
// result (see layeredTokens), and edits go through RawDocument's line-local ops.
import type { RawDocument } from './document.ts';
import type { Block } from './document.ts';
import type { RawNode, TokenNode } from './tokenize.ts';

export type LayerRef =
  | { page: string; rect: [number, number, number, number]; large: boolean }
  | { arg: string };                       // [LAYER:RIGHT_WING:ARG_RIGHT_WING_TEXTURE]

// A condition token and the TISSUE_* / BP_* tokens that refine it. Tier A is
// evaluated by the preview; tier B is kept and shown but evaluates to unknown.
// A condition is tier B when its own kind or any child is.
export type Condition = { token: TokenNode; kind: string; children: TokenNode[]; tier: 'A' | 'B' };

export type Layer = {
  token: TokenNode;
  name: string;
  ref: LayerRef;
  conditions: Condition[];
  palette?: { name: string; row: number } | 'FROM_ITEM';
  paletteToken?: TokenNode;
  unknown: TokenNode[];
};

export type LayerGroup = {
  token: TokenNode;
  label?: string;
  conditions: Condition[];
  permitted?: string;
  offset?: [number, number];
  attrs: TokenNode[];        // the LG_PERMITTED / LG_OFFSET tokens as written
  end?: TokenNode;           // END_LAYER_GROUP, when written
  layers: Layer[];
  unknown: TokenNode[];
};

export type LsPalette = {
  token: TokenNode;
  name: string;
  file?: string;
  defaultRow: number;
  fileToken?: TokenNode;
  defaultToken?: TokenNode;
  unknown: TokenNode[];
};

export type TemplateUse = { token: TokenNode; name: string; args: TokenNode[] };

export type LayerSet = {
  token: TokenNode;
  stage?: 'BABY' | 'CHILD';
  state: string;
  palettes: LsPalette[];
  groups: LayerGroup[];
  templateUse?: TemplateUse;
  unknown: TokenNode[];
};

// `simple` holds the tokens outside any layer set (the ones the template
// matcher understands, e.g. SKELETON); `sets` the layer sets in file order.
export type LayeredGraphics = { doc: RawDocument; block: Block; simple: TokenNode[]; sets: LayerSet[] };

const TIER_A = new Set([
  'CONDITION_CASTE', 'CONDITION_CHILD', 'CONDITION_NOT_CHILD', 'CONDITION_GHOST', 'CONDITION_SYN_CLASS',
  'CONDITION_PROFESSION_CATEGORY', 'CONDITION_ITEM_WORN', 'SHUT_OFF_IF_ITEM_PRESENT',
  'CONDITION_RANDOM_PART_INDEX', 'CONDITION_MATERIAL_FLAG', 'CONDITION_MATERIAL_TYPE', 'CONDITION_TISSUE_LAYER',
]);
const TIER_A_CHILDREN = new Set([
  'TISSUE_MAY_HAVE_COLOR', 'TISSUE_MIN_LENGTH', 'TISSUE_MAX_LENGTH', 'TISSUE_NOT_SHAPED', 'TISSUE_MAY_HAVE_SHAPING',
]);
// Conditions that own TISSUE_* / BP_* children.
const CHILD_OWNERS = new Set(['CONDITION_TISSUE_LAYER', 'CONDITION_BP', 'LG_CONDITION_BP']);

const isCondition = (k: string) => k.startsWith('CONDITION_') || k === 'SHUT_OFF_IF_ITEM_PRESENT';
const isChild = (k: string) => k.startsWith('TISSUE_') || k.startsWith('BP_');

// The group label is the last non-empty line of the text before LAYER_GROUP
// ("shadow", "head", "beard"). Text right after a token starts with that
// token's trailing comment, so its first line is skipped.
function labelBefore(nodes: RawNode[], i: number): string | undefined {
  const prev = nodes[i - 1];
  if (prev?.kind !== 'text') return undefined;
  const lines = prev.text.split(/\r?\n/);
  if (i - 1 > 0) lines.shift();
  for (let j = lines.length - 1; j >= 0; j--) {
    const s = lines[j].trim();
    if (s) return s;
  }
  return undefined;
}

const int = (s: string | undefined) => Number.parseInt(s ?? '', 10) || 0;

function layerRef(args: string[]): LayerRef {
  if (args.length === 3) return { arg: args[2] };
  if (args[3] === 'LARGE_IMAGE') return { page: args[2], rect: [int(args[4]), int(args[5]), int(args[6]), int(args[7])], large: true };
  if (args.length === 5) return { page: args[2], rect: [int(args[3]), int(args[4]), int(args[3]), int(args[4])], large: false };
  return { arg: args.slice(2).join(':') };
}

export function readLayered(doc: RawDocument, block: Block): LayeredGraphics {
  const at = new Map<RawNode, number>();
  doc.nodes.forEach((n, i) => { if (n.kind === 'token') at.set(n, i); });

  const out: LayeredGraphics = { doc, block, simple: [], sets: [] };
  let set: LayerSet | undefined;
  let pal: LsPalette | undefined;
  let group: LayerGroup | undefined;
  let layer: Layer | undefined;
  let cond: Condition | undefined;
  let use: TemplateUse | undefined;

  // Innermost open thing, for tokens that have no place of their own.
  const stray = (t: TokenNode) => (layer ?? group ?? pal ?? set)!.unknown.push(t);

  for (const t of block.children) {
    const k = t.args[0];
    if (k === 'LAYER_SET') {
      const staged = (t.args[1] === 'BABY' || t.args[1] === 'CHILD') && t.args.length > 2;
      set = { token: t, ...(staged ? { stage: t.args[1] as 'BABY' | 'CHILD' } : {}), state: t.args.slice(staged ? 2 : 1).join(':'), palettes: [], groups: [], unknown: [] };
      out.sets.push(set);
      pal = group = layer = cond = use = undefined;
      continue;
    }
    if (!set) { out.simple.push(t); continue; }

    if (use && k.startsWith('ARG_')) { use.args.push(t); continue; }
    use = undefined;

    if (k === 'LS_PALETTE') {
      pal = { token: t, name: t.args[1] ?? '', defaultRow: 0, unknown: [] };
      set.palettes.push(pal);
      group = layer = cond = undefined;
    } else if ((k === 'LS_PALETTE_FILE' || k === 'LS_PALETTE_DEFAULT') && pal && !group) {
      if (k === 'LS_PALETTE_FILE' && !pal.fileToken) { pal.fileToken = t; pal.file = t.args[1]; }
      else if (k === 'LS_PALETTE_DEFAULT' && !pal.defaultToken) { pal.defaultToken = t; pal.defaultRow = int(t.args[1]); }
      else pal.unknown.push(t);
    } else if (k === 'LAYER_GROUP') {
      group = { token: t, conditions: [], attrs: [], layers: [], unknown: [] };
      const label = labelBefore(doc.nodes, at.get(t)!);
      if (label) group.label = label;
      set.groups.push(group);
      pal = layer = cond = undefined;
    } else if (k === 'END_LAYER_GROUP') {
      if (group && !group.end) { group.end = t; group = layer = cond = undefined; }
      else stray(t);
    } else if (k === 'LG_PERMITTED' && group && !layer && group.permitted === undefined) {
      group.permitted = t.args[1] ?? '';
      group.attrs.push(t);
    } else if (k === 'LG_OFFSET' && group && !layer && !group.offset) {
      group.offset = [int(t.args[1]), int(t.args[2])];
      group.attrs.push(t);
    } else if (k === 'LG_CONDITION_BP' && group && !layer) {
      cond = { token: t, kind: k, children: [], tier: 'B' };
      group.conditions.push(cond);
    } else if (k === 'LAYER' && group) {
      layer = { token: t, name: t.args[1] ?? '', ref: layerRef(t.args), conditions: [], unknown: [] };
      group.layers.push(layer);
      cond = undefined;
    } else if (k === 'USE_LAYER_SET_TEMPLATE' && !set.templateUse) {
      use = { token: t, name: t.args[1] ?? '', args: [] };
      set.templateUse = use;
    } else if (layer && isCondition(k)) {
      cond = { token: t, kind: k, children: [], tier: TIER_A.has(k) ? 'A' : 'B' };
      layer.conditions.push(cond);
      if (!CHILD_OWNERS.has(k)) cond = undefined;
    } else if (layer && k === 'USE_PALETTE' && !layer.palette) {
      layer.palette = { name: t.args[1] ?? '', row: int(t.args[2]) };
      layer.paletteToken = t;
    } else if (layer && k === 'USE_STANDARD_PALETTE_FROM_ITEM' && !layer.palette) {
      layer.palette = 'FROM_ITEM';
      layer.paletteToken = t;
    } else if (cond && isChild(k)) {
      cond.children.push(t);
      if (!TIER_A_CHILDREN.has(k)) cond.tier = 'B';
    } else {
      stray(t);
    }
  }
  return out;
}

function refArgs(name: string, ref: LayerRef): string[] {
  if ('arg' in ref) return ['LAYER', name, ref.arg];
  const [x1, y1, x2, y2] = ref.rect;
  return ref.large ? ['LAYER', name, ref.page, 'LARGE_IMAGE', String(x1), String(y1), String(x2), String(y2)]
                    : ['LAYER', name, ref.page, String(x1), String(y1)];
}

// The document-order-last token this layer owns (its own LAYER line unless a
// palette/condition/unknown token of its was written after it -- true for
// almost every real layer, which is exactly the case addLayer must anchor
// after: inserting right after just the bare LAYER line, as a bug fixed here
// used to, splices the new layer's tokens *before* the last layer's own
// trailing USE_PALETTE/CONDITION_* lines, which the next readLayered() call
// then reattaches to the new layer instead -- silently emptying the sibling
// copyFrom was cloning and duplicating its conditions onto the new layer).
function layerTailToken(doc: RawDocument, layer: Layer): TokenNode {
  const candidates: TokenNode[] = [layer.token, ...layer.unknown];
  if (layer.paletteToken) candidates.push(layer.paletteToken);
  for (const c of layer.conditions) candidates.push(c.token, ...c.children);
  let best = candidates[0], bestIdx = doc.nodes.indexOf(best);
  for (const t of candidates) { const i = doc.nodes.indexOf(t); if (i > bestIdx) { best = t; bestIdx = i; } }
  return best;
}

// Adds a new layer to a group, on a new line after its last layer (or the
// group's header/attrs when it has none). With `copyFrom`, the new layer's
// palette and conditions are cloned from that sibling verbatim (each a fresh
// TokenNode, so editing one later never touches the sibling's own tokens) --
// the caller can then change any one condition's `token.args` in place, for
// a "copy a sibling's conditions, change one" workflow.
// Nothing existing moves, so a document with no addLayer call round-trips
// byte-identical (npm run roundtrip is unaffected by construction).
export function addLayer(doc: RawDocument, group: LayerGroup, name: string, ref: LayerRef, copyFrom?: Layer): Layer {
  const lastLayer = group.layers[group.layers.length - 1];
  const after = (lastLayer && layerTailToken(doc, lastLayer))
    ?? group.attrs[group.attrs.length - 1]
    ?? group.token;
  let last = doc.insertAfter(after, refArgs(name, ref));
  const layer: Layer = { token: last, name, ref, conditions: [], unknown: [] };

  if (copyFrom?.palette === 'FROM_ITEM') {
    last = doc.insertAfter(last, ['USE_STANDARD_PALETTE_FROM_ITEM']);
    layer.palette = 'FROM_ITEM';
    layer.paletteToken = last;
  } else if (copyFrom?.palette) {
    last = doc.insertAfter(last, ['USE_PALETTE', copyFrom.palette.name, String(copyFrom.palette.row)]);
    layer.palette = { ...copyFrom.palette };
    layer.paletteToken = last;
  }
  for (const c of copyFrom?.conditions ?? []) {
    last = doc.insertAfter(last, [...c.token.args]);
    const cond: Condition = { token: last, kind: c.kind, children: [], tier: c.tier };
    for (const ch of c.children) { last = doc.insertAfter(last, [...ch.args]); cond.children.push(last); }
    layer.conditions.push(cond);
  }
  group.layers.push(layer);
  return layer;
}

// Adds a new palette row: LS_PALETTE_DEFAULT is the only per-row raw token
// (the colours themselves live in the palette PNG, per the design note's
// "5. Palette rows" -- USE_PALETTE:<name>:<row> just names a row index), so
// this only bumps `doc` when `makeDefault` asks the set to point at the new
// row; the pixels go through layered/pixels.ts's addPaletteRow instead.
export function setPaletteDefaultRow(doc: RawDocument, pal: LsPalette, row: number): void {
  if (pal.defaultToken) { pal.defaultToken.args = ['LS_PALETTE_DEFAULT', String(row)]; }
  else { pal.defaultToken = doc.insertAfter(pal.fileToken ?? pal.token, ['LS_PALETTE_DEFAULT', String(row)]); }
  pal.defaultRow = row;
}

// Every token the views hold, in no particular order. Used to check that
// building the views dropped nothing: it must equal the block's tokens.
export function layeredTokens(lg: LayeredGraphics): TokenNode[] {
  const all: TokenNode[] = [...lg.simple];
  const conds = (cs: Condition[]) => cs.forEach(c => all.push(c.token, ...c.children));
  for (const s of lg.sets) {
    all.push(s.token, ...s.unknown);
    if (s.templateUse) all.push(s.templateUse.token, ...s.templateUse.args);
    for (const p of s.palettes) {
      all.push(p.token, ...p.unknown);
      if (p.fileToken) all.push(p.fileToken);
      if (p.defaultToken) all.push(p.defaultToken);
    }
    for (const g of s.groups) {
      all.push(g.token, ...g.attrs, ...g.unknown);
      if (g.end) all.push(g.end);
      conds(g.conditions);
      for (const l of g.layers) {
        all.push(l.token, ...l.unknown);
        if (l.paletteToken) all.push(l.paletteToken);
        conds(l.conditions);
      }
    }
  }
  return all;
}
