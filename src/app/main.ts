import vanillaIndex from '../../data/vanilla-index.json' with { type: 'json' };
import vanillaPalette from '../../data/vanilla-palette.json' with { type: 'json' };
import vanillaStats from '../../data/vanilla-stats.json' with { type: 'json' };
import vanillaStyle from '../../data/vanilla-style.json' with { type: 'json' };
import { createImage, crop, flip, lightHints, outline, rampStep, rotate90, stamp } from '../engine/index.ts';
import type { LightDir, Palette, RgbaImage, VanillaIndex, VanillaStats, VanillaStyle } from '../engine/index.ts';
import { createCanvasView } from './canvas/canvas.ts';
import { buildDefaultLayout, createShell, persistLayoutOnChange, reopenPanel, restoreOrBuildLayout } from './dock/shell.ts';
import type { PanelDef } from './dock/shell.ts';
import { autoConnectDfFolder, pickAndConnectDfFolder } from './io/vanilla-connect.ts';
import { createChecklistPanel } from './panels/checklist.ts';
import { createCreatureListPanel } from './panels/creature-list.ts';
import { createLayerTreePanel } from './panels/layer-tree.ts';
import { createGeneratePanel } from './panels/generate.ts';
import { createDfLookPanel } from './panels/df-look.ts';
import { createFigurePanel } from './panels/figure-panel.ts';
import { createFinderPanel } from './panels/finder.ts';
import { createModPanel } from './panels/mod-panel.ts';
import { createPalettePanel } from './panels/palette.ts';
import { createReferencePanel } from './panels/reference.ts';
import { createScenePreviewPanel } from './panels/scene-preview.ts';
import { createSizePickerPanel } from './panels/size-picker.ts';
import { createStylePanel } from './panels/style.ts';
import type { HistoryEntry } from './state/history.ts';
import { entrySizeInfo, rotateEntry } from './state/selection.ts';
import { Store, type AppState, type Tool } from './state/store.ts';

const SPRITE_SIZE = 32;
const PALETTE = vanillaPalette as Palette;
const STATS = vanillaStats as unknown as VanillaStats;
const STYLE = vanillaStyle as unknown as VanillaStyle;
export const VANILLA_INDEX = vanillaIndex as unknown as VanillaIndex;
const LIGHT_DIRS: LightDir[] = ['top', 'top-right', 'right', 'bottom-right', 'bottom', 'bottom-left', 'left', 'top-left'];

const state: AppState = {
  project: {
    mod: { id: '', name: '', version: '1', author: '', description: '' },
    palette: PALETTE,
    paletteLocked: true,
    customColours: [],
    creatures: [],
    sprite: createImage(SPRITE_SIZE, SPRITE_SIZE),
  },
  ui: {
    tool: 'pencil',
    colour: PALETTE.colours[0],
    brushSize: 1,
    zoom: 16,
    showGrid: true,
    mirrorX: false,
    lightDir: 'top-left',
    reference: null,
    guide: { show: false },
    hover: null,
    selection: null,
    marquee: null,
    floating: null,
    lastTemplateSelection: null,
    layered: null,
    modLayered: [],
    styleOverlay: null,
    vanillaScan: null,
    vanillaScanStatus: '',
  },
};

const store = new Store(state);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props);
}

function byId<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing #${id}`);
  return found as T;
}

// --- Shell: menu bar, left tool strip, dockview host, status bar ---------

const shell = createShell(byId('app'));
// Exposed for tools/browser-pass.ts, which needs to switch the active right-
// dock tab before interacting with a panel that isn't currently visible.
(window as unknown as { __dockview: typeof shell.dockview }).__dockview = shell.dockview;

const canvasPanelEl = shell.contentFor('canvas-panel');
const mainEl = el('div', { id: 'main' });
const canvasEl = el('canvas', { id: 'canvas' });
mainEl.append(canvasEl);
canvasPanelEl.append(mainEl);

const projectEl = shell.contentFor('project');
const creaturesEl = el('div', { id: 'creatures' });
const modEl = el('div', { id: 'mod' });
// Collapsed by default: vanilla ships a good few creatures with no art of
// its own, and that list is long enough to bury the creature list above it.
const finderSection = el('details', { id: 'finder-section' });
const finderEl = el('div', { id: 'finder' });
const finderSummary = el('summary', { textContent: 'Missing art' });
finderSection.append(finderSummary, finderEl);
projectEl.append(el('h3', { textContent: 'Creatures' }), creaturesEl, modEl, finderSection);

