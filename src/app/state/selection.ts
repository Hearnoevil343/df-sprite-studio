// Creature list and sprite-checklist selection: switching which
// sprite is open on the canvas. Kept out of store.ts since it needs the
// template engine, which the store's own types don't depend on.
import { TILE, activeEntries, createImage, draftVariant, reduceImage, resizeAnchored, resolveEntries, rotate90, templateById } from '../../engine/index.ts';
import type { DraftStep, Palette, ReadModResult, RgbaImage, VanillaStats } from '../../engine/index.ts';
import type { CreatureRef, Creature } from './store.ts';
import { entryDocKey, entryDocPrefix } from './store.ts';
import type { HistoryEntry } from './history.ts';
import type { Store } from './store.ts';

// id + caste + templateId (whose header tells statue/caste blocks apart)
// together identify a creature; id alone can collide.
export function sameCreature(a: CreatureRef, b: CreatureRef): boolean {
  return a.id === b.id && a.caste === b.caste && a.templateId === b.templateId;
}

export function findCreature(store: Store, ref: CreatureRef): Creature | undefined {
  return store.get().project.creatures.find(c => sameCreature(c, ref));
}

export function addCreature(store: Store, id: string, templateId: string, caste?: string): void {
  store.update(s => {
    s.project.creatures.push({ id, ...(caste ? { caste } : {}), templateId, include: [], omit: [], sprites: {} });
  });
}

export function removeCreature(store: Store, ref: CreatureRef): void {
  store.update(s => {
    s.project.creatures = s.project.creatures.filter(c => !sameCreature(c, ref));
    if (s.ui.selection && sameCreature(s.ui.selection, ref)) s.ui.selection = null;
  });
  // The creature's documents can't be reopened under this id/caste/template,
  // and must not resurface if a different creature later reuses it.
  store.forgetHistoryPrefix(entryDocPrefix(ref));
}

// Saves the sprite currently open on the canvas back into its creature, then
// opens the given creature/entry, creating a blank sprite at the entry's
// size (canvas is the template entry's size x 32px)
// the first time it's opened. Each entry has its own undo stack,
// addressed by entryDocKey, so switching entries never
// touches another entry's history -- only resizeEntry/rotateEntry forget a
// stack, and only the one whose own buffer they just resized.
export function selectEntry(store: Store, ref: CreatureRef, entryKey: string): void {
  store.update(s => {
    const prevSel = s.ui.selection;
    if (prevSel) {
      const prev = s.project.creatures.find(c => sameCreature(c, prevSel));
      if (prev) prev.sprites[prevSel.entryKey] = s.project.sprite;
    }
    const creature = s.project.creatures.find(c => sameCreature(c, ref));
    const template = creature ? templateById(creature.templateId) : undefined;
    const entry = template && creature ? resolveEntries(template, creature).find(e => e.key === entryKey) : undefined;
    if (!creature || !entry) return;
    const [w, h] = entry.size;
    s.project.sprite = creature.sprites[entryKey] ?? createImage(w * 32, h * 32);
    s.ui.selection = { ...ref, entryKey };
  });
}

// Stores the sprite open on the canvas into its creature without switching,
// so an export sees the latest pixels.
export function flushSelection(store: Store): void {
  const s = store.get();
  const sel = s.ui.selection;
  const creature = sel && s.project.creatures.find(c => sameCreature(c, sel));
  if (sel && creature) creature.sprites[sel.entryKey] = s.project.sprite;
}

// Replaces the project with one read from a mod folder, then opens
// the first creature's first drawn entry, or nothing.
export function loadProject(store: Store, result: ReadModResult): void {
  store.update(s => {
    s.project.mod = result.mod;
    if (result.palette) s.project.palette = result.palette;
    if (result.paletteLocked !== undefined) s.project.paletteLocked = result.paletteLocked;
    s.project.customColours = result.customColours ?? [];
    s.project.creatures = result.creatures;
    s.project.sprite = createImage(32, 32);
    s.ui.selection = null;
  });
  store.forgetAllHistory();
  const first = result.creatures[0];
  const t = first && templateById(first.templateId);
  const entries = t ? activeEntries(t, first) : [];
  const entry = entries.find(e => first.sprites[e.key]) ?? entries[0];
  if (entry) selectEntry(store, { id: first.id, caste: first.caste, templateId: first.templateId }, entry.key);
}

