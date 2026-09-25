// Canvas size picker: lets the user resize a
// LARGE_IMAGE entry's canvas in tiles. Presets cover the common shapes; the
// two number fields handle anything else. Hidden entirely for entries whose
// template can't be resized (plain-rect templates, or nothing selected).
import { entrySizeInfo, resizeEntry, sameCreature } from '../state/selection.ts';
import type { Store } from '../state/store.ts';

const PRESETS: [number, number][] = [[1, 1], [2, 2], [3, 2], [2, 3], [3, 3], [4, 4]];
const MIN = 1, MAX = 4;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props);
}

function presetKey([w, h]: [number, number]): string {
  return `${w}x${h}`;
}

export function createSizePickerPanel(store: Store, container: HTMLElement): { render: () => void } {
  const status = el('div', { className: 'size-picker-status' });
  const presetSelect = el('select', { className: 'size-picker-preset' });
  presetSelect.appendChild(el('option', { value: '', textContent: 'Custom' }));
  for (const p of PRESETS) presetSelect.appendChild(el('option', { value: presetKey(p), textContent: `${p[0]}x${p[1]}` }));
  const widthInput = el('input', { type: 'number', min: String(MIN), max: String(MAX), className: 'size-picker-w' });
  const heightInput = el('input', { type: 'number', min: String(MIN), max: String(MAX), className: 'size-picker-h' });

  function clamp(n: number): number {
    return Math.max(MIN, Math.min(MAX, Math.round(n) || MIN));
  }

  function apply(size: [number, number]): void {
    const { ui } = store.get();
    if (!ui.selection) return;
    resizeEntry(store, ui.selection, ui.selection.entryKey, size, message => window.confirm(message));
  }

  presetSelect.addEventListener('change', () => {
    if (!presetSelect.value) return;
    const [w, h] = presetSelect.value.split('x').map(Number) as [number, number];
    apply([w, h]);
  });
  widthInput.addEventListener('change', () => {
    const { ui } = store.get();
    const info = ui.selection && entrySizeInfo(store, ui.selection, ui.selection.entryKey);
    const h = info ? info.size[1] : clamp(Number(heightInput.value));
    apply([clamp(Number(widthInput.value)), h]);
  });
  heightInput.addEventListener('change', () => {
    const { ui } = store.get();
    const info = ui.selection && entrySizeInfo(store, ui.selection, ui.selection.entryKey);
    const w = info ? info.size[0] : clamp(Number(widthInput.value));
    apply([w, clamp(Number(heightInput.value))]);
  });

  function render(): void {
    const { project, ui } = store.get();
    const sel = ui.selection;
    const creature = sel && project.creatures.find(c => sameCreature(c, sel));
    const info = creature && sel ? entrySizeInfo(store, sel, sel.entryKey) : null;
    if (!info) {
      container.style.display = 'none';
      return;
    }
    container.style.display = '';
    const [w, h] = info.size;
    status.textContent = `${sel!.entryKey}: ${w}x${h} (${w * 32}x${h * 32})`;
    presetSelect.value = presetKey(info.size);
    widthInput.value = String(w);
    heightInput.value = String(h);
  }

  container.innerHTML = '';
  container.append(
    el('h4', { textContent: 'Size' }),
    status,
    el('label', { textContent: 'Preset' }), presetSelect,
    el('label', { textContent: 'Width' }), widthInput,
    el('label', { textContent: 'Height' }), heightInput,
  );

  store.subscribe(render);
  render();
  return { render };
}
