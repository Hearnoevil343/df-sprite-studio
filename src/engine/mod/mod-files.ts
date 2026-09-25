// The files of an exported mod, and reading a mod folder back into a project.
//
//   info.txt                                   mod info
//   preview.png                                strip of each creature's first sprite
//   studio.json                                studio sidecar (palette, lock, template choices)
//   graphics/graphics_<id>_creatures.txt       TILE_PAGE plus one creature block each
//   graphics/images/<id>_creatures.png         the packed sheet
//
// Raw file and tile page names carry the mod id: DF treats a same-named raw
// file in a later mod as a replacement, and tile page ids are global.
import { encodeString, decodeBytes } from '../raw/tokenize.ts';
import { RawDocument, TilePage } from '../raw/document.ts';
import { readLayered } from '../raw/layers.ts';
import type { LayeredGraphics } from '../raw/layers.ts';
import type { PageImages } from '../layered/pixels.ts';
import { activeEntries, applyTemplate, resolveEntries, templateById, TEMPLATES } from '../templates/template.ts';
import type { EntrySizes, SpriteTemplate } from '../templates/template.ts';
import { createImage, getPixel, setPixel } from '../image/pixels.ts';
import type { Rgba, RgbaImage } from '../image/pixels.ts';
import { crop } from '../image/crop.ts';
import type { Palette } from '../palette/palette.ts';
import { TILE, isBlank, packSheet, sliceSheet } from '../sheet/pack.ts';
import type { SheetCreature } from '../sheet/pack.ts';
import { tileSpan } from '../sheet/sprite-rects.ts';
import { infoTxt, modId, parseInfoTxt } from './info-txt.ts';
import type { ModInfo } from './info-txt.ts';

export type ModCreature = SheetCreature & { id: string; caste?: string };
// A creature block drawn with layer sets. Kept whole (views over the file's
// tokens) rather than matched to a template; edited as layers.
export type LayeredCreature = { id: string; caste?: string; path: string; graphics: LayeredGraphics };
export type ModProject = { mod: ModInfo; palette: Palette; paletteLocked: boolean; customColours: Rgba[]; creatures: ModCreature[] };

// A file relative to the mod folder: raw bytes, or an image the app encodes
// to (or decoded from) PNG. Paths use forward slashes.
export type ModFile = { path: string; bytes?: Uint8Array; image?: RgbaImage };

export const STUDIO_FILE = 'studio.json';
const EOL = '\r\n';

type StudioCreature = { id: string; caste?: string; templateId: string; include: string[]; omit: string[]; sizes?: EntrySizes; origin: [number, number] };
type StudioJson = {
  app: 'df-sprite-studio';
  format: 1;
  mod: ModInfo;
  palette: Palette;
  paletteLocked: boolean;
  customColours?: Rgba[];
  sheet: string;
  creatures: StudioCreature[];
};

export function modPaths(id: string): { raw: string; sheet: string; page: string } {
  const m = modId(id);
  return { raw: `graphics/graphics_${m}_creatures.txt`, sheet: `graphics/images/${m}_creatures.png`, page: `${m.toUpperCase()}_CREATURES` };
}

const drawn = (c: ModCreature, key: string): boolean => !!c.sprites[key] && !isBlank(c.sprites[key]);

// Entries written for a creature: its active entries that have a non-blank sprite.
function drawnOmit(t: SpriteTemplate, c: ModCreature): string[] {
  return [...c.omit, ...activeEntries(t, c).filter(e => !drawn(c, e.key)).map(e => e.key)];
}

export function creaturesRaw(creatures: ModCreature[], origins: [number, number][], pagePixels: [number, number], id: string): RawDocument {
  const p = modPaths(id);
  const doc = RawDocument.parse(`${p.raw.slice('graphics/'.length, -'.txt'.length)}${EOL}${EOL}[OBJECT:GRAPHICS]${EOL}`);
  const page = new TilePage(doc, doc.appendBlock(['TILE_PAGE', p.page], [['FILE', p.sheet.slice('graphics/'.length)]]));
  page.tileDim = [TILE, TILE];
  page.pageDimPixels = pagePixels;
  creatures.forEach((c, i) => {
    const t = templateById(c.templateId)!;
    const omit = drawnOmit(t, c);
    if (!activeEntries(t, { include: c.include, omit }).length) return;
    const [x, y] = origins[i];
    applyTemplate(doc, t, { creature: c.id, caste: c.caste, page: p.page, x, y, include: c.include, omit, sizes: c.sizes });
  });
  return doc;
}

