// DF-look panel: load a generated PNG straight from disk,
// toggle each of the eight df-look finishing passes (src/engine/reduce/
// df-look.ts) with live preview, then write the result into the open
// single-tile entry. Same target()/applySprite() pattern as generate.ts;
// passes run in the same fixed order tools/studio.ts's `df-look` CLI uses,
// regardless of which order the checkboxes were toggled in.
import {
  contrastLift, cropToSubject, deCast, despeckle, paletteAlign, quantize, removeBackground, repairOutline, snapToGrid, levels as stretchLevels,
} from '../../engine/index.ts';
import type { RgbaImage } from '../../engine/index.ts';
import { decodeImageBlob } from '../io/browser-png.ts';
import { noEntryOpenMessage } from '../state/messages.ts';
import { applySprite, sameCreature } from '../state/selection.ts';
import type { Store } from '../state/store.ts';

const PREVIEW_ZOOM = 6;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props);
}

function drawPreview(canvas: HTMLCanvasElement, img: RgbaImage, zoom: number): void {
  canvas.width = img.width * zoom;
  canvas.height = img.height * zoom;
  const ctx = canvas.getContext('2d')!;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      ctx.fillStyle = img.data[i + 3] === 0 ? ((x + y) % 2 === 0 ? '#3a3a3a' : '#2c2c2c') : `rgb(${img.data[i]}, ${img.data[i + 1]}, ${img.data[i + 2]})`;
      ctx.fillRect(x * zoom, y * zoom, zoom, zoom);
    }
  }
}

function checkboxRow(label: string, checked: boolean): { row: HTMLDivElement; box: HTMLInputElement } {
  const box = el('input', { type: 'checkbox', checked });
  const lab = el('label');
  lab.append(box, document.createTextNode(' ' + label));
  const row = el('div', { className: 'dflook-row' });
  row.append(lab);
  return { row, box };
}

function numberField(value: number, width = '3.5em'): HTMLInputElement {
  const inp = el('input', { type: 'number', value: String(value) });
  inp.style.width = width;
  return inp;
}

