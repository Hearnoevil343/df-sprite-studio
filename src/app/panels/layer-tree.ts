// Layer tree: the checklist's counterpart for layered creatures.
// Set -> group (labelled by its comment) -> layers, with drawn/missing marks,
// thumbnails and a Reduce picker per layer. Groups start collapsed and only
// the open ones draw thumbnails: 925 live canvases would not do.
import { readLayered, readTile } from '../../engine/index.ts';
import type { PageImages, RgbaImage, VanillaStats } from '../../engine/index.ts';
import { createFilePicker } from '../dom/file-picker.ts';
import { decodeImageBlob, decodeImageFile } from '../io/browser-png.ts';
import type { VanillaScan } from '../io/vanilla-scan.ts';
import { applyAddLayer, applyLayerReduce, closeLayered, flushLayered, groupKey, layerKey, openLayered, selectLayer, toggleGroup } from '../state/layered.ts';
import type { ModLayered, PageRef } from '../state/layered.ts';
import type { Store } from '../state/store.ts';

const THUMB_ZOOM = 2;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props);
}

function isDrawn(img: RgbaImage | undefined): boolean {
  if (!img) return false;
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] !== 0) return true;
  return false;
}

function drawThumb(canvas: HTMLCanvasElement, img: RgbaImage): void {
  canvas.width = img.width * THUMB_ZOOM;
  canvas.height = img.height * THUMB_ZOOM;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      const a = img.data[i + 3];
      ctx.fillStyle = a === 0 ? ((x + y) % 2 === 0 ? '#3a3a3a' : '#2c2c2c') : `rgba(${img.data[i]}, ${img.data[i + 1]}, ${img.data[i + 2]}, ${a / 255})`;
      ctx.fillRect(x * THUMB_ZOOM, y * THUMB_ZOOM, THUMB_ZOOM, THUMB_ZOOM);
    }
  }
}

// A layer with nothing drawn yet (or an ARG layer with no page image at
// all) has no RgbaImage to draw, so the thumbnail canvas was left at its
// default size showing a flat dark square. Draw the same checkerboard the
// main canvas uses for transparency instead, one tile (32px) square.
function drawEmptyThumb(canvas: HTMLCanvasElement): void {
  const w = 32;
  const h = 32;
  canvas.width = w * THUMB_ZOOM;
  canvas.height = h * THUMB_ZOOM;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? '#3a3a3a' : '#2c2c2c';
      ctx.fillRect(x * THUMB_ZOOM, y * THUMB_ZOOM, THUMB_ZOOM, THUMB_ZOOM);
    }
  }
}