const spritesEl = shell.contentFor('sprites');
const checklistEl = el('div', { id: 'checklist' });
const layersEl = el('div', { id: 'layers' });
spritesEl.append(checklistEl, layersEl);

const propertiesEl = shell.contentFor('properties');
const shadingEl = el('div', { id: 'shading', className: 'properties-section' });
const figureControlsEl = el('div', { id: 'figure-controls', className: 'properties-section' });
const sizePickerEl = el('div', { id: 'size-picker', className: 'properties-section' });
propertiesEl.append(el('h3', { textContent: 'Shading' }), shadingEl, figureControlsEl, sizePickerEl);

const previewEl = shell.contentFor('preview');
const sceneEl = el('div', { id: 'scene' });
const figureEl = el('div', { id: 'figure' });
previewEl.append(sceneEl, figureEl);

const referenceEl = shell.contentFor('reference');
const styleEl = shell.contentFor('checker');
const aiEl = shell.contentFor('ai');
// Palette lives in the left tool strip, under the tools.
const paletteEl = el('div', { id: 'palette-strip' });

const PANELS: PanelDef[] = [
  { id: 'project', title: 'Project' },
  { id: 'sprites', title: 'Sprites' },
  { id: 'properties', title: 'Properties' },
  { id: 'preview', title: 'Preview' },
  { id: 'reference', title: 'Reference' },
  { id: 'checker', title: 'Checker' },
  { id: 'ai', title: 'AI' },
];
restoreOrBuildLayout(shell, PANELS);
persistLayoutOnChange(shell);

// --- Window menu: reopen a panel closed via its tab's X --------------------
// Dockview lets every tab (including the canvas) close with no built-in way
// back, which is a dead end once you don't know this menu exists. One button
// per panel; its look tracks whether that panel is currently open.
const WINDOW_PANELS: PanelDef[] = [{ id: 'canvas-panel', title: 'Canvas' }, ...PANELS];
const windowButtons = WINDOW_PANELS.map(def => {
  const btn = el('button', { type: 'button', textContent: def.title, title: `Show the ${def.title} panel (reopens it if you closed its tab)` });
  btn.addEventListener('click', () => reopenPanel(shell, def));
  return btn;
});
function refreshWindowButtons(): void {
  WINDOW_PANELS.forEach((def, i) => windowButtons[i].classList.toggle('active', !!shell.dockview.getPanel(def.id)));
}
shell.dockview.onDidLayoutChange(refreshWindowButtons);
refreshWindowButtons();

const canvasView = createCanvasView(store, canvasEl, STATS);
createReferencePanel(store, referenceEl, STATS);
createCreatureListPanel(store, creaturesEl);
createModPanel(store, modEl, VANILLA_INDEX);
createChecklistPanel(store, checklistEl, STATS);
createLayerTreePanel(store, layersEl, checklistEl, STATS);
createGeneratePanel(store, aiEl, STATS, STYLE);
createDfLookPanel(store, aiEl);
const scenePreview = createScenePreviewPanel(store, sceneEl);
const figurePanel = createFigurePanel(store, figureEl, sceneEl, figureControlsEl);
createFinderPanel(store, finderEl, finderSummary);
createStylePanel(store, styleEl, STATS, STYLE);
createSizePickerPanel(store, sizePickerEl);

// The Scene Preview panel's fitZoom only fires from a ResizeObserver, which
// doesn't trigger on a dockview tab switch when the panel keeps its full
// size while inactive (renderer: 'always' panels aren't display:none'd, just
// hidden, so their box never actually changes size). Re-fit whenever this
// panel's tab becomes the active/visible one.
const previewPanel = shell.dockview.getPanel('preview');
previewPanel?.api.onDidActiveChange(e => { if (e.isActive) { scenePreview.fitZoom(); figurePanel.fitZoom(); } });
previewPanel?.api.onDidVisibilityChange(e => { if (e.isVisible) { scenePreview.fitZoom(); figurePanel.fitZoom(); } });

// --- Left tool strip: draw tools, mirror/grid, palette -------------------