export function createDfLookPanel(store: Store, container: HTMLElement): void {
  const wrap = el('div', { className: 'dflook-panel' });
  wrap.append(el('div', { textContent: 'DF-look (generated image -> sprite)' }));

  const fileInput = el('input', { type: 'file', accept: 'image/png' });
  wrap.append(fileInput);

  const crop = checkboxRow('Crop to subject', true);
  const toleranceLabel = el('span', { textContent: ' background tolerance (blank = auto)' });
  const toleranceInput = el('input', { type: 'number', step: '0.01', placeholder: 'auto' });
  toleranceInput.style.width = '4.5em';
  crop.row.append(toleranceLabel, toleranceInput);
  const snap = checkboxRow('Snap to grid, cell', true);
  const cellInput = numberField(8);
  snap.row.append(cellInput);
  const decast = checkboxRow('Remove background-colour cast', true);
  const contrast = checkboxRow('Contrast lift  L x', true);
  const lightnessInput = numberField(1.3);
  const chromaLabel = el('span', { textContent: ' C x' });
  const chromaInput = numberField(1.8);
  contrast.row.append(lightnessInput, chromaLabel, chromaInput);
  const levels = checkboxRow('Levels (stretch lightness)', true);
  const quantizeRow = checkboxRow('Quantize to own colours, k', true);
  const quantizeK = numberField(24);
  quantizeRow.row.append(quantizeK);
  const paletteAlignRow = checkboxRow('Palette-align to vanilla, k', false);
  const paletteAlignK = numberField(16);
  paletteAlignRow.row.append(paletteAlignK);
  const despeckleRow = checkboxRow('Despeckle', true);
  const outlineRow = checkboxRow('Repair outline', false);

  const warn = el('div', { className: 'dflook-warn', textContent: 'Repair outline is a no-op after Quantize (off-palette colours) -- pair it with Palette-align instead.' });
  warn.style.display = 'none';

  const rows = el('div', { className: 'dflook-rows' });
  rows.append(crop.row, snap.row, decast.row, contrast.row, levels.row, quantizeRow.row, paletteAlignRow.row, despeckleRow.row, outlineRow.row, warn);
  wrap.append(rows);

  const previewWrap = el('div', { className: 'dflook-preview' });
  const rawCanvas = el('canvas', { className: 'dflook-canvas' });
  const outCanvas = el('canvas', { className: 'dflook-canvas' });
  const rawLabel = el('div', { textContent: 'raw' });
  const outLabel = el('div', { textContent: 'result' });
  const rawCol = el('div'); rawCol.append(rawLabel, rawCanvas);
  const outCol = el('div'); outCol.append(outLabel, outCanvas);
  previewWrap.append(rawCol, outCol);
  wrap.append(previewWrap);

  const applyBtn = el('button', { type: 'button', textContent: 'Write to open entry' });
  applyBtn.disabled = true;
  const status = el('div', { className: 'dflook-status' });
  wrap.append(applyBtn, status);

  container.append(wrap);

  let raw: RgbaImage | null = null;
  let result: RgbaImage | null = null;

  function target() {
    const { project, ui } = store.get();
    const sel = ui.selection;
    const creature = sel && project.creatures.find(c => sameCreature(c, sel));
    return { project, ui, sel, creature };
  }

  function updateWarn(): void {
    warn.style.display = quantizeRow.box.checked && outlineRow.box.checked ? '' : 'none';
  }
  [quantizeRow.box, outlineRow.box].forEach(box => box.addEventListener('change', updateWarn));
  updateWarn();

  function recompute(): void {
    if (!raw) return;
    const { project } = store.get();
    const cell = Math.max(1, Math.round(Number(cellInput.value) || 8));
    let img = raw;
    if (crop.box.checked) {
      const toleranceRaw = toleranceInput.value.trim();
      const bg = removeBackground(img, toleranceRaw ? { tolerance: Number(toleranceRaw) } : {});
      img = cropToSubject(bg.img, 0, cell).img;
    }
    if (snap.box.checked) img = snapToGrid(img, cell);
    if (decast.box.checked) img = deCast(img);
    if (contrast.box.checked) img = contrastLift(img, { lightness: Number(lightnessInput.value) || 1.3, chroma: Number(chromaInput.value) || 1.8 });
    if (levels.box.checked) img = stretchLevels(img);
    if (quantizeRow.box.checked) img = quantize(img, { k: Math.max(1, Math.round(Number(quantizeK.value) || 24)) });
    if (paletteAlignRow.box.checked) img = paletteAlign(img, project.palette, { k: Math.max(1, Math.round(Number(paletteAlignK.value) || 16)) });
    if (despeckleRow.box.checked) img = despeckle(img);
    if (outlineRow.box.checked) img = repairOutline(img, project.palette);
    result = img;
    drawPreview(outCanvas, img, PREVIEW_ZOOM);
    status.textContent = `${img.width}x${img.height}`;
    applyBtn.disabled = !target().sel;
  }

  [crop.box, snap.box, decast.box, contrast.box, levels.box, quantizeRow.box, paletteAlignRow.box, despeckleRow.box, outlineRow.box,
    toleranceInput, cellInput, lightnessInput, chromaInput, quantizeK, paletteAlignK].forEach(elm => elm.addEventListener('change', recompute));
  [toleranceInput, cellInput, lightnessInput, chromaInput, quantizeK, paletteAlignK].forEach(elm => elm.addEventListener('input', recompute));

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      raw = await decodeImageBlob(file);
      drawPreview(rawCanvas, raw, Math.min(PREVIEW_ZOOM, 512 / Math.max(raw.width, raw.height)));
      status.textContent = `loaded ${raw.width}x${raw.height}`;
      recompute();
    } catch (e) {
      status.textContent = `Error: ${(e as Error).message}`;
    }
  });

  applyBtn.addEventListener('click', () => {
    const t = target();
    if (!t.sel || !t.creature || !result) { status.textContent = t.sel ? 'Load an image first.' : noEntryOpenMessage(t.ui); return; }
    const entryKey = t.sel.entryKey;
    applySprite(store, { id: t.creature.id, caste: t.creature.caste, templateId: t.creature.templateId }, entryKey, result, `df-look ${entryKey}`);
    status.textContent = `Written to ${entryKey}.`;
  });
}
