// Layered creature session: the open creature's layer model, its
// page images, and which layer tile is on the canvas. Layer art is page-backed,
// so the open tile lives on project.sprite and is written back into its page
// image (writeTile) whenever the panel renders and on every switch.
import { addLayer, addPaletteRow, cloneImage, createImage, paletteRow, readTile, reduceImage, setPaletteDefaultRow, tileRect, writeTile } from '../../engine/index.ts';
import type { LayeredLayer, LayerGroup, LayerRef, LayeredGraphics, LsPalette, PageImages, Rgba, RgbaImage, VanillaStats } from '../../engine/index.ts';
import type { HistoryEntry } from './history.ts';
import { flushSelection, selectEntry } from './selection.ts';
import { layerDocKey } from './store.ts';
import type { Store } from './store.ts';

export type PageRef = Extract<LayerRef, { page: string }>;
// A layered creature the opened mod folder defines, ready for openLayered:
// readMod keeps its whole block, and mod-panel.ts resolves the page and
// palette PNGs out of the same folder. `label` disambiguates the picker,
// since one creature commonly has a second block (a portrait layer set,
// say) in another file under the same id.
export type ModLayered = {
  id: string;
  label: string;
  path: string;
  lg: LayeredGraphics;
  pages: PageImages;
  palettes: Map<string, RgbaImage>;
};

export type LayeredSession = {
  lg: LayeredGraphics;
  creatureId: string;
  // The raw file this creature's graphics came from, relative to the DF
  // folder's data/vanilla (vanilla-scan.ts) -- e.g.
  // "graphics/graphics_creatures_dwarf.txt". mod-panel.ts's export uses it
  // (with layeredPageFilePaths) to place any changed page PNG at the path a
  // mod overriding this creature needs.
  path: string;
  pages: PageImages;
  // Snapshot of `pages` taken at open time: changedPageFiles
  // diffs against this to export only the pages actually drawn on.
  originalPages: PageImages;
  // LS_PALETTE_FILE path (as written in the raws) -> decoded palette PNG, for
  // the figure panel's composite preview (6-4b). Not needed for art editing.
  palettes: Map<string, RgbaImage>;
  selected: { key: string; ref: PageRef } | null;
  open: Set<string>;                 // expanded group keys ("set:group")
};

export const groupKey = (set: number, group: number) => `${set}:${group}`;
export const layerKey = (set: number, group: number, layer: number) => `${set}:${group}:${layer}`;

function snapshotPages(pages: PageImages): PageImages {
  return new Map([...pages].map(([id, p]) => [id, { tile: p.tile, image: cloneImage(p.image) }]));
}

export function openLayered(store: Store, lg: LayeredGraphics, creatureId: string, path: string, pages: PageImages, palettes: Map<string, RgbaImage> = new Map()): void {
  flushSelection(store);
  store.update(s => {
    // Remembered so closeLayered can restore it: otherwise the
    // checklist/AI/Checker panels just go blank with no clue why.
    if (s.ui.selection) s.ui.lastTemplateSelection = s.ui.selection;
    s.ui.selection = null;
    s.ui.layered = { lg, creatureId, path, pages, originalPages: snapshotPages(pages), palettes, selected: null, open: new Set() };
    s.project.sprite = createImage(32, 32);
  });
}

export function closeLayered(store: Store): void {
  flushLayered(store);
  const restore = store.get().ui.lastTemplateSelection;
  store.update(s => { s.ui.layered = null; s.ui.lastTemplateSelection = null; });
  if (restore) selectEntry(store, restore, restore.entryKey);
}

// Writes the open tile back into its page image.
export function flushLayered(store: Store): void {
  const { ui, project } = store.get();
  if (ui.layered?.selected) writeTile(ui.layered.pages, ui.layered.selected.ref, project.sprite);
}

export function selectLayer(store: Store, key: string, ref: PageRef): void {
  const L = store.get().ui.layered;
  const page = L?.pages.get(ref.page);
  if (!L || !page) return;
  flushLayered(store);
  const r = tileRect(ref, page.tile);
  const img = readTile(L.pages, ref) ?? createImage(r.w, r.h);
  store.update(s => { s.project.sprite = img; s.ui.layered!.selected = { key, ref }; });
}

export function toggleGroup(store: Store, key: string): void {
  store.update(s => {
    const open = s.ui.layered!.open;
    if (!open.delete(key)) open.add(key);
  });
}