// Runs a draft step (checklist.ts "draft" buttons): chains
// draftVariant over the step's kinds from its source entry, writes the
// result into the creature's sprite map, and keeps the canvas in sync when
// the drafted key happens to be the entry currently open. Mutates directly
// (like pushSpriteEdit in main.ts/reference.ts) so before/after history can
// capture the prior sprite, which may not have existed.
export function applyDraft(store: Store, ref: CreatureRef, palette: Palette, step: DraftStep): void {
  const s = store.get();
  const creature = s.project.creatures.find(c => sameCreature(c, ref));
  // The source entry's live pixels are on project.sprite if it's the one
  // currently open (see checklist.ts's spriteFor): drawing doesn't flush
  // into creature.sprites until the next selectEntry/export.
  const fromOpen = !!s.ui.selection && sameCreature(s.ui.selection, ref) && s.ui.selection.entryKey === step.from;
  const src = fromOpen ? s.project.sprite : creature?.sprites[step.from];
  if (!creature || !src) return;
  let img = src;
  for (const kind of step.kinds) img = draftVariant(img, kind, palette);
  const isOpen = !!s.ui.selection && sameCreature(s.ui.selection, ref) && s.ui.selection.entryKey === step.key;
  const prevImg = creature.sprites[step.key];
  creature.sprites[step.key] = img;
  if (isOpen) s.project.sprite = img;
  // Checks the *current* selection at undo/redo time, not draft time: the
  // user may have navigated to view step.key (or away from it) in between,
  // and project.sprite must follow whichever entry is open when this fires.
  const isOpenNow = (st: ReturnType<Store['get']>) =>
    !!st.ui.selection && sameCreature(st.ui.selection, ref) && st.ui.selection.entryKey === step.key;
  const entry: HistoryEntry = {
    label: `draft ${step.key}`,
    undo: () => {
      const st = store.get();
      const c = st.project.creatures.find(cc => sameCreature(cc, ref));
      if (c) { if (prevImg) c.sprites[step.key] = prevImg; else delete c.sprites[step.key]; }
      if (isOpenNow(st)) st.project.sprite = prevImg ?? createImage(img.width, img.height);
      store.notify();
    },
    redo: () => {
      const st = store.get();
      const c = st.project.creatures.find(cc => sameCreature(cc, ref));
      if (c) c.sprites[step.key] = img;
      if (isOpenNow(st)) st.project.sprite = img;
      store.notify();
    },
  };
  // Targets step.key's own document explicitly (not "whatever's open"): a
  // draft commonly writes into an entry that isn't the one on the canvas.
  store.update(() => {}, entry, entryDocKey(ref, step.key));
}

// Size-picker support: only entries of a
// `rect: 'LARGE_IMAGE'` template can be resized -- that's the only way DF
// raws express a multi-tile sprite. Returns null when the entry isn't
// resizable (wrong rect, or the creature/entry isn't found), so the UI can
// hide the picker entirely.
export type SizeInfo = { size: [number, number] };

export function entrySizeInfo(store: Store, ref: CreatureRef, key: string): SizeInfo | null {
  const creature = findCreature(store, ref);
  const template = creature && templateById(creature.templateId);
  const entry = template && creature ? resolveEntries(template, creature).find(e => e.key === key) : undefined;
  if (!creature || !template || !entry || template.rect !== 'LARGE_IMAGE') return null;
  return { size: entry.size };
}

// Resizes one entry: pixels are re-anchored bottom-centre (growing pads with
// transparency, shrinking crops), the creature's `sizes` override is updated
// (or removed, when the new size matches the template's own default, so an
// unmodified creature keeps exporting byte-identically), and the entry's own
// undo history is forgotten -- its stack can hold before/after snapshots
// sized to the old buffer, which a later undo could try to .set() onto the
// resized one. `confirmCrop` is asked only when a shrink would drop
// already-drawn (non-transparent) pixels; returning false cancels the
// resize entirely, pixels untouched.
export function resizeEntry(store: Store, ref: CreatureRef, key: string, size: [number, number], confirmCrop: (message: string) => boolean): boolean {
  const s = store.get();
  const creature = s.project.creatures.find(c => sameCreature(c, ref));
  const template = creature && templateById(creature.templateId);
  const entry = template?.entries.find(e => e.key === key);
  if (!creature || !template || !entry || template.rect !== 'LARGE_IMAGE') return false;
  const isOpen = !!s.ui.selection && sameCreature(s.ui.selection, ref) && s.ui.selection.entryKey === key;
  const current = isOpen ? s.project.sprite : creature.sprites[key];
  const targetW = size[0] * TILE, targetH = size[1] * TILE;
  let resized = current;
  if (current && (current.width !== targetW || current.height !== targetH)) {
    const { image, clipped } = resizeAnchored(current, targetW, targetH);
    if (clipped && !confirmCrop(`Shrinking ${key} will crop drawn pixels. Continue?`)) return false;
    resized = image;
  }
  let changed = false;
  store.update(st => {
    const c = st.project.creatures.find(cc => sameCreature(cc, ref));
    if (!c) return;
    if (resized && resized !== current) c.sprites[key] = resized;
    const defaultSize = entry.size ?? [1, 1];
    const isDefault = size[0] === defaultSize[0] && size[1] === defaultSize[1];
    if (isDefault) { if (c.sizes) delete c.sizes[key]; }
    else c.sizes = { ...c.sizes, [key]: size };
    if (c.sizes && Object.keys(c.sizes).length === 0) delete c.sizes;
    if (isOpen && resized) st.project.sprite = resized;
    changed = true;
  });
  if (changed) store.forgetHistory(entryDocKey(ref, key));
  return true;
}