// Any tool switch commits a pending Move first, so Pencil/Fill/etc. never
// have to know about a floating layer -- by the time they run, it's already
// been stamped down.
function switchTool(tool: Tool): void {
  canvasView.commitFloating();
  store.update(s => { s.ui.tool = tool; });
}

function toolButton(tool: Tool, label: string, hint: string): HTMLButtonElement {
  const btn = el('button', { type: 'button', textContent: label, title: hint, className: 'toolstrip-btn' });
  btn.addEventListener('click', () => switchTool(tool));
  store.subscribe(s => btn.classList.toggle('active', s.ui.tool === tool));
  return btn;
}

function toggleButton(label: string, hint: string, get: (s: AppState) => boolean, set: (s: AppState) => void): HTMLButtonElement {
  const btn = el('button', { type: 'button', textContent: label, title: hint, className: 'toolstrip-btn' });
  btn.addEventListener('click', () => store.update(set));
  store.subscribe(s => btn.classList.toggle('active', get(s)));
  return btn;
}

function actionButton(label: string, hint: string, action: () => void): HTMLButtonElement {
  const btn = el('button', { type: 'button', textContent: label, title: hint });
  btn.addEventListener('click', action);
  return btn;
}

// A whole-sprite edit (outline, apply light) stores before/after like a
// pointer stroke does in canvas.ts, since it isn't driven by pointer events.
function pushSpriteEdit(label: string, before: Uint8ClampedArray): void {
  const after = store.get().project.sprite.data.slice() as Uint8ClampedArray;
  const entry: HistoryEntry = {
    label,
    undo: () => { store.get().project.sprite.data.set(before); store.notify(); },
    redo: () => { store.get().project.sprite.data.set(after); store.notify(); },
  };
  store.update(() => {}, entry);
}

function lightDirSelect(): HTMLSelectElement {
  const select = el('select');
  for (const dir of LIGHT_DIRS) select.appendChild(el('option', { value: dir, textContent: dir }));
  select.value = store.get().ui.lightDir;
  select.addEventListener('change', () => {
    store.update(s => { s.ui.lightDir = select.value as LightDir; });
  });
  return select;
}

function brushSizeControl(): HTMLElement {
  const wrap = el('span', { className: 'toolstrip-brush', title: 'Brush size ([ / ])' });
  const label = el('span', { id: 'brush-size-label', textContent: '1px' });
  const dec = el('button', { type: 'button', textContent: '-' });
  const inc = el('button', { type: 'button', textContent: '+' });
  dec.addEventListener('click', () => store.update(s => { s.ui.brushSize = Math.max(1, s.ui.brushSize - 1); }));
  inc.addEventListener('click', () => store.update(s => { s.ui.brushSize = Math.min(4, s.ui.brushSize + 1); }));
  store.subscribe(s => { label.textContent = `${s.ui.brushSize}px`; });
  wrap.append(dec, label, inc);
  return wrap;
}

shell.toolstrip.append(
  toolButton('pencil', 'Pencil', 'Pencil: draw with the current colour, one pixel (or brush size) at a time'),
  toolButton('eraser', 'Eraser', 'Eraser: clear pixels to transparent'),
  toolButton('fill', 'Fill', 'Fill: flood-fill the clicked area with the current colour'),
  toolButton('line', 'Line', 'Line: drag to draw a straight line'),
  toolButton('rect', 'Rectangle', 'Rectangle: drag to draw a rectangle outline'),
  toolButton('marquee', 'Marquee', 'Marquee: drag to select a rectangular region (for Move, Flip, Rotate)'),
  toolButton('move', 'Move', 'Move: drag the current marquee selection to a new spot'),
  toolButton('picker', 'Picker', 'Picker: click a pixel to pick up its colour'),
  brushSizeControl(),
  el('div', { className: 'toolstrip-divider' }),
  toggleButton('Mirror', 'Mirror: draw strokes on both sides of the sprite at once', s => s.ui.mirrorX, s => { s.ui.mirrorX = !s.ui.mirrorX; }),
  toggleButton('Grid', 'Grid: show a pixel grid over the canvas', s => s.ui.showGrid, s => { s.ui.showGrid = !s.ui.showGrid; }),
);
createPalettePanel(store, paletteEl);
shell.toolstrip.append(paletteEl);

// --- Properties panel: shading operations (was the old toolbar) ----------

