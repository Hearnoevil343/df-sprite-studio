import type { Palette, Rgba, RgbaImage } from '../../engine/index.ts';
import type { LightDir, ModCreature, ModInfo } from '../../engine/index.ts';
import type { VanillaScan } from '../io/vanilla-scan.ts';
import type { LayeredSession, ModLayered } from './layered.ts';
import { History, type HistoryEntry } from './history.ts';

// Mod info and creatures are the engine's export types (engine/mod), so the
// project hands straight to modFiles. sprites is keyed by TemplateEntry.key
// (not token) since a template can use the same token twice (DEFAULT/CHILD
// pairs). Only entries the user has opened appear there; the checklist
// derives what's missing from engine.activeEntries.
export type { ModInfo };
export type Creature = ModCreature;

export type Tool = 'pencil' | 'eraser' | 'fill' | 'picker' | 'line' | 'rect' | 'marquee' | 'move';

// A loaded reference (vanilla sprite crop or any PNG). Not undoable: it
// guides drawing but isn't part of the saved sprite.
export type Reference = {
  image: RgbaImage;
  name: string;
  onionSkin: boolean;
  onionOpacity: number; // 0-1
  sideBySide: boolean;
};

// Which vanilla-stats.json group backs the proportion guide overlay.
export type Guide = {
  show: boolean;
  page?: string;
  token?: string;
};

// A creature's identity within the project. id alone is not unique: the same
// id can carry two graphics blocks (a caste-specific one plus the base, or a
// statue alongside the normal creature), which templateId's header (per
// SpriteTemplate.header) tells apart alongside caste.
export type CreatureRef = { id: string; caste?: string; templateId: string };

// Which sprite is open on the canvas: a creature ref plus a TemplateEntry key
// within its template. Not undoable itself -- it addresses a document
// (entryDocKey below), it isn't one.
export type Selection = CreatureRef & { entryKey: string };

// A rectangle marquee selection, sprite-local pixel coords.
// Distinct from `Ui.selection` above, which is which sprite/entry is open.
export type Marquee = { x: number; y: number; w: number; h: number };

// Selection pixels lifted by the Move tool (or a paste), held outside the
// sprite until committed (Enter/tool change) or discarded (Esc). The pixels
// the lift vacated are already cleared on the sprite underneath.
export type Floating = { x: number; y: number; image: RgbaImage };

export type Ui = {
  tool: Tool;
  colour: Rgba;
  // Square brush width in pixels (1-4) for Pencil and the eraser.
  brushSize: number;
  zoom: number;
  showGrid: boolean;
  mirrorX: boolean;
  lightDir: LightDir;
  reference: Reference | null;
  guide: Guide;
  hover: { x: number; y: number } | null;
  selection: Selection | null;
  // Rectangle marquee selection and the Move tool's lifted pixels, if any.
  marquee: Marquee | null;
  floating: Floating | null;
  // The template selection open just before a layered creature was opened,
  // so closing it can put the checklist/AI/Checker panels back
  // where the user left them instead of showing "nothing open".
  lastTemplateSelection: Selection | null;
  // Open layered creature; null in template mode. While set,
  // project.sprite is the open layer's tile and `selection` is null.
  layered: LayeredSession | null;
  // Layered creature blocks found in the opened mod folder, with page and
  // palette images resolved from that same folder, so the layer tree can
  // open one with no DF folder connected.
  modLayered: ModLayered[];
  // Pixels of the style-panel issue currently hovered/selected,
  // sprite-local per Issue.pixels; drawn by canvas.ts over the sprite.
  styleOverlay: { x: number; y: number }[] | null;
  // The one shared DF-folder scan, read by finder/reference/
  // layer-tree/scene-preview instead of each connecting independently.
  vanillaScan: VanillaScan | null;
  vanillaScanStatus: string;
};

// Project state: mod info, locked palette, and creatures with their sprites
// keyed by template entry. `sprite` is the one entry currently open on the
// canvas — swapped in and out of the owning creature's `sprites` map by
// state/selection.ts as the user picks creatures/entries in the checklist,
// so canvas.ts and the other panels keep working on `project.sprite`
// unchanged.
export type Project = {
  mod: ModInfo;
  palette: Palette;
  paletteLocked: boolean;
  // Modder-added colours: not part of any ramp, not palette-
  // locked, kept separate from `palette.colours` so rampStep and the
  // reducer keep snapping to the DF palette only.
  customColours: Rgba[];
  creatures: Creature[];
  sprite: RgbaImage;
};