// Rotates a LARGE_IMAGE entry 90deg: the pixel buffer
// itself swaps width/height (rotate90), so unlike resizeEntry there's no
// anchor/crop step -- the rotated image is already exactly the swapped size.
// Still forgets the entry's own undo history like resizeEntry, for the same
// mismatched-buffer-size reason. Square entries rotate in place in the
// caller (main.ts) instead, since they never touch `sizes`.
export function rotateEntry(store: Store, ref: CreatureRef, key: string): boolean {
  const s = store.get();
  const creature = s.project.creatures.find(c => sameCreature(c, ref));
  const template = creature && templateById(creature.templateId);
  const entry = template?.entries.find(e => e.key === key);
  if (!creature || !template || !entry || template.rect !== 'LARGE_IMAGE') return false;
  const isOpen = !!s.ui.selection && sameCreature(s.ui.selection, ref) && s.ui.selection.entryKey === key;
  const current = isOpen ? s.project.sprite : creature.sprites[key];
  if (!current) return false;
  const rotated = rotate90(current);
  const info = entrySizeInfo(store, ref, key);
  const size = info ? info.size : (entry.size ?? [1, 1]);
  const newSize: [number, number] = [size[1], size[0]];
  store.update(st => {
    const c = st.project.creatures.find(cc => sameCreature(cc, ref));
    if (!c) return;
    c.sprites[key] = rotated;
    const defaultSize = entry.size ?? [1, 1];
    const isDefault = newSize[0] === defaultSize[0] && newSize[1] === defaultSize[1];
    if (isDefault) { if (c.sizes) delete c.sizes[key]; }
    else c.sizes = { ...c.sizes, [key]: newSize };
    if (c.sizes && Object.keys(c.sizes).length === 0) delete c.sizes;
    if (isOpen) st.project.sprite = rotated;
  });
  store.forgetHistory(entryDocKey(ref, key));
  return true;
}

// Runs the LoRA-output reducer (checklist.ts "Reduce" file pickers, Phase
// 4-3) on a dropped/picked image for one entry: same write-and-undo shape as
// applyDraft, but the source is an arbitrary external image (any size)
// instead of another entry's drawn sprite, and reduceImage does the work
// instead of draftVariant.
export function applyReduce(store: Store, ref: CreatureRef, palette: Palette, key: string, src: RgbaImage, stats?: VanillaStats): void {
  const creature = store.get().project.creatures.find(c => sameCreature(c, ref));
  const template = creature && templateById(creature.templateId);
  const entry = template && creature ? resolveEntries(template, creature).find(e => e.key === key) : undefined;
  if (!creature || !entry) return;
  const [w] = entry.size;
  const { img } = reduceImage(src, palette, { tileSpan: w * TILE, stats, token: entry.token });
  applySprite(store, ref, key, img, `reduce ${key}`);
}

// Writes an already-finished sprite into one entry with undo/redo. Shared by
// the reducer and the AI candidate picker (panels/generate.ts).
export function applySprite(store: Store, ref: CreatureRef, key: string, img: RgbaImage, label: string): void {
  const s = store.get();
  const creature = s.project.creatures.find(c => sameCreature(c, ref));
  const template = creature && templateById(creature.templateId);
  const entry = template && creature ? resolveEntries(template, creature).find(e => e.key === key) : undefined;
  if (!creature || !entry) return;
  const [w, h] = entry.size;
  const isOpen = !!s.ui.selection && sameCreature(s.ui.selection, ref) && s.ui.selection.entryKey === key;
  const prevImg = creature.sprites[key];
  creature.sprites[key] = img;
  if (isOpen) s.project.sprite = img;
  const isOpenNow = (st: ReturnType<Store['get']>) =>
    !!st.ui.selection && sameCreature(st.ui.selection, ref) && st.ui.selection.entryKey === key;
  const historyEntry: HistoryEntry = {
    label,
    undo: () => {
      const st = store.get();
      const c = st.project.creatures.find(cc => sameCreature(cc, ref));
      if (c) { if (prevImg) c.sprites[key] = prevImg; else delete c.sprites[key]; }
      if (isOpenNow(st)) st.project.sprite = prevImg ?? createImage(w * TILE, h * TILE);
      store.notify();
    },
    redo: () => {
      const st = store.get();
      const c = st.project.creatures.find(cc => sameCreature(cc, ref));
      if (c) c.sprites[key] = img;
      if (isOpenNow(st)) st.project.sprite = img;
      store.notify();
    },
  };
  // Targets key's own document explicitly, same reasoning as applyDraft.
  store.update(() => {}, historyEntry, entryDocKey(ref, key));
}