// Each creature's first drawn sprite, bottom-aligned in a row on a dark
// background, scaled up. At most 8 creatures.
export function previewImage(creatures: ModCreature[], scale = 4): RgbaImage {
  const shots: RgbaImage[] = [];
  for (const c of creatures) {
    const t = templateById(c.templateId);
    const e = t && activeEntries(t, c).find(e => drawn(c, e.key));
    if (e) shots.push(c.sprites[e.key]);
    if (shots.length === 8) break;
  }
  const pad = 4;
  const cellW = Math.max(TILE, ...shots.map(s => s.width));
  const cellH = Math.max(TILE, ...shots.map(s => s.height));
  const w = Math.max(1, shots.length) * (cellW + pad) + pad, h = cellH + 2 * pad;
  const out = createImage(w * scale, h * scale);
  const bg: Rgba = [44, 44, 44, 255];
  for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) setPixel(out, x, y, bg);
  shots.forEach((s, i) => {
    const ox = pad + i * (cellW + pad) + Math.floor((cellW - s.width) / 2), oy = pad + cellH - s.height;
    for (let y = 0; y < s.height; y++) for (let x = 0; x < s.width; x++) {
      const c = getPixel(s, x, y);
      if (c[3] === 0) continue;
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) setPixel(out, (ox + x) * scale + dx, (oy + y) * scale + dy, c);
    }
  });
  return out;
}

export function modFiles(project: ModProject): ModFile[] {
  for (const c of project.creatures) if (!templateById(c.templateId)) throw new Error(`${c.id}: unknown template ${c.templateId}`);
  const p = modPaths(project.mod.id);
  const packed = packSheet(project.creatures);
  const raw = creaturesRaw(project.creatures, packed.origins, [packed.image.width, packed.image.height], project.mod.id);
  const studio: StudioJson = {
    app: 'df-sprite-studio',
    format: 1,
    mod: project.mod,
    palette: project.palette,
    paletteLocked: project.paletteLocked,
    ...(project.customColours.length ? { customColours: project.customColours } : {}),
    sheet: p.sheet,
    creatures: project.creatures.map((c, i) => ({
      id: c.id, ...(c.caste ? { caste: c.caste } : {}), templateId: c.templateId, include: c.include, omit: c.omit,
      ...(c.sizes && Object.keys(c.sizes).length ? { sizes: c.sizes } : {}), origin: packed.origins[i],
    })),
  };
  return [
    { path: 'info.txt', bytes: encodeString(infoTxt(project.mod, EOL)) },
    { path: 'preview.png', image: previewImage(project.creatures) },
    { path: STUDIO_FILE, bytes: new TextEncoder().encode(JSON.stringify(studio, null, 1)) },
    { path: p.raw, bytes: raw.toBytes() },
    { path: p.sheet, image: packed.image },
  ];
}

// ---- layered creatures ----
//
// Layered creatures aren't rebuilt from a template + packSheet like
// ModCreature (design note, "6. Page-backed sprites"): a layered creature's
// art lives in the page PNG its raws already point at, and readMod kept the
// creature's own RawDocument whole (LayeredCreature.graphics.doc), so
// exporting one is "write back the doc, plus whichever page images actually
// changed" rather than generating a new sheet and raw file.

// One ModFile per distinct raw file the given layered creatures came from,
// re-serialized from its (possibly edited) RawDocument, at a flat
// graphics/<name> path -- a mod is its own folder, not vanilla's, which (per
// LayeredCreature.path, e.g. "vanilla_creatures_graphics/graphics/
// graphics_creatures_dwarf.txt" on a real install) nests raws under one
// sub-object folder per vanilla "mod"; only the file's own name carries over,
// matching modPaths()/readMod's "graphics/<file>" convention for every other
// raw and page path. A file nothing added a layer/condition/palette row to
// comes back byte-identical (readLayered never mutates, and the edit ops
// only ever insert/append new lines), so this is exactly "unchanged raws
// stay byte-identical" for the layered path.
export function layeredRawFiles(layered: LayeredCreature[]): ModFile[] {
  const docs = new Map<string, RawDocument>();
  for (const c of layered) {
    const path = `graphics/${c.path.split('/').pop()}`;
    if (!docs.has(path)) docs.set(path, c.graphics.doc);
  }
  return [...docs].map(([path, doc]) => ({ path, bytes: doc.toBytes() }));
}

// Page id -> the mod-relative path (readMod's own "graphics/${tp.file}"
// convention, also used to resolve a template creature's TILE_PAGE) its FILE
// token names -- flat, not nested under the source raw's vanilla directory,
// for the same reason as layeredRawFiles above.
export function layeredPageFilePaths(layered: LayeredCreature[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of layered) {
    for (const tp of c.graphics.doc.tilePages()) {
      if (!tp.file || out.has(tp.id)) continue;
      out.set(tp.id, `graphics/${tp.file}`);
    }
  }
  return out;
}