export type AppState = { project: Project; ui: Ui };

type Listener = (state: AppState) => void;

// A document is an entry's canvas or a layered creature's layer tile,
// addressed by the same ref the rest of the app already uses to name it --
// there's no separate "document id" to keep in sync. Each document owns its
// own undo stack, so switching which one is open never touches another's
// history.
export function entryDocPrefix(ref: CreatureRef): string {
  return `entry:${ref.id}:${ref.caste ?? ''}:${ref.templateId}:`;
}

export function entryDocKey(ref: CreatureRef, entryKey: string): string {
  return entryDocPrefix(ref) + entryKey;
}

export function layerDocKey(creatureId: string, path: string, layerKey: string): string {
  return `layer:${creatureId}:${path}:${layerKey}`;
}

// The document the canvas is currently showing, i.e. what a plain pixel
// stroke or store.undo()/redo() acts on. null means nothing is open (no
// selection, or a layered creature with no layer picked yet).
function currentDocKey(state: AppState): string | null {
  const { selection, layered } = state.ui;
  if (layered) return layered.selected ? layerDocKey(layered.creatureId, layered.path, layered.selected.key) : null;
  if (selection) return entryDocKey(selection, selection.entryKey);
  return null;
}

// get(), update(fn, historyEntry?), subscribe().
// A pixel stroke mutates sprite.data directly (for live drawing) and calls
// notify() on every step; on pointer up it calls update() with a no-op
// mutator and the stroke's before/after HistoryEntry, since the state
// already reflects "after" by then.
export class Store {
  #state: AppState;
  #listeners = new Set<Listener>();
  // One History per document, created lazily on first
  // use and kept for as long as the document might be reopened. The null-key
  // bucket below is where a push would land with nothing open -- callers
  // shouldn't hit it, but it's harmless if one does.
  #histories = new Map<string, History>();
  #noDocHistory = new History();

  constructor(initial: AppState) {
    this.#state = initial;
  }

  get(): AppState {
    return this.#state;
  }

  subscribe(fn: Listener): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  notify(): void {
    for (const fn of this.#listeners) fn(this.#state);
  }

  // A specific document's stack, addressed by entryDocKey/layerDocKey --
  // for code writing into an entry/layer that may not be the open one
  // (drafts, the reducer, the AI candidate picker).
  historyFor(key: string | null): History {
    if (key === null) return this.#noDocHistory;
    let h = this.#histories.get(key);
    if (!h) { h = new History(); this.#histories.set(key, h); }
    return h;
  }

  // The open document's stack: canvas strokes, the undo/redo buttons, the
  // dirty indicator.
  get history(): History {
    return this.historyFor(currentDocKey(this.#state));
  }

  // Discards one document's stack -- its own buffer changed shape (resize,
  // rotate), so the entries on it can no longer .set() onto it safely.
  forgetHistory(key: string): void {
    this.#histories.delete(key);
  }

  // Discards every document whose key starts with prefix -- a creature was
  // removed, so its entries' documents no longer mean anything (and must not
  // resurface if a new creature happens to reuse the same id/caste/template).
  forgetHistoryPrefix(prefix: string): void {
    for (const key of this.#histories.keys()) if (key.startsWith(prefix)) this.#histories.delete(key);
  }

  // Discards every document -- a new project was loaded.
  forgetAllHistory(): void {
    this.#histories.clear();
  }

  // docKey targets a specific document's stack regardless of what's open
  // (see historyFor); omit it to push onto whichever document is open now.
  update(mutate: (state: AppState) => void, historyEntry?: HistoryEntry, docKey?: string): void {
    mutate(this.#state);
    if (historyEntry) this.historyFor(docKey ?? currentDocKey(this.#state)).push(historyEntry);
    this.notify();
  }

  undo(): void {
    if (this.history.undo()) this.notify();
  }

  redo(): void {
    if (this.history.redo()) this.notify();
  }
}
