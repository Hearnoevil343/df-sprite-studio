// Sprite checklist and VERMIN_ALT animation preview. The checklist
// lists a creature's active template entries (engine.activeEntries, so it
// agrees with what buildTemplate will actually write) and marks each drawn
// or missing; clicking one opens it on the canvas. The currently-open
// entry's pixels live in project.sprite, not yet saved back into the
// creature's sprites map (state/selection.ts does that on the next switch),
// so "drawn" and the thumbnail both special-case the selected entry.
import { TILE, activeEntries, draftPlan, templateById } from '../../engine/index.ts';
import type { RgbaImage, VanillaStats } from '../../engine/index.ts';
import { createFilePicker } from '../dom/file-picker.ts';
import { decodeImageBlob } from '../io/browser-png.ts';
import { applyDraft, applyReduce, sameCreature, selectEntry } from '../state/selection.ts';
import type { Creature, Selection, Store } from '../state/store.ts';

const THUMB_ZOOM = 2;
const VERMIN_ALT_PERIOD_MS = 1000;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props);
}

function isDrawn(img: RgbaImage | undefined): boolean {
  if (!img) return false;
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] !== 0) return true;
  return false;
}

// A never-drawn entry has no RgbaImage to draw, so the thumbnail canvas is
// left at its default size with the plain `.checklist-thumb` background --
// a flat dark square that reads the same as "blank on purpose". Draw the
// same checkerboard the main canvas uses for transparency instead, sized to
// the entry's actual pixel dimensions.
function drawEmptyThumb(canvas: HTMLCanvasElement, tilesW: number, tilesH: number): void {
  const w = tilesW * TILE;
  const h = tilesH * TILE;
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

function drawThumb(canvas: HTMLCanvasElement, img: RgbaImage): void {
  canvas.width = img.width * THUMB_ZOOM;
  canvas.height = img.height * THUMB_ZOOM;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      const a = img.data[i + 3];
      ctx.fillStyle = a === 0 ? ((x + y) % 2 === 0 ? '#3a3a3a' : '#2c2c2c')
        : `rgba(${img.data[i]}, ${img.data[i + 1]}, ${img.data[i + 2]}, ${a / 255})`;
      ctx.fillRect(x * THUMB_ZOOM, y * THUMB_ZOOM, THUMB_ZOOM, THUMB_ZOOM);
    }
  }
}

export function createChecklistPanel(store: Store, container: HTMLElement, stats: VanillaStats): { render: () => void } {
  const status = el('div', { className: 'checklist-status' });
  const list = el('div', { className: 'checklist' });
  const verminWrap = el('div', { className: 'vermin-preview' });
  const verminCanvas = el('canvas');
  verminWrap.append(el('div', { textContent: 'VERMIN_ALT preview' }), verminCanvas);

  function selectedCreature(): { creature: Creature; sel: Selection } | null {
    const { project, ui } = store.get();
    const sel = ui.selection;
    const creature = sel && project.creatures.find(c => sameCreature(c, sel));
    return creature && sel ? { creature, sel } : null;
  }

  // The selected entry's live pixels are on project.sprite; every other
  // entry's are wherever selectEntry last saved them.
  function spriteFor(creature: Creature, sel: Selection, key: string): RgbaImage | undefined {
    return sel.entryKey === key ? store.get().project.sprite : creature.sprites[key];
  }

  let phase = true;
  setInterval(() => { phase = !phase; drawVerminFrame(); }, VERMIN_ALT_PERIOD_MS);

  function drawVerminFrame(): void {
    const found = selectedCreature();
    const template = found && templateById(found.creature.templateId);
    if (!found || !template || template.id !== 'vermin') { verminWrap.style.display = 'none'; return; }
    const vermin = spriteFor(found.creature, found.sel, 'VERMIN');
    const alt = spriteFor(found.creature, found.sel, 'VERMIN_ALT');
    if (!isDrawn(vermin) && !isDrawn(alt)) { verminWrap.style.display = 'none'; return; }
    verminWrap.style.display = '';
    const frame = (phase ? vermin : alt) ?? vermin ?? alt;
    if (frame) drawThumb(verminCanvas, frame);
  }

  function render(): void {
    const found = selectedCreature();
    const template = found && templateById(found.creature.templateId);
    list.innerHTML = '';
    if (!found || !template) {
      status.textContent = 'No creature selected.';
      drawVerminFrame();
      return;
    }
    const { creature, sel } = found;
    const ref = { id: creature.id, caste: creature.caste, templateId: creature.templateId };
    status.textContent = `${creature.id}${creature.caste ? `:${creature.caste}` : ''}: ${template.name}`;
    const drawnKeys = new Set<string>();
    for (const entry of activeEntries(template, creature)) {
      const img = spriteFor(creature, sel, entry.key);
      if (isDrawn(img)) drawnKeys.add(entry.key);
      const row = el('div', { className: 'checklist-row' });
      row.classList.toggle('active', entry.key === sel.entryKey);
      const cv = el('canvas', { className: 'checklist-thumb' });
      const [ew, eh] = entry.size ?? [1, 1];
      if (img) drawThumb(cv, img); else drawEmptyThumb(cv, ew, eh);
      const label = el('span', { textContent: entry.token + (isDrawn(img) ? '' : ' (missing)') });
      row.append(cv, label);
      row.addEventListener('click', () => selectEntry(store, ref, entry.key));
      // Reduce: pick any image and run it through the LoRA-output reducer
      // for this one entry. Square entries only - reduceImage
      // always outputs a tileSpan x tileSpan square, so a non-square
      // multi-tile entry (e.g. a 3x2 LARGE_IMAGE) has no correct target size.
      if (ew === eh) {
        const { wrap, input: reduceInput } = createFilePicker({
          accept: 'image/png',
          className: 'checklist-reduce-input',
          buttonLabel: 'Reduce...',
          title: `Reduce an image into ${entry.token}`,
        });
        wrap.addEventListener('click', ev => ev.stopPropagation());
        reduceInput.addEventListener('change', async () => {
          const file = reduceInput.files?.[0];
          if (!file) return;
          const picked = await decodeImageBlob(file);
          applyReduce(store, ref, store.get().project.palette, entry.key, picked, stats);
          reduceInput.value = '';
        });
        row.append(wrap);
      }
      list.appendChild(row);
    }
    for (const step of draftPlan(template, drawnKeys)) {
      const { project } = store.get();
      const from = template.entries.find(e => e.key === step.from);
      const row = el('div', { className: 'checklist-row checklist-draft' });
      row.append(el('span', { textContent: `Draft ${step.key} from ${from?.token ?? step.from} via ${step.kinds.join('+')}` }));
      const btn = el('button', { type: 'button', textContent: 'Draft' });
      btn.addEventListener('click', () => applyDraft(store, ref, project.palette, step));
      row.append(btn);
      list.appendChild(row);
    }
    drawVerminFrame();
  }

  container.innerHTML = '';
  container.append(status, list, verminWrap);

  store.subscribe(render);
  render();
  return { render };
}