// Every TILE_PAGE the mod defines, across all of its graphics raws. A mod
// often keeps its pages in a file of their own (tile_page_*.txt) away from
// the creature blocks that use them, so a layered creature's own document is
// not enough to resolve its page images.
export function modTilePages(files: ModFile[]): TilePage[] {
  const out: TilePage[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const path = f.path.replace(/\\/g, '/');
    if (!/^graphics\/[^/]+\.txt$/i.test(path) || !f.bytes) continue;
    for (const tp of RawDocument.fromBytes(f.bytes).tilePages()) if (!seen.has(tp.id)) { seen.add(tp.id); out.push(tp); }
  }
  return out;
}

function sameImage(a: RgbaImage, b: RgbaImage): boolean {
  if (a.width !== b.width || a.height !== b.height) return false;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false;
  return true;
}

// Every page whose pixels differ from `originals` (a snapshot taken when the
// pages were loaded, e.g. with cloneImage per page right after
// buildPageImages), as a ModFile at its resolved path -- "write changed page
// PNGs" without re-writing every page a mod's session merely opened.
export function changedPageFiles(pages: PageImages, originals: PageImages, pageFiles: Map<string, string>): ModFile[] {
  const out: ModFile[] = [];
  for (const [id, cur] of pages) {
    const orig = originals.get(id);
    const path = pageFiles.get(id);
    if (!path || (orig && sameImage(orig.image, cur.image))) continue;
    out.push({ path, image: cur.image });
  }
  return out;
}

export type ReadModResult = {
  mod: ModInfo;
  palette?: Palette;        // only from studio.json
  paletteLocked?: boolean;
  customColours?: Rgba[];   // only from studio.json
  creatures: ModCreature[];
  layered: LayeredCreature[];
  warnings: string[];
};

// Reads a mod folder back. With studio.json (a mod this app exported) the
// template choices and layout come from it and the sprites are sliced from
// the sheet. Without it, each creature block in the graphics raws is matched
// against the templates; blocks no template describes are skipped with a
// warning (conditional graphics, for example). Blocks with layer sets are kept
// as layered creatures.
export function readMod(files: ModFile[]): ReadModResult {
  const byPath = new Map(files.map(f => [f.path.replace(/\\/g, '/').toLowerCase(), f]));
  const file = (path: string) => byPath.get(path.toLowerCase());
  const info = file('info.txt')?.bytes;
  const warnings: string[] = [];
  let mod: ModInfo = info ? parseInfoTxt(decodeBytes(info)) : { id: '', name: '', version: '1', author: '', description: '' };

  const studioBytes = file(STUDIO_FILE)?.bytes;
  if (studioBytes) {
    const studio = JSON.parse(new TextDecoder().decode(studioBytes)) as StudioJson;
    if (studio.app === 'df-sprite-studio' && studio.format === 1) {
      const sheet = file(studio.sheet)?.image;
      if (!sheet) warnings.push(`${studio.sheet} missing; sprites left blank`);
      const creatures: ModCreature[] = [];
      for (const sc of studio.creatures) {
        const t = templateById(sc.templateId);
        if (!t) { warnings.push(`${sc.id}: unknown template ${sc.templateId}, skipped`); continue; }
        const [ox, oy] = sc.origin;
        const rects = resolveEntries(t, sc).map(e => {
          const [w, h] = e.size;
          return { key: e.key, rect: { x: (ox + e.at[0]) * TILE, y: (oy + e.at[1]) * TILE, w: w * TILE, h: h * TILE } };
        });
        creatures.push({
          id: sc.id, ...(sc.caste ? { caste: sc.caste } : {}), templateId: sc.templateId,
          include: [...sc.include], omit: [...sc.omit], ...(sc.sizes ? { sizes: sc.sizes } : {}),
          sprites: sheet ? sliceSheet(sheet, rects) : {},
        });
      }
      return { mod: studio.mod, palette: studio.palette, paletteLocked: studio.paletteLocked, customColours: studio.customColours, creatures, layered: [], warnings };
    }
    warnings.push(`${STUDIO_FILE} not from this app or a newer format; reading raws instead`);
  }

  const creatures: ModCreature[] = [];
  const layered: LayeredCreature[] = [];
  for (const f of files) {
    const path = f.path.replace(/\\/g, '/');
    if (!/^graphics\/[^/]+\.txt$/i.test(path) || !f.bytes) continue;
    const doc = RawDocument.fromBytes(f.bytes);
    const pages = new Map(doc.tilePages().map(tp => [tp.id, tp]));
    for (const cg of doc.creatureGraphics()) {
      const lg = readLayered(doc, cg.block);
      if (lg.sets.length) {
        layered.push({ id: cg.creatureId, ...(cg.caste ? { caste: cg.caste } : {}), path, graphics: lg });
        continue;
      }
      const found = matchTemplate(cg.kind.replace('_CASTE_GRAPHICS', '_GRAPHICS'), cg.entries.map(e => e.args), cg.isStatue);
      const name = cg.caste ? `${cg.creatureId}:${cg.caste}` : cg.creatureId;
      if (!found) { warnings.push(`${name} (${path}): no template matches any of its entries, skipped`); continue; }
      if (found.extra.length) warnings.push(`${name} (${path}): ${found.extra.map(e => e[0]).join(', ')} not part of the ${found.template.id} template; editable sprites loaded, those lines are dropped on export`);
      const sprites: Record<string, RgbaImage> = {};
      for (const [key, args] of found.keys) {
        const tp = pages.get(args[1]);
        const img = tp?.file ? file(`graphics/${tp.file}`)?.image : undefined;
        if (!img) { warnings.push(`${name}: page ${args[1]} image not found`); continue; }
        const [tw, th] = tp!.tileDim ?? [TILE, TILE];
        const [x1, y1, x2, y2] = tileSpan(args, cg.isStatue)!;
        const sprite = crop(img, { x: x1 * tw, y: y1 * th, w: (x2 - x1 + 1) * tw, h: (y2 - y1 + 1) * th });
        if (!isBlank(sprite)) sprites[key] = sprite;
      }
      creatures.push({
        id: cg.creatureId, ...(cg.caste ? { caste: cg.caste } : {}), templateId: found.template.id,
        include: found.template.entries.filter(e => e.default === false && found.keys.has(e.key)).map(e => e.key),
        omit: found.template.entries.filter(e => e.default !== false && !found.keys.has(e.key)).map(e => e.key),
        ...(Object.keys(found.sizes).length ? { sizes: found.sizes } : {}),
        sprites,
      });
    }
  }
  if (!mod.id && !creatures.length && !layered.length) warnings.push('no info.txt and no creatures found; is this a mod folder?');
  mod = { ...mod, version: mod.version || '1' };
  return { mod, creatures, layered, warnings };
}

