// Structural validation of a mod's graphics raws and info.txt: the checks DF
// itself would fail on (or silently misbehave from), so they surface before
// export or in-game.
import { RawDocument } from '../raw/document.ts';
import { decodeBytes } from '../raw/tokenize.ts';
import { readCreatures } from '../raw/creatures.ts';
import { readLayered } from '../raw/layers.ts';
import type { LayerRef } from '../raw/layers.ts';
import { crop } from '../image/crop.ts';
import { tileRect } from '../layered/pixels.ts';
import { tileSpan } from '../sheet/sprite-rects.ts';
import { isBlank } from '../sheet/pack.ts';
import { parseInfoTxt } from '../mod/info-txt.ts';
import type { ModFile } from '../mod/mod-files.ts';
import type { Issue } from './issue.ts';

// Vanilla facts derived by tools/vanilla-index.ts: which creature ids exist
// (with their castes and flags), every tile page id, every graphics raw file
// name, and every token seen inside a graphics block.
export type VanillaIndex = {
  creatures: Record<string, { castes: string[]; flags: string[] }>;
  tilePageIds: string[];
  graphicsFiles: string[];
  tokens: string[];
};

const CHILD_PARENTS = new Set(['DEFAULT', 'ANIMATED', 'CORPSE']);

function textFiles(files: ModFile[]): (ModFile & { bytes: Uint8Array })[] {
  return files.filter((f): f is ModFile & { bytes: Uint8Array } => !!f.bytes && /\.txt$/i.test(f.path));
}

// A layered block's entries are LAYER_SET/LAYER_GROUP/LAYER/CONDITION_*/...,
// not the flat "token:page:x:y" sprite entries the generic loop below
// expects -- reading cg.entries[i].args[1] as a page id there matched a
// layer's own *name* instead (e.g. LAYER:SHADOW:...  -> page "SHADOW"),
// misfiring page-unknown on every layer. readLayered recovers the real
// per-layer refs, so only those (page, rect) pairs get the page/rect/blank
// checks a template creature's entries get.
//
// Unlike a template creature (which always ships a freshly packed page), a
// mod overriding one layered creature legitimately reuses a page declared in
// a *different vanilla file it never ships* -- e.g. DWARF's WIELDABLES page
// lives in tile_page_creatures.txt, not graphics_creatures_dwarf.txt (design
// note, "1. Data model"), and DF loads vanilla and the mod together, so the
// mod doesn't need to redeclare it. `known.tilePageIds` (survey of every
// vanilla page id, already unused elsewhere) is the fallback: only a page id
// this mod doesn't define *and* vanilla doesn't either is actually an error.
// A page resolved only through that fallback has no local image to check
// bounds/blank against, so it's silently skipped rather than misreported.
function checkLayeredBlock(doc: RawDocument, cg: ReturnType<RawDocument['creatureGraphics']>[number], file: string,
  pages: Map<string, { tp: ReturnType<RawDocument['tilePages']>[number]; file: string }>, byPath: Map<string, ModFile>, known: VanillaIndex): Issue[] {
  const issues: Issue[] = [];
  const name = cg.caste ? `${cg.creatureId}:${cg.caste}` : cg.creatureId;
  const lg = readLayered(doc, cg.block);
  for (const set of lg.sets) {
    for (const group of set.groups) {
      for (const layer of group.layers) {
        if (!('page' in layer.ref)) continue; // ARG_* art, no page to check
        const ref = layer.ref as Extract<LayerRef, { page: string }>;
        const tp = pages.get(ref.page)?.tp;
        if (!tp) {
          if (!known.tilePageIds.includes(ref.page)) {
            issues.push({ rule: 'page-unknown', severity: 'error', message: `${name}: layer ${layer.name} uses page ${ref.page}, not defined anywhere in this mod or vanilla`, file, creature: cg.creatureId, caste: cg.caste, key: layer.name });
          }
          continue;
        }
        const [tw, th] = tp.tileDim ?? [32, 32];
        const rect = tileRect(ref, [tw, th]);
        const imgFile = tp.file ? byPath.get(`graphics/${tp.file}`.replace(/\\/g, '/')) : undefined;
        if (!imgFile?.image) continue;
        if (rect.w <= 0 || rect.h <= 0 || rect.x < 0 || rect.y < 0 || rect.x + rect.w > imgFile.image.width || rect.y + rect.h > imgFile.image.height) {
          issues.push({ rule: 'rect-bounds', severity: 'error', message: `${name}: layer ${layer.name} sits outside page ${ref.page}`, file, creature: cg.creatureId, caste: cg.caste, key: layer.name });
        } else if (isBlank(crop(imgFile.image, rect))) {
          issues.push({ rule: 'rect-blank', severity: 'error', message: `${name}: layer ${layer.name} rect is fully transparent`, file, creature: cg.creatureId, caste: cg.caste, key: layer.name });
        }
      }
    }
  }
  return issues;
}