// Runs the reducer on a picked image into one layer's tile, with undo.
export function applyLayerReduce(store: Store, key: string, ref: PageRef, token: string, src: RgbaImage, stats?: VanillaStats): void {
  const s = store.get();
  const L = s.ui.layered;
  const page = L?.pages.get(ref.page);
  if (!L || !page) return;
  const r = tileRect(ref, page.tile);
  if (r.w !== r.h) return;
  const { img } = reduceImage(src, s.project.palette, { tileSpan: r.w, stats, token });
  const isOpen = () => store.get().ui.layered?.selected?.key === key;
  const before = readTile(L.pages, ref) ?? createImage(r.w, r.h);
  // Current pixels of the tile, the live canvas one when it is the open layer.
  const beforeData = (isOpen() ? s.project.sprite : before).data.slice() as Uint8ClampedArray;
  const apply = (data: Uint8ClampedArray) => {
    const st = store.get();
    const tile = { ...before, data: new Uint8ClampedArray(data) };
    writeTile(st.ui.layered!.pages, ref, tile);
    if (isOpen()) st.project.sprite.data.set(data);
    store.notify();
  };
  const after = img.data.slice() as Uint8ClampedArray;
  const entry: HistoryEntry = { label: `reduce ${token}`, undo: () => apply(beforeData), redo: () => apply(after) };
  apply(after);
  // Targets key's own document explicitly: the reducer commonly writes into
  // a layer that isn't the one open on the canvas.
  store.update(() => {}, entry, layerDocKey(L.creatureId, L.path, key));
}

// Adds a new layer to a group, copying a sibling's ref/palette/
// conditions (raw/layers.ts's addLayer), then opens it on the canvas like any
// other layer. The "add layer" entry lands on the new layer's own document
// (undo removes the tokens addLayer inserted and clears the selection if
// it's still open; redo re-runs addLayer and re-selects, which is why redo()
// also has to reselect).
export function applyAddLayer(store: Store, si: number, gi: number, group: LayerGroup, name: string, ref: LayerRef, copyFrom?: LayeredLayer): void {
  const s = store.get();
  const L = s.ui.layered;
  if (!L) return;
  const doc = L.lg.doc;
  const removeTokens = (layer: LayeredLayer) => {
    for (const c of layer.conditions) { for (const ch of c.children) doc.remove(ch); doc.remove(c.token); }
    if (layer.paletteToken) doc.remove(layer.paletteToken);
    doc.remove(layer.token);
  };

  let layer = addLayer(doc, group, name, ref, copyFrom);
  const li = group.layers.indexOf(layer);
  const key = layerKey(si, gi, li);
  if ('page' in layer.ref) selectLayer(store, key, layer.ref);

  const undo = () => {
    const idx = group.layers.indexOf(layer);
    if (idx >= 0) group.layers.splice(idx, 1);
    removeTokens(layer);
    const st = store.get();
    if (st.ui.layered?.selected?.key === key) store.update(s2 => { s2.ui.layered!.selected = null; });
    else store.notify();
  };
  const redo = () => {
    layer = addLayer(doc, group, name, ref, copyFrom);
    if ('page' in layer.ref) selectLayer(store, key, layer.ref);
  };
  const entry: HistoryEntry = { label: `add layer ${name}`, undo, redo };
  // Targets the new layer's own document, whether or not selectLayer above
  // actually opened it (a non-page-backed layer has nothing to open).
  store.update(() => {}, entry, layerDocKey(L.creatureId, L.path, key));
}

// Grows a palette PNG by one row (layered/pixels.ts's addPaletteRow), seeded
// from the palette's current default row's colours (a sane starting point --
// the row picks up whatever art already uses the default palette until the
// user repaints it), and optionally points LS_PALETTE_DEFAULT at the new row.
export function applyAddPaletteRow(store: Store, pal: LsPalette, makeDefault: boolean): void {
  const s = store.get();
  const L = s.ui.layered;
  if (!L || !pal.file) return;
  const before = L.palettes.get(pal.file);
  if (!before) return;
  const doc = L.lg.doc;
  const seed: Rgba[] = paletteRow(before, pal.defaultRow) ?? Array.from({ length: before.width }, () => [0, 0, 0, 0] as Rgba);
  const hadDefaultToken = !!pal.defaultToken;
  const prevDefaultArgs = pal.defaultToken ? [...pal.defaultToken.args] : undefined;
  const prevDefaultRow = pal.defaultRow;

  const doApply = (): void => {
    const { image, row } = addPaletteRow(before, seed);
    store.get().ui.layered!.palettes.set(pal.file!, image);
    if (makeDefault) setPaletteDefaultRow(doc, pal, row);
  };
  doApply();

  const undo = () => {
    const st = store.get().ui.layered;
    if (st) st.palettes.set(pal.file!, before);
    if (makeDefault) {
      if (hadDefaultToken && pal.defaultToken && prevDefaultArgs) { pal.defaultToken.args = prevDefaultArgs; pal.defaultRow = prevDefaultRow; }
      else if (!hadDefaultToken && pal.defaultToken) { doc.remove(pal.defaultToken); pal.defaultToken = undefined; pal.defaultRow = prevDefaultRow; }
    }
    store.notify();
  };
  const redo = () => { doApply(); store.notify(); };
  const entry: HistoryEntry = { label: `add palette row (${pal.name})`, undo, redo };
  store.update(() => {}, entry);
}
