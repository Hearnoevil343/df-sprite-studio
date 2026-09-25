// Reference and proportion guide panel: DF folder access, browsing vanilla
// sprites by creature, loading any PNG, onion skin, side-by-side view with a
// linked cursor, "start from reference", and the guide group pickers.
import { crop, fitReference, readMod, snapToPalette } from '../../engine/index.ts';
import type { ModCreature, RgbaImage, VanillaStats } from '../../engine/index.ts';
import { createFilePicker } from '../dom/file-picker.ts';
import { decodeImageBlob, decodeImageFile } from '../io/browser-png.ts';
import { readModFolder } from '../io/mod-io.ts';
import { findCreatureSprites, listCreatures } from '../io/vanilla-scan.ts';
import type { FoundSprite, VanillaScan } from '../io/vanilla-scan.ts';
import type { HistoryEntry } from '../state/history.ts';
import type { Store } from '../state/store.ts';

const THUMB_ZOOM = 2;

function setReference(store: Store, image: RgbaImage, name: string): void {
  store.update(s => {
    const prev = s.ui.reference;
    s.ui.reference = { image, name, onionSkin: prev?.onionSkin ?? false, onionOpacity: prev?.onionOpacity ?? 0.5, sideBySide: true };
  });
}

function pushSpriteEdit(store: Store, label: string, before: Uint8ClampedArray): void {
  const after = store.get().project.sprite.data.slice() as Uint8ClampedArray;
  const entry: HistoryEntry = {
    label,
    undo: () => { store.get().project.sprite.data.set(before); store.notify(); },
    redo: () => { store.get().project.sprite.data.set(after); store.notify(); },
  };
  store.update(() => {}, entry);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props);
}

function modCreatureLabel(c: ModCreature): string {
  return c.caste ? `${c.id}:${c.caste}` : c.id;
}

function paintThumb(cv: HTMLCanvasElement, img: RgbaImage): void {
  const ctx = cv.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      if (img.data[i + 3] === 0) continue;
      ctx.fillStyle = `rgba(${img.data[i]}, ${img.data[i + 1]}, ${img.data[i + 2]}, ${img.data[i + 3] / 255})`;
      ctx.fillRect(x * THUMB_ZOOM, y * THUMB_ZOOM, THUMB_ZOOM, THUMB_ZOOM);
    }
  }
}