export function createLayerTreePanel(store: Store, container: HTMLElement, checklistEl: HTMLElement, stats: VanillaStats): { render: () => void } {
  let scannedFor: VanillaScan | null = null;
  let modLayeredFor: ModLayered[] | null = null;
  const heading = el('h3', { textContent: 'Layered creatures', title: 'Creatures built from LAYER_SET graphics (e.g. equipment/pose layers) live here, not in the Creatures list above' });
  const status = el('div', { className: 'lt-note', textContent: 'Open a mod folder, or connect a DF folder.' });
  const picker = el('select');
  const openBtn = el('button', { type: 'button', textContent: 'Open layered creature' });
  const closeBtn = el('button', { type: 'button', textContent: 'Close layered' });
  const tree = el('div', { className: 'lt-tree' });
  const head = el('div', { className: 'lt-head' });
  head.append(picker, openBtn);
  openBtn.style.display = picker.style.display = 'none';

  const hasLayers = (b: { children: { args: string[] }[] }) => b.children.some(t => t.args[0] === 'LAYER_SET');

  // The picker lists the opened mod's layer-set creatures first, then the
  // connected DF folder's. Option values say which list a choice came from,
  // since a mod commonly reuses a vanilla creature's id -- and gives the same
  // id two blocks of its own (a portrait layer set in a second file, say),
  // which is why each option is labelled with its file.
  function rebuildPicker(): void {
    const { ui } = store.get();
    const scan = ui.vanillaScan;
    if (scan === scannedFor && ui.modLayered === modLayeredFor) return;
    scannedFor = scan;
    modLayeredFor = ui.modLayered;
    picker.innerHTML = '';
    ui.modLayered.forEach((m, i) => picker.appendChild(el('option', { value: `mod:${i}`, textContent: m.label })));
    const ids = new Set<string>();
    if (scan) for (const { doc } of scan.docs) for (const cg of doc.creatureGraphics()) if (!cg.isStatue && hasLayers(cg.block)) ids.add(cg.creatureId);
    for (const id of [...ids].sort()) picker.appendChild(el('option', { value: `df:${id}`, textContent: id }));
    const total = ui.modLayered.length + ids.size;
    picker.style.display = openBtn.style.display = total ? '' : 'none';
    status.textContent = total
      ? `${total} layered creature(s)${ui.modLayered.length ? ` (${ui.modLayered.length} from the mod)` : ''}.`
      : store.get().ui.vanillaScanStatus || 'Open a mod folder, or connect a DF folder.';
  }

  openBtn.addEventListener('click', async () => {
    const state = store.get();
    if (picker.value.startsWith('mod:')) {
      const m = state.ui.modLayered[Number(picker.value.slice(4))];
      if (!m) return;
      openLayered(store, m.lg, m.id, m.path, m.pages, m.palettes);
      status.textContent = `${m.label}: ${m.pages.size} page(s) loaded.`;
      return;
    }
    const scan = state.ui.vanillaScan;
    if (!scan) return;
    const id = picker.value.slice('df:'.length);
    for (const { path, doc } of scan.docs) {
      for (const cg of doc.creatureGraphics()) {
        if (cg.isStatue || cg.creatureId !== id || !hasLayers(cg.block)) continue;
        status.textContent = `Loading ${id}...`;
        const lg = readLayered(doc, cg.block);
        const used = new Set<string>();
        for (const s of lg.sets) for (const g of s.groups) for (const l of g.layers) if ('page' in l.ref) used.add(l.ref.page);
        const pages: PageImages = new Map();
        for (const pid of used) {
          const p = scan.pages.get(pid), handle = p && scan.pngHandles.get(p.pngPath);
          if (p && handle) pages.set(pid, { tile: p.tile, image: await decodeImageFile(handle) });
        }
        // LS_PALETTE_FILE paths are relative to the graphics file's own
        // directory, same convention as TILE_PAGE FILE (vanilla-scan.ts).
        const dir = path.split('/').slice(0, -1).join('/');
        const palettes = new Map<string, RgbaImage>();
        for (const set of lg.sets) for (const p of set.palettes) {
          if (!p.file || palettes.has(p.file)) continue;
          const joined = dir ? `${dir}/${p.file}` : p.file;
          const handle = scan.pngHandles.get(joined);
          if (handle) palettes.set(p.file, await decodeImageFile(handle));
        }
        openLayered(store, lg, id, path, pages, palettes);
        status.textContent = `${id}: ${pages.size}/${used.size} page(s) loaded.`;
        return;
      }
    }
  });
  closeBtn.addEventListener('click', () => closeLayered(store));

  function render(): void {
    rebuildPicker();
    const { ui, project } = store.get();
    const L = ui.layered;
    container.style.display = 'flex';
    checklistEl.style.display = L ? 'none' : '';
    container.innerHTML = '';
    container.append(heading, status, head);
    if (!L) return;
    flushLayered(store);
    container.append(closeBtn, tree);
    tree.innerHTML = '';
    tree.append(el('div', { textContent: L.creatureId }));
    L.lg.sets.forEach((set, si) => {
      tree.append(el('div', { className: 'lt-note', textContent: `${set.stage ?? 'ADULT'} ${set.state}` }));
      set.groups.forEach((group, gi) => {
        const gk = groupKey(si, gi), isOpen = L.open.has(gk);
        const g = el('div', { className: 'lt-group' });
        const gLabel = el('span', { className: 'lt-group-label', textContent: `${isOpen ? '▾' : '▸'} ${group.label ?? '(group)'} (${group.layers.length})` });
        gLabel.addEventListener('click', () => toggleGroup(store, gk));
        const addBtn = el('button', { type: 'button', className: 'lt-add-layer', textContent: '+ layer', title: 'Add a layer to this group, copying its last layer' });
        addBtn.addEventListener('click', ev => {
          ev.stopPropagation();
          const last = group.layers[group.layers.length - 1];
          if (!last || !('page' in last.ref)) { status.textContent = 'Add layer needs an existing page-backed layer in this group to copy from.'; return; }
          const raw = window.prompt('New layer name:', `${last.name}2`);
          if (!raw) return;
          const name = raw.trim().toUpperCase().replace(/[^A-Z0-9_]+/g, '_');
          if (!name) return;
          if (!L.open.has(gk)) toggleGroup(store, gk);
          applyAddLayer(store, si, gi, group, name, last.ref, last);
        });
        g.append(gLabel, addBtn);
        tree.append(g);
        if (!isOpen) return;
        const wrap = el('div', { className: 'lt-layers' });
        group.layers.forEach((layer, li) => {
          const key = layerKey(si, gi, li);
          const row = el('div', { className: 'checklist-row' });
          row.classList.toggle('active', L.selected?.key === key);
          const cv = el('canvas', { className: 'checklist-thumb' });
          let img: RgbaImage | undefined;
          if ('page' in layer.ref) {
            img = L.selected?.key === key ? project.sprite : readTile(L.pages, layer.ref);
            if (img) drawThumb(cv, img); else drawEmptyThumb(cv);
          } else {
            drawEmptyThumb(cv);
          }
          const label = 'page' in layer.ref ? layer.name + (isDrawn(img) ? '' : ' (missing)') : `${layer.name} (ARG)`;
          row.append(cv, el('span', { textContent: label }));
          if ('page' in layer.ref && img) {
            const ref = layer.ref as PageRef;
            row.addEventListener('click', () => selectLayer(store, key, ref));
            if (img.width === img.height) {
              const { wrap: pickerWrap, input } = createFilePicker({
                accept: 'image/png',
                className: 'checklist-reduce-input',
                buttonLabel: 'Reduce...',
                title: `Reduce an image into ${layer.name}`,
              });
              pickerWrap.addEventListener('click', ev => ev.stopPropagation());
              input.addEventListener('change', async () => {
                const f = input.files?.[0];
                if (f) applyLayerReduce(store, key, ref, layer.name, await decodeImageBlob(f), stats);
                input.value = '';
              });
              row.append(pickerWrap);
            }
          }
          wrap.append(row);
        });
        tree.append(wrap);
      });
    });
  }

  store.subscribe(render);
  render();
  return { render };
}