// Token plus arguments after the coordinates, e.g. "CHILD|AS_IS|DEFAULT".
// Exported for the finder (find/missing.ts), which matches template entries
// against raw graphics entries the same way readMod does.
export function entrySignature(args: string[], isStatue: boolean): { sig: string; span: [number, number] } | null {
  const span = tileSpan(args, isStatue);
  if (!span) return null;
  let rest = args.slice(2);
  let n = 2;
  if (rest[0] === 'LARGE_IMAGE') { rest = rest.slice(1); n = 4; } else if (isStatue && rest.length >= 4) n = 4;
  return { sig: [args[0], ...rest.slice(n)].join('|'), span: [span[2] - span[0] + 1, span[3] - span[1] + 1] };
}

function matchTemplate(header: string, entries: string[][], isStatue: boolean): { template: SpriteTemplate; keys: Map<string, string[]>; sizes: EntrySizes; extra: string[][] } | null {
  // Modders lay a creature block out in many ways, so a template is a best
  // fit rather than an exact one: score every template by how many entries it
  // claims, keep the best, and hand back whatever it could not place (a
  // LIST_ICON, say) so the caller can warn about it. An entry whose token
  // matches at a different tile span still counts, recorded as a size
  // override (the 8-2 size picker), but scores below an exact fit.
  type Fit = { template: SpriteTemplate; keys: Map<string, string[]>; sizes: EntrySizes; extra: string[][]; score: number };
  let best: Fit | null = null;
  for (const t of TEMPLATES) {
    if (t.header !== header || !entries.length) continue;
    const keys = new Map<string, string[]>();
    const sizes: EntrySizes = {};
    const extra: string[][] = [];
    let score = 0;
    for (const args of entries) {
      const s = entrySignature(args, isStatue);
      const sig = (e: SpriteTemplate['entries'][number]) => [e.token, ...(e.suffix ?? [])].join('|');
      const fits = (e: SpriteTemplate['entries'][number]) => (e.size ?? [1, 1])[0] === s!.span[0] && (e.size ?? [1, 1])[1] === s!.span[1];
      const free = s ? t.entries.filter(e => !keys.has(e.key) && sig(e) === s.sig) : [];
      const e = free.find(fits) ?? (t.rect === 'LARGE_IMAGE' ? free[0] : undefined);
      if (!e) { extra.push(args); continue; }
      keys.set(e.key, args);
      if (fits(e)) score += 2; else { sizes[e.key] = s!.span; score += 1; }
    }
    if (!keys.size) continue;
    if (!best || score > best.score || (score === best.score && extra.length < best.extra.length)) best = { template: t, keys, sizes, extra, score };
  }
  return best;
}