export function createReferencePanel(store: Store, container: HTMLElement, stats: VanillaStats): { render: () => void } {
  let scannedFor: VanillaScan | null = null;
  let sprites: FoundSprite[] = [];
  const pngCache = new Map<string, Promise<RgbaImage>>();
  let modCreatures: ModCreature[] = [];
  // Bumped on every onCreatureChange so a stale call's async thumbnail loads
  // (still resolving after the user has already moved on to another
  // creature) can tell they're no longer current and skip touching the DOM.
  let lineupToken = 0;

  // Memoized against the exact (image, target size) last fitted, same as the
  // main canvas's onion skin.
  let fitCache: { src: RgbaImage; w: number; h: number; out: RgbaImage } | null = null;
  function fittedRef(ref: RgbaImage, w: number, h: number): RgbaImage {
    if (fitCache && fitCache.src === ref && fitCache.w === w && fitCache.h === h) return fitCache.out;
    const out = fitReference(ref, w, h);
    fitCache = { src: ref, w, h, out };
    return out;
  }

  const status = el('div', { className: 'ref-status', textContent: 'No DF folder connected.' });
  const creatureSelect = el('select');
  const lineup = el('div', { className: 'ref-lineup' });
  const loadModFolderBtn = el('button', { type: 'button', textContent: 'Load mod folder...' });
  const modStatus = el('div', { className: 'ref-status', textContent: 'No mod folder loaded.' });
  const modCreatureSelect = el('select');
  const modLineup = el('div', { className: 'ref-lineup' });
  const { wrap: loadPngWrap, input: loadPngInput } = createFilePicker({ accept: 'image/png', buttonLabel: 'Load PNG...' });
  const startFromRefBtn = el('button', { type: 'button', textContent: 'Start from reference', disabled: true });
  const onionCheck = el('input', { type: 'checkbox' });
  const onionOpacity = el('input', { type: 'range', min: '0.1', max: '0.9', step: '0.05', value: '0.5' });
  const refCanvas = el('canvas', { className: 'ref-canvas' });
  const guideCheck = el('input', { type: 'checkbox' });
  const pageSelect = el('select');
  const tokenSelect = el('select');

  function pngFor(path: string): Promise<RgbaImage> {
    let p = pngCache.get(path);
    if (!p) {
      const handle = store.get().ui.vanillaScan?.pngHandles.get(path);
      p = handle ? decodeImageFile(handle) : Promise.reject(new Error(`missing png: ${path}`));
      // Only cache a successful decode. A transient failure (a slow/network
      // drive, a handle briefly losing permission) would otherwise poison
      // this path forever -- every creature sharing that tile page would
      // show "missing" for the rest of the session even once the underlying
      // read would succeed again.
      p.catch(() => { pngCache.delete(path); });
      pngCache.set(path, p);
    }
    return p;
  }

  async function loadSprite(s: FoundSprite): Promise<RgbaImage | null> {
    if (!s.pngPath) return null;
    try {
      const page = await pngFor(s.pngPath);
      return crop(page, s.rect);
    } catch {
      return null;
    }
  }

  async function renderLineup(token: number): Promise<void> {
    lineup.innerHTML = '';
    for (const s of sprites) {
      const label = s.caste ? `${s.token}:${s.caste}` : s.token;
      const wrap = el('div', { className: 'ref-thumb', title: `${label} (${s.page})` });
      const cv = el('canvas', { width: s.rect.w * THUMB_ZOOM, height: s.rect.h * THUMB_ZOOM });
      wrap.append(cv, el('span', { textContent: label }));
      lineup.appendChild(wrap);
      loadSprite(s).then(img => {
        // The creature changed again while this decode was in flight -- the
        // lineup has already moved on, so leave this stale result alone.
        if (token !== lineupToken) return;
        if (!img) {
          wrap.classList.add('ref-thumb-missing');
          wrap.title = 'Sprite file missing on this install';
          return;
        }
        paintThumb(cv, img);
        wrap.addEventListener('click', () => setReference(store, img, `${creatureSelect.value} ${label}`));
      });
    }
  }

  async function onCreatureChange(): Promise<void> {
    const scan = store.get().ui.vanillaScan;
    if (!scan) return;
    const token = ++lineupToken;
    sprites = findCreatureSprites(scan, creatureSelect.value);
    await renderLineup(token);
  }

  async function onScanChange(): Promise<void> {
    const scan = store.get().ui.vanillaScan;
    if (scan === scannedFor) return;
    scannedFor = scan;
    if (!scan) { creatureSelect.innerHTML = ''; sprites = []; await renderLineup(++lineupToken); return; }
    const creatures = listCreatures(scan);
    creatureSelect.innerHTML = '';
    for (const id of creatures) creatureSelect.appendChild(el('option', { value: id, textContent: id }));
    await onCreatureChange();
  }

  creatureSelect.addEventListener('change', onCreatureChange);

  function renderModLineup(): void {
    modLineup.innerHTML = '';
    const c = modCreatures.find(mc => modCreatureLabel(mc) === modCreatureSelect.value);
    if (!c) return;
    for (const [key, img] of Object.entries(c.sprites)) {
      const wrap = el('div', { className: 'ref-thumb', title: key });
      const cv = el('canvas', { width: img.width * THUMB_ZOOM, height: img.height * THUMB_ZOOM });
      wrap.append(cv, el('span', { textContent: key }));
      modLineup.appendChild(wrap);
      paintThumb(cv, img);
      wrap.addEventListener('click', () => setReference(store, img, `${modCreatureSelect.value} ${key}`));
    }
  }

  modCreatureSelect.addEventListener('change', renderModLineup);

  loadModFolderBtn.addEventListener('click', async () => {
    let dir: FileSystemDirectoryHandle;
    try {
      dir = await window.showDirectoryPicker({ id: 'df-reference-mod' });
    } catch {
      return; // user cancelled the picker
    }
    modStatus.textContent = 'Reading mod folder...';
    const files = await readModFolder(dir);
    const { mod, creatures, layered, warnings } = readMod(files);
    modCreatures = creatures;
    modCreatureSelect.innerHTML = '';
    if (creatures.length === 0 && layered.length > 0) {
      // A layered-only mod (LAYER_SET creatures) has nothing readMod puts in
      // `creatures` -- leaving the select genuinely empty here reads as
      // broken. Say so in the select itself, not just the status line below.
      modCreatureSelect.appendChild(el('option', { value: '', textContent: `(${layered.length} layered creature(s) -- open in Sprites panel)` }));
      modCreatureSelect.disabled = true;
    } else {
      modCreatureSelect.disabled = false;
      for (const c of creatures) modCreatureSelect.appendChild(el('option', { value: modCreatureLabel(c), textContent: modCreatureLabel(c) }));
    }
    renderModLineup();
    const layeredNote = layered.length ? `, ${layered.length} layered (open in Sprites panel)` : '';
    modStatus.textContent = creatures.length || layered.length
      ? `${mod.name || dir.name}: ${creatures.length} creature(s)${layeredNote}.`
      : `${mod.name || dir.name}: no usable graphics found${warnings.length ? ` (${warnings[0]})` : ''}.`;
  });

  loadPngInput.addEventListener('change', async () => {
    const file = loadPngInput.files?.[0];
    if (!file) return;
    const image = await decodeImageBlob(file);
    setReference(store, image, file.name);
    loadPngInput.value = '';
  });

  startFromRefBtn.addEventListener('click', () => {
    const { project, ui } = store.get();
    if (!ui.reference) return;
    const fitted = fittedRef(ui.reference.image, project.sprite.width, project.sprite.height);
    const snapped = snapToPalette(fitted, project.palette);
    const before = project.sprite.data.slice() as Uint8ClampedArray;
    project.sprite.data.set(snapped.data);
    pushSpriteEdit(store, 'start from reference', before);
  });

  onionCheck.addEventListener('change', () => {
    store.update(s => { if (s.ui.reference) s.ui.reference.onionSkin = onionCheck.checked; });
  });
  onionOpacity.addEventListener('input', () => {
    store.update(s => { if (s.ui.reference) s.ui.reference.onionOpacity = Number(onionOpacity.value); });
  });

  guideCheck.addEventListener('change', () => {
    store.update(s => { s.ui.guide.show = guideCheck.checked; });
  });
  pageSelect.addEventListener('change', () => {
    store.update(s => { s.ui.guide.page = pageSelect.value || undefined; });
  });
  tokenSelect.addEventListener('change', () => {
    store.update(s => { s.ui.guide.token = tokenSelect.value || undefined; });
  });

  pageSelect.appendChild(el('option', { value: '', textContent: '(any page)' }));
  for (const page of Object.keys(stats.proportions.byPage).sort()) pageSelect.appendChild(el('option', { value: page, textContent: page }));
  tokenSelect.appendChild(el('option', { value: '', textContent: '(any token)' }));
  for (const token of Object.keys(stats.proportions.byToken).sort()) tokenSelect.appendChild(el('option', { value: token, textContent: token }));

  // Linked cursor: hovering the reference canvas moves the shared hover
  // pixel too, same as hovering the sprite canvas (see canvas.ts).
  function refPixelAt(ev: PointerEvent): { x: number; y: number } | null {
    const { ui } = store.get();
    if (!ui.reference) return null;
    const rect = refCanvas.getBoundingClientRect();
    const zoom = store.get().ui.zoom;
    const x = Math.floor(((ev.clientX - rect.left) / rect.width) * (refCanvas.width / zoom));
    const y = Math.floor(((ev.clientY - rect.top) / rect.height) * (refCanvas.height / zoom));
    return x >= 0 && y >= 0 && x * zoom < refCanvas.width && y * zoom < refCanvas.height ? { x, y } : null;
  }
  refCanvas.addEventListener('pointermove', ev => store.update(s => { s.ui.hover = refPixelAt(ev); }));
  refCanvas.addEventListener('pointerleave', () => store.update(s => { s.ui.hover = null; }));

  function render(): void {
    const { project, ui } = store.get();
    void onScanChange();
    status.textContent = ui.vanillaScan ? `Connected: ${listCreatures(ui.vanillaScan).length} creatures found.` : ui.vanillaScanStatus || 'No DF folder connected.';
    const ref = ui.reference;
    startFromRefBtn.disabled = !ref;
    onionCheck.checked = ref?.onionSkin ?? false;
    onionOpacity.value = String(ref?.onionOpacity ?? 0.5);
    guideCheck.checked = ui.guide.show;
    pageSelect.value = ui.guide.page ?? '';
    tokenSelect.value = ui.guide.token ?? '';

    const zoom = ui.zoom;
    if (!ref) {
      refCanvas.width = 0;
      refCanvas.height = 0;
      return;
    }
    // Scaled to the currently open entry's pixel size, same as the onion
    // skin, so a vanilla 32x32 reference lines up over a resized entry.
    const fitted = fittedRef(ref.image, project.sprite.width, project.sprite.height);
    refCanvas.width = fitted.width * zoom;
    refCanvas.height = fitted.height * zoom;
    const ctx = refCanvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    for (let y = 0; y < fitted.height; y++) {
      for (let x = 0; x < fitted.width; x++) {
        const i = (y * fitted.width + x) * 4;
        const a = fitted.data[i + 3];
        ctx.fillStyle = a === 0 ? ((x + y) % 2 === 0 ? '#3a3a3a' : '#2c2c2c')
          : `rgba(${fitted.data[i]}, ${fitted.data[i + 1]}, ${fitted.data[i + 2]}, ${a / 255})`;
        ctx.fillRect(x * zoom, y * zoom, zoom, zoom);
      }
    }
    if (ui.hover) {
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.strokeRect(ui.hover.x * zoom + 0.5, ui.hover.y * zoom + 0.5, zoom - 1, zoom - 1);
    }
  }

  container.innerHTML = '';
  container.append(
    status,
    el('label', { textContent: 'Creature' }), creatureSelect,
    lineup,
    loadModFolderBtn, modStatus,
    el('label', { textContent: 'Mod creature' }), modCreatureSelect,
    modLineup,
    el('label', { textContent: 'Load PNG' }), loadPngWrap,
    startFromRefBtn,
    el('label', { textContent: 'Onion skin' }), onionCheck, onionOpacity,
    el('div', { className: 'ref-side-by-side-label', textContent: 'Reference' }), refCanvas,
    el('label', { textContent: 'Show guide' }), guideCheck,
    el('label', { textContent: 'Page group' }), pageSelect,
    el('label', { textContent: 'Token' }), tokenSelect,
  );

  store.subscribe(render);
  render();
  return { render };
}