shadingEl.append(
  actionButton('Darker', 'Darker: step the current colour one shade darker on its palette ramp', () => store.update(s => { s.ui.colour = rampStep(s.project.palette, s.ui.colour, -1); })),
  actionButton('Lighter', 'Lighter: step the current colour one shade lighter on its palette ramp', () => store.update(s => { s.ui.colour = rampStep(s.project.palette, s.ui.colour, 1); })),
  actionButton('Outline', 'Outline: auto-outline the sprite using its palette ramp', () => {
    const { project } = store.get();
    const before = project.sprite.data.slice() as Uint8ClampedArray;
    outline(project.sprite, project.palette, 'ramp');
    pushSpriteEdit('outline', before);
  }),
  lightDirSelect(),
  actionButton('Apply light', 'Apply light: shade the sprite from the chosen light direction', () => {
    const { project, ui } = store.get();
    const before = project.sprite.data.slice() as Uint8ClampedArray;
    for (const hint of lightHints(project.sprite, ui.lightDir)) {
      const i = (hint.y * project.sprite.width + hint.x) * 4;
      const colour: [number, number, number, number] = [
        project.sprite.data[i], project.sprite.data[i + 1], project.sprite.data[i + 2], project.sprite.data[i + 3],
      ];
      const shaded = rampStep(project.palette, colour, hint.kind === 'lit' ? 1 : -1);
      project.sprite.data[i] = shaded[0]; project.sprite.data[i + 1] = shaded[1];
      project.sprite.data[i + 2] = shaded[2]; project.sprite.data[i + 3] = shaded[3];
    }
    pushSpriteEdit('apply light', before);
  }),
);

// --- Menu bar: File (Connect DF folder), Edit (Undo/Redo) ----------------

const connectBtn = el('button', {
  type: 'button', id: 'connect-df-folder', textContent: 'Connect DF folder',
  title: 'Connect DF folder: point at your Dwarf Fortress install so vanilla raws and art are available as reference',
});
connectBtn.addEventListener('click', () => { void pickAndConnectDfFolder(store); });
const undoBtn = el('button', { type: 'button', textContent: 'Undo', title: 'Undo the last edit' });
undoBtn.addEventListener('click', () => store.undo());
const redoBtn = el('button', { type: 'button', textContent: 'Redo', title: 'Redo the last undone edit' });
redoBtn.addEventListener('click', () => store.redo());

// Flip/rotate. They act on the marquee selection when
// one exists, else the whole sprite as before. Flip always applies (dimensions never change).
// Rotate 90 is enabled for a square marquee, a square sprite, or a
// LARGE_IMAGE entry whose size picker allows the swapped size (rotateEntry
// then resizes it, clearing undo history the same way a manual resize does).
function flipHorizontalBtn(): void {
  const state = store.get();
  const sel = state.ui.marquee;
  const before = state.project.sprite.data.slice() as Uint8ClampedArray;
  if (sel) stamp(state.project.sprite, sel.x, sel.y, flip(crop(state.project.sprite, sel), 'x'));
  else state.project.sprite.data.set(flip(state.project.sprite, 'x').data);
  pushSpriteEdit('flip horizontal', before);
}
function flipVerticalBtn(): void {
  const state = store.get();
  const sel = state.ui.marquee;
  const before = state.project.sprite.data.slice() as Uint8ClampedArray;
  if (sel) stamp(state.project.sprite, sel.x, sel.y, flip(crop(state.project.sprite, sel), 'y'));
  else state.project.sprite.data.set(flip(state.project.sprite, 'y').data);
  pushSpriteEdit('flip vertical', before);
}
function canRotate(s: AppState): boolean {
  const sel = s.ui.marquee;
  if (sel) return sel.w === sel.h;
  const { sprite } = s.project;
  if (sprite.width === sprite.height) return true;
  const entrySel = s.ui.selection;
  return !!entrySel && !!entrySizeInfo(store, entrySel, entrySel.entryKey);
}
function rotateBtnAction(): void {
  const s = store.get();
  const sel = s.ui.marquee;
  if (sel && sel.w === sel.h) {
    const before = s.project.sprite.data.slice() as Uint8ClampedArray;
    stamp(s.project.sprite, sel.x, sel.y, rotate90(crop(s.project.sprite, sel)));
    pushSpriteEdit('rotate 90', before);
    return;
  }
  const { sprite } = s.project;
  if (sprite.width === sprite.height) {
    const before = sprite.data.slice() as Uint8ClampedArray;
    sprite.data.set(rotate90(sprite).data);
    pushSpriteEdit('rotate 90', before);
    return;
  }
  const entrySel = s.ui.selection;
  if (entrySel) rotateEntry(store, entrySel, entrySel.entryKey);
}
const flipHBtn = actionButton('Flip H', 'Flip H: mirror the selection (or whole sprite) left-right', flipHorizontalBtn);
flipHBtn.id = 'edit-flip-h';
const flipVBtn = actionButton('Flip V', 'Flip V: mirror the selection (or whole sprite) top-bottom', flipVerticalBtn);
flipVBtn.id = 'edit-flip-v';
const rotateBtn = actionButton('Rotate 90°', 'Rotate 90°: rotate the selection (or whole sprite) a quarter turn', rotateBtnAction);
rotateBtn.id = 'edit-rotate';
store.subscribe(s => { rotateBtn.disabled = !canRotate(s); });