function checkInfoTxt(files: ModFile[]): Issue[] {
  const issues: Issue[] = [];
  const info = files.find(f => f.path.toLowerCase() === 'info.txt');
  if (!info?.bytes) return [{ rule: 'info-missing', severity: 'error', message: 'info.txt is missing' }];
  const src = decodeBytes(info.bytes);
  const parsed = parseInfoTxt(src);
  for (const field of ['id', 'name', 'author', 'description'] as const) {
    if (!parsed[field]) issues.push({ rule: 'info-field', severity: 'error', message: `info.txt: ${field.toUpperCase()} is empty`, file: 'info.txt' });
  }
  if (parsed.id && !/^[a-z0-9_]+$/.test(parsed.id)) {
    issues.push({ rule: 'info-id', severity: 'error', message: `info.txt: ID "${parsed.id}" has characters that make other mods fail to load`, file: 'info.txt', value: parsed.id });
  }
  const numericVersion = RawDocument.parse(src).tokens().find(t => t.args[0] === 'NUMERIC_VERSION')?.args[1];
  if (!numericVersion || !/^\d+$/.test(numericVersion)) {
    issues.push({ rule: 'info-numeric-version', severity: 'error', message: `info.txt: NUMERIC_VERSION "${numericVersion ?? ''}" is not a whole number`, file: 'info.txt', value: numericVersion });
  }
  return issues;
}

export function validateMod(files: ModFile[], known: VanillaIndex): Issue[] {
  const issues: Issue[] = [...checkInfoTxt(files)];
  const byPath = new Map(files.map(f => [f.path.replace(/\\/g, '/'), f]));
  const localCreatures = new Set<string>(Object.keys(known.creatures));
  const raws = textFiles(files).map(f => ({ file: f, doc: RawDocument.fromBytes(f.bytes) }));

  // Tile pages can live in their own OBJECT:TILE_PAGE file, separate from the
  // OBJECT:GRAPHICS files that reference them by id (as vanilla does), so
  // they're resolved across the whole mod, not just the current file.
  const pages = new Map<string, { tp: ReturnType<RawDocument['tilePages']>[number]; file: string }>();
  for (const { file: f, doc } of raws) {
    if (doc.objectType() === 'CREATURE') for (const def of readCreatures(doc, f.path)) localCreatures.add(def.id);
    for (const tp of doc.tilePages()) if (!pages.has(tp.id)) pages.set(tp.id, { tp, file: f.path });
  }

  for (const { file: pageFile, tp } of pages.values()) {
    if (!tp.file) { issues.push({ rule: 'page-file', severity: 'error', message: `${tp.id}: TILE_PAGE has no FILE`, file: pageFile }); continue; }
    const imgFile = byPath.get(`graphics/${tp.file}`.replace(/\\/g, '/'));
    if (!imgFile?.image) { issues.push({ rule: 'page-missing', severity: 'error', message: `${tp.id}: image graphics/${tp.file} not found`, file: pageFile }); continue; }
    const dims = tp.sizePixels;
    if (dims && (dims[0] !== imgFile.image.width || dims[1] !== imgFile.image.height)) {
      issues.push({ rule: 'page-size', severity: 'error', message: `${tp.id}: page says ${dims[0]}x${dims[1]} but the image is ${imgFile.image.width}x${imgFile.image.height}`, file: pageFile });
    }
  }

  for (const { file: f, doc } of raws) {
    if (doc.objectType() !== 'GRAPHICS') continue;

    for (const cg of doc.creatureGraphics()) {
      const name = cg.caste ? `${cg.creatureId}:${cg.caste}` : cg.creatureId;
      if (!localCreatures.has(cg.creatureId)) {
        issues.push({ rule: 'creature-unknown', severity: 'error', message: `${name}: no such creature in this mod or vanilla`, file: f.path, creature: cg.creatureId, caste: cg.caste });
      }
      if (cg.entries.some(e => e.args[0] === 'LAYER_SET')) {
        issues.push(...checkLayeredBlock(doc, cg, f.path, pages, byPath, known));
        continue;
      }

      for (const e of cg.entries) {
        const token = e.args[0];
        if (!known.tokens.includes(token)) {
          issues.push({ rule: 'token-unknown', severity: 'warn', message: `${name}: token ${token} is not one vanilla uses`, file: f.path, creature: cg.creatureId, caste: cg.caste, value: token });
        }
        if (token === 'CHILD') {
          const parent = e.args[e.args.length - 1];
          if (!parent || !CHILD_PARENTS.has(parent) || !cg.entries.some(o => o !== e && o.args[0] === parent)) {
            issues.push({ rule: 'child-orphan', severity: 'error', message: `${name}: CHILD has no ${parent ?? '?'} entry in the same block for it to replace`, file: f.path, creature: cg.creatureId, caste: cg.caste });
          }
        }

        // [CDI_LIST_ICON:<interaction token>:<page>:x1:y1:x2:y2] has an extra
        // field before the page (the interaction's own token, e.g. SPIT),
        // unlike every other entry's [token:page:x:y...] -- reading args[1] as
        // the page there matched the interaction token instead (e.g.
        // CDI_LIST_ICON:MB_SPAWN_MOGALL:INTERACTION_MYTHICALBEAST:... ->
        // page "MB_SPAWN_MOGALL"), misfiring page-unknown on every icon.
        const isListIcon = token === 'CDI_LIST_ICON';
        const page = isListIcon ? e.args[2] : e.args[1];
        const spanArgs = isListIcon ? [e.args[0], e.args[2], ...e.args.slice(3)] : e.args;
        const tp = page ? pages.get(page)?.tp : undefined;
        if (page && !tp) {
          // A mod can reuse a page vanilla defines without redeclaring it
          // (same reasoning as checkLayeredBlock's known.tilePageIds
          // fallback) -- e.g. CDI_LIST_ICON:SPIT:CREATURE_ABILITY_LIST_ICONS
          // is vanilla's own shared ability-icon sheet.
          if (!known.tilePageIds.includes(page)) {
            issues.push({ rule: 'page-unknown', severity: 'error', message: `${name}: page ${page} is not defined anywhere in this mod`, file: f.path, creature: cg.creatureId, caste: cg.caste });
          }
          continue;
        }
        const span = tp && tileSpan(spanArgs, cg.isStatue);
        if (!tp || !span) continue;
        const [tw, th] = tp.tileDim ?? [32, 32];
        const [x1, y1, x2, y2] = span;
        const rect = { x: x1 * tw, y: y1 * th, w: (x2 - x1 + 1) * tw, h: (y2 - y1 + 1) * th };
        const imgFile = tp.file ? byPath.get(`graphics/${tp.file}`.replace(/\\/g, '/')) : undefined;
        if (!imgFile?.image) continue;
        if (rect.w <= 0 || rect.h <= 0 || rect.x < 0 || rect.y < 0 || rect.x + rect.w > imgFile.image.width || rect.y + rect.h > imgFile.image.height) {
          issues.push({ rule: 'rect-bounds', severity: 'error', message: `${name}: ${token} sits outside page ${page}`, file: f.path, creature: cg.creatureId, caste: cg.caste, key: token });
        } else if (isBlank(crop(imgFile.image, rect))) {
          issues.push({ rule: 'rect-blank', severity: 'error', message: `${name}: ${token} rect is fully transparent`, file: f.path, creature: cg.creatureId, caste: cg.caste, key: token });
        }
      }
    }
  }
  return issues;
}

