// Sprite templates: JSON descriptions of a creature graphics block, turned
// into raw tokens and appended through RawDocument.appendBlock.

import type { Block, RawDocument } from '../raw/document.ts';
import simpleCreature from './simple-creature.json' with { type: 'json' };
import vermin from './vermin.json' with { type: 'json' };
import multiTileCreature from './multi-tile-creature.json' with { type: 'json' };
import statue from './statue.json' with { type: 'json' };

export type TemplateEntry = {
  key: string;             // unique within the template
  token: string;           // raw token name (DEFAULT, CHILD, VERMIN, ...)
  at: [number, number];    // tile offset from the sprite origin
  size?: [number, number]; // tiles; default 1x1
  suffix?: string[];       // arguments after the coordinates
  requires?: string;       // key that must be present (CHILD needs its parent)
  default?: boolean;       // false: only written when listed in include
  note?: string;
};

export type SpriteTemplate = {
  id: string;
  name: string;
  description: string;
  header: string;          // CREATURE_GRAPHICS or STATUE_CREATURE_GRAPHICS
  rect: 'LARGE_IMAGE' | 'plain'; // how sprites larger than one tile are written
  entries: TemplateEntry[];
};

export type TemplateParams = {
  creature: string;
  caste?: string;          // writes the *_CASTE_GRAPHICS header
  page: string;            // TILE_PAGE id
  x?: number;              // origin tile, default 0:0
  y?: number;
  include?: string[];      // keys of entries that are off by default
  omit?: string[];         // keys to leave out
  sizes?: EntrySizes;      // per-entry size override (8-2 size picker)
};

// Per-entry size override, tiles, keyed by TemplateEntry.key. Only entries of
// a `rect: 'LARGE_IMAGE'` template can be resized this way; a `plain`
// template's entries keep their fixed template size.
export type EntrySizes = Record<string, [number, number]>;

export type ResolvedEntry = TemplateEntry & { at: [number, number]; size: [number, number] };

export const TEMPLATES: SpriteTemplate[] = [simpleCreature, vermin, multiTileCreature, statue] as SpriteTemplate[];

export function templateById(id: string): SpriteTemplate | undefined {
  return TEMPLATES.find(t => t.id === id);
}

// Entries actually written for a given include/omit choice, in template
// order, honouring `requires` chains (CHILD entries need their parent kept).
// Shared by buildTemplate and the app's sprite checklist, so both
// agree on which entries are "on" for a creature.
export function activeEntries(t: SpriteTemplate, p: Pick<TemplateParams, 'include' | 'omit'>): TemplateEntry[] {
  const kept = new Set<string>();
  const out: TemplateEntry[] = [];
  for (const e of t.entries) {
    const on = e.default === false ? !!p.include?.includes(e.key) : !p.omit?.includes(e.key);
    if (!on || (e.requires && !kept.has(e.requires))) continue;
    kept.add(e.key);
    out.push(e);
  }
  return out;
}

// Tiles spanned by every entry of the template, on or off, at its own
// (unresized) template size -- the layout's original footprint, used both as
// the packer's per-creature band height and as resolveEntries' shelf width.
export function templateFootprint(t: SpriteTemplate): [number, number] {
  let w = 1, h = 1;
  for (const e of t.entries) {
    const [sw, sh] = e.size ?? [1, 1];
    w = Math.max(w, e.at[0] + sw);
    h = Math.max(h, e.at[1] + sh);
  }
  return [w, h];
}

// Active entries with any size overrides applied and `at` recomputed.
// With no overrides, returns the template's own `at`/`size`
// values unchanged (so an un-resized creature packs/writes byte-identically).
// With any override, lays every active entry out on a shelf in template
// order: left to right, wrapping at a fixed band width (the template's own
// footprint, or the widest entry, whichever is larger).
export function resolveEntries(t: SpriteTemplate, p: Pick<TemplateParams, 'include' | 'omit'> & { sizes?: EntrySizes }): ResolvedEntry[] {
  const entries = activeEntries(t, p);
  const sizes = p.sizes;
  const hasOverride = t.rect === 'LARGE_IMAGE' && !!sizes && entries.some(e => sizes[e.key]);
  if (!hasOverride) return entries.map(e => ({ ...e, size: e.size ?? [1, 1] }));
  const [footprintW] = templateFootprint(t);
  const widest = Math.max(...entries.map(e => (sizes![e.key] ?? e.size ?? [1, 1])[0]));
  const bandWidth = Math.max(footprintW, widest);
  let x = 0, y = 0, rowH = 0;
  const out: ResolvedEntry[] = [];
  for (const e of entries) {
    const size = (sizes![e.key] ?? e.size ?? [1, 1]) as [number, number];
    if (x > 0 && x + size[0] > bandWidth) { x = 0; y += rowH; rowH = 0; }
    out.push({ ...e, at: [x, y], size });
    x += size[0];
    rowH = Math.max(rowH, size[1]);
  }
  return out;
}

// Header and child token arguments, in file order.
export function buildTemplate(t: SpriteTemplate, p: TemplateParams): { header: string[]; children: string[][] } {
  const ox = p.x ?? 0, oy = p.y ?? 0;
  const header = p.caste
    ? [t.header.replace(/_GRAPHICS$/, '_CASTE_GRAPHICS'), p.creature, p.caste]
    : [t.header, p.creature];
  const children: string[][] = [];
  for (const e of resolveEntries(t, p)) {
    const [w, h] = e.size;
    const x = ox + e.at[0], y = oy + e.at[1];
    const coords = w === 1 && h === 1 ? [x, y] : [x, y, x + w - 1, y + h - 1];
    const rect = coords.length === 4 && t.rect === 'LARGE_IMAGE' ? ['LARGE_IMAGE'] : [];
    children.push([e.token, p.page, ...rect, ...coords.map(String), ...(e.suffix ?? [])]);
  }
  return { header, children };
}

export function applyTemplate(doc: RawDocument, t: SpriteTemplate, p: TemplateParams): Block {
  const { header, children } = buildTemplate(t, p);
  return doc.appendBlock(header, children);
}