shell.menubar.append(
  el('span', { className: 'menubar-label', textContent: 'File' }), connectBtn,
  el('span', { className: 'menubar-label', textContent: 'Edit' }), undoBtn, redoBtn, flipHBtn, flipVBtn, rotateBtn,
  el('span', { className: 'menubar-label', textContent: 'Window', title: 'Reopen a panel you closed' }), ...windowButtons,
  el('span', { className: 'menubar-title', textContent: 'DF Sprite Studio' }),
);
autoConnectDfFolder(store);

// --- Status bar: zoom, tool, DF connection, dirty marker ------------------

const zoomOutBtn = actionButton('Zoom -', 'Zoom out', () => store.update(s => { s.ui.zoom = Math.max(2, s.ui.zoom / 2); }));
const zoomInBtn = actionButton('Zoom +', 'Zoom in', () => store.update(s => { s.ui.zoom = Math.min(64, s.ui.zoom * 2); }));
// Zoom to fit: largest integer zoom that fits the
// canvas region, as a real zoom level rather than a CSS scale
// (fitToContainer in canvas.ts only ever scales the CSS box, never changes
// ui.zoom or the drawing math).
function zoomToFit(): void {
  const parent = canvasEl.parentElement;
  const { sprite } = store.get().project;
  if (!parent || !parent.clientWidth || !parent.clientHeight) return;
  const z = Math.max(1, Math.floor(Math.min(parent.clientWidth / sprite.width, parent.clientHeight / sprite.height)));
  store.update(s => { s.ui.zoom = z; });
}
const zoomFitBtn = actionButton('Fit', 'Fit: zoom to fill the canvas view', zoomToFit);
zoomFitBtn.id = 'zoom-fit';
const zoomLabel = el('span', { className: 'statusbar-item' });
const toolLabel = el('span', { className: 'statusbar-item' });
const sizeLabel = el('span', { className: 'statusbar-item' });
// Selection size/state, so the marquee/floating state has a
// concrete on-screen signal beyond the marching-ants outline.
const selLabel = el('span', { className: 'statusbar-item' });
const dfLabel = el('span', { className: 'statusbar-item' });
const dirtyLabel = el('span', { className: 'statusbar-item statusbar-dirty' });

shell.statusbar.append(zoomOutBtn, zoomLabel, zoomInBtn, zoomFitBtn, toolLabel, sizeLabel, selLabel, dfLabel, dirtyLabel);

store.subscribe(s => {
  zoomLabel.textContent = `${s.ui.zoom}x`;
  toolLabel.textContent = s.ui.tool;
  const { sprite } = s.project;
  const tw = sprite.width / SPRITE_SIZE, th = sprite.height / SPRITE_SIZE;
  sizeLabel.textContent = `${tw}x${th} (${sprite.width}x${sprite.height})`;
  selLabel.textContent = s.ui.floating ? 'sel (floating)' : (s.ui.marquee ? `sel ${s.ui.marquee.w}x${s.ui.marquee.h}` : '');
  dfLabel.textContent = s.ui.vanillaScan ? 'DF: connected' : (s.ui.vanillaScanStatus || 'DF: not connected');
  dirtyLabel.textContent = store.history.canUndo ? '● unsaved' : '';
});

// --- Keyboard shortcuts, bound once at the shell level --------------------