export function validateMods(sources: { id: string; files: ModFile[] }[], known: VanillaIndex): Issue[] {
  const issues: Issue[] = [];
  const pageOwners = new Map<string, string>();
  const fileOwners = new Map<string, string>();
  const creatureOwners = new Map<string, string[]>();

  for (const src of sources) {
    for (const f of textFiles(src.files)) {
      const doc = RawDocument.fromBytes(f.bytes);
      const type = doc.objectType();
      if (type !== 'GRAPHICS' && type !== 'TILE_PAGE') continue;
      const base = f.path.replace(/\\/g, '/').split('/').pop()!;

      if (known.graphicsFiles.includes(base)) {
        issues.push({ rule: 'file-shared-vanilla', severity: 'warn', message: `${base}: same name as a vanilla graphics file, DF will replace it`, mod: src.id, file: f.path });
      } else if (fileOwners.has(base) && fileOwners.get(base) !== src.id) {
        issues.push({ rule: 'file-shared-mod', severity: 'warn', message: `${base}: also written by ${fileOwners.get(base)}, DF will replace it`, mod: src.id, file: f.path });
      } else fileOwners.set(base, src.id);

      for (const tp of doc.tilePages()) {
        if (pageOwners.has(tp.id) && pageOwners.get(tp.id) !== src.id) {
          issues.push({ rule: 'page-id-shared', severity: 'error', message: `${tp.id}: tile page id also defined by ${pageOwners.get(tp.id)}`, mod: src.id, file: f.path });
        } else pageOwners.set(tp.id, src.id);
      }
      for (const cg of doc.creatureGraphics()) {
        const owners = creatureOwners.get(cg.creatureId) ?? [];
        if (owners.length && !owners.includes(src.id)) {
          issues.push({ rule: 'creature-shared', severity: 'info', message: `${cg.creatureId}: graphics also given by ${owners.join(', ')}, load order decides`, mod: src.id, file: f.path, creature: cg.creatureId });
        }
        if (!owners.includes(src.id)) { owners.push(src.id); creatureOwners.set(cg.creatureId, owners); }
      }
    }
  }
  return issues;
}