// In-app clipboard for Ctrl+C/X/V: not undoable itself, same
// as ui.reference -- it guides a later paste but isn't part of saved state.
// No cross-app clipboard.
let clipboard: { x: number; y: number; image: RgbaImage } | null = null;

window.addEventListener('keydown', ev => {
  const target = ev.target as HTMLElement | null;
  if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
  if (ev.key === 'Tab') { ev.preventDefault(); shell.toolstrip.classList.toggle('hidden'); document.getElementById('dock')?.classList.toggle('hidden'); return; }
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') {
    ev.preventDefault();
    if (ev.shiftKey) store.redo(); else store.undo();
    return;
  }
  if ((ev.ctrlKey || ev.metaKey) && ev.key === '0') { ev.preventDefault(); zoomToFit(); return; }
  if (ev.shiftKey && (ev.key === 'H' || ev.key === 'h')) { flipHorizontalBtn(); return; }
  if (ev.shiftKey && (ev.key === 'V' || ev.key === 'v')) { flipVerticalBtn(); return; }
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'a') {
    ev.preventDefault();
    canvasView.commitFloating();
    const { sprite } = store.get().project;
    store.update(s => { s.ui.marquee = { x: 0, y: 0, w: sprite.width, h: sprite.height }; });
    return;
  }
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'd') {
    ev.preventDefault();
    canvasView.commitFloating();
    store.update(s => { s.ui.marquee = null; });
    return;
  }
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'c') {
    const sel = store.get().ui.marquee;
    if (sel) clipboard = { x: sel.x, y: sel.y, image: crop(store.get().project.sprite, sel) };
    return;
  }
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'x') {
    const sel = store.get().ui.marquee;
    if (sel) {
      clipboard = { x: sel.x, y: sel.y, image: crop(store.get().project.sprite, sel) };
      canvasView.deleteSelection();
    }
    return;
  }
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'v') {
    if (clipboard) canvasView.pasteFloating(clipboard.image, clipboard.x, clipboard.y);
    return;
  }
  if (ev.key === 'Delete' || ev.key === 'Backspace') { canvasView.deleteSelection(); return; }
  if (ev.key === 'Enter') { canvasView.commitFloating(); return; }
  if (ev.key === 'Escape') { canvasView.cancelFloating(); return; }
  if (store.get().ui.floating && ev.key.startsWith('Arrow')) {
    ev.preventDefault();
    const dx = ev.key === 'ArrowLeft' ? -1 : ev.key === 'ArrowRight' ? 1 : 0;
    const dy = ev.key === 'ArrowUp' ? -1 : ev.key === 'ArrowDown' ? 1 : 0;
    store.update(s => { if (s.ui.floating) { s.ui.floating.x += dx; s.ui.floating.y += dy; } });
    return;
  }
  switch (ev.key) {
    case 'b': case 'B': switchTool('pencil'); break;
    case 'e': case 'E': switchTool('eraser'); break;
    case 'g': case 'G': switchTool('fill'); break;
    case 'l': case 'L': switchTool('line'); break;
    case 'u': case 'U': switchTool('rect'); break;
    case 's': case 'S': switchTool('marquee'); break;
    case 'v': switchTool('move'); break;
    case 'i': case 'I': switchTool('picker'); break;
    case 'm': case 'M': store.update(s => { s.ui.mirrorX = !s.ui.mirrorX; }); break;
    case "'": store.update(s => { s.ui.showGrid = !s.ui.showGrid; }); break;
    case '+': case '=': store.update(s => { s.ui.zoom = Math.min(64, s.ui.zoom * 2); }); break;
    case '-': store.update(s => { s.ui.zoom = Math.max(2, s.ui.zoom / 2); }); break;
    case '[': store.update(s => { s.ui.brushSize = Math.max(1, s.ui.brushSize - 1); }); break;
    case ']': store.update(s => { s.ui.brushSize = Math.min(4, s.ui.brushSize + 1); }); break;
  }
});
canvasEl.addEventListener('wheel', ev => {
  if (!ev.ctrlKey) return;
  ev.preventDefault();
  store.update(s => { s.ui.zoom = ev.deltaY < 0 ? Math.min(64, s.ui.zoom * 2) : Math.max(2, s.ui.zoom / 2); });
}, { passive: false });

store.notify();
