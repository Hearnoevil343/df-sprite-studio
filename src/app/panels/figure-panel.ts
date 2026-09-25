// Figure panel: the layered creature's counterpart to scene
// preview. Condition controls (age/state, caste, ghost, syn class,
// profession, worn items, tissues, random part index) drive a live
// composite() + renderComposite() over the open creature's page images and
// palettes, drawn at true 1x like scene preview, with the "could not
// evaluate" notes underneath. Reuses scene preview's frame: same CSS classes
// (.scene-status/.scene-canvas), same hide-the-other-panel pattern as
// checklist/layer-tree.
import { composite, defaultFigure, pickSet, renderComposite } from '../../engine/index.ts';
import type { Composite, Condition, Draw, Figure, LayeredGraphics, LayerSet, LsPalette, RgbaImage, TissueState, WornItem } from '../../engine/index.ts';
import { applyAddPaletteRow, flushLayered } from '../state/layered.ts';
import type { Store } from '../state/store.ts';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props);
}

function drawComposite(canvas: HTMLCanvasElement, img: RgbaImage): void {
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
}

// Zoom to the largest integer scale that fits the panel (issue 5: without
// this the composite draws at native size, a few pixels tall in a much
// larger panel, which reads as "no image"). Same idea as scene-preview's
// fitZoom.
function fitZoom(canvas: HTMLCanvasElement): void {
  const parent = canvas.parentElement;
  if (!parent || !canvas.width || !canvas.height) return;
  const availW = parent.clientWidth;
  const availH = parent.clientHeight;
  if (!availW || !availH) return;
  const zoom = Math.max(1, Math.floor(Math.min(availW / canvas.width, availH / canvas.height)));
  canvas.style.width = `${canvas.width * zoom}px`;
  canvas.style.height = `${canvas.height * zoom}px`;
}

// What a group's conditions mention, gathered from the raw tokens so the
// controls only ever offer choices this creature's layers actually test.
type Choices = {
  castes: string[];
  synClasses: string[];
  professions: string[];
  randomParts: string[];
  // `colours` are every TISSUE_MAY_HAVE_COLOR option seen for that part/tissue,
  // in file order, so seedFigure can default to the first (colours[0]) instead
  // of leaving the tissue's `color` unset -- an unset color fails every
  // CONDITION_TISSUE_LAYER/TISSUE_MAY_HAVE_COLOR layer (e.g. a creature's skin
  // tone variants), which otherwise left the default preview drawing nothing
  // but a shadow for any creature whose base body layer is colour-gated.
  tissues: { part: string; tissue: string; colours: string[] }[];
  worn: WornItem[];
};

function scanChoices(set: LayerSet | undefined): Choices {
  const c: Choices = { castes: [], synClasses: [], professions: [], randomParts: [], tissues: [], worn: [] };
  if (!set) return c;
  const castes = new Set<string>(), syn = new Set<string>(), prof = new Set<string>(), parts = new Set<string>();
  const tissues = new Map<string, { part: string; tissue: string; colours: string[] }>();
  const worn = new Map<string, WornItem>();
  const wornFrom = (a: string[]) => {
    const [mode, part, type, ...items] = a;
    for (const item of items) if (item !== 'ANY') worn.set(`${mode}:${part}:${type}:${item}`, { mode, part, type, item });
  };
  const visit = (cond: Condition) => {
    const a = cond.token.args.slice(1);
    switch (cond.kind) {
      case 'CONDITION_CASTE': a.forEach(x => castes.add(x)); break;
      case 'CONDITION_SYN_CLASS': a.forEach(x => syn.add(x)); break;
      case 'CONDITION_PROFESSION_CATEGORY': a.forEach(x => prof.add(x)); break;
      case 'CONDITION_RANDOM_PART_INDEX': parts.add(a[0]); break;
      case 'CONDITION_ITEM_WORN': case 'SHUT_OFF_IF_ITEM_PRESENT': wornFrom(a); break;
      case 'CONDITION_TISSUE_LAYER': {
        const [, part, tissue] = a;
        if (!part || !tissue) break;
        const key = `${part}:${tissue}`;
        const entry = tissues.get(key) ?? { part, tissue, colours: [] };
        for (const ch of cond.children) if (ch.args[0] === 'TISSUE_MAY_HAVE_COLOR') for (const col of ch.args.slice(1)) if (!entry.colours.includes(col)) entry.colours.push(col);
        tissues.set(key, entry);
        break;
      }
    }
  };
  for (const g of set.groups) { g.conditions.forEach(visit); for (const l of g.layers) l.conditions.forEach(visit); }
  return { castes: [...castes].sort(), synClasses: [...syn].sort(), professions: [...prof].sort(), randomParts: [...parts].sort(), tissues: [...tissues.values()], worn: [...worn.values()] };
}

// A figure seeded from what the chosen set actually tests, so the preview
// shows something drawn on first open instead of a blank canvas.
function seedFigure(set: LayerSet | undefined, age: Figure['age'], state: string): Figure {
  const f = defaultFigure({ age, state });
  const choices = scanChoices(set);
  f.tissues = choices.tissues.map(t => ({ part: t.part, tissue: t.tissue, color: t.colours[0] }));
  f.randomPartIndex = Object.fromEntries(choices.randomParts.map(p => [p, 1]));
  f.professionCategory = choices.professions.includes('STANDARD') ? 'STANDARD' : choices.professions[0];
  f.caste = choices.castes[0];
  return f;
}

// Palette row picker overrides: a chosen row for an LS_PALETTE name applies
// to every draw using that palette, in place of each layer's authored row.
function withRowOverrides(c: Composite, overrides: Map<string, number>): Composite {
  if (overrides.size === 0) return c;
  const draws: Draw[] = c.draws.map(d => {
    const pal = d.layer.palette;
    if (!pal || pal === 'FROM_ITEM' || !overrides.has(pal.name)) return d;
    return { ...d, layer: { ...d.layer, palette: { ...pal, row: overrides.get(pal.name)! } } };
  });
  return { ...c, draws };
}

// `controlsHost` is a separate container -- the Properties dock
// panel's condition section -- so the Preview panel holds only the composite
// canvas and its notes, per the Blender/Photoshop Properties/Preview split.
export function createFigurePanel(store: Store, container: HTMLElement, sceneEl: HTMLElement, controlsHost: HTMLElement): { render: () => void; fitZoom: () => void } {
  let figure: Figure = defaultFigure();
  let seededFor = '';                    // creatureId this figure was last seeded for
  const rowOverrides = new Map<string, number>();
  const canvas = el('canvas', { className: 'scene-canvas' });
  const status = el('div', { className: 'scene-status' });
  const notesEl = el('div', { className: 'figure-notes' });
  const controls = el('div', { className: 'figure-controls' });

  function textField(label: string, value: string | undefined, options: string[], onChange: (v: string) => void): HTMLElement {
    const row = el('label', { className: 'figure-row' });
    const listId = `fig-${label.replace(/\s+/g, '-')}`;
    const input = el('input', { type: 'text', value: value ?? '' });
    if (options.length) {
      input.setAttribute('list', listId);
      const dl = el('datalist', { id: listId });
      for (const o of options) dl.appendChild(el('option', { value: o }));
      row.append(dl);
    }
    input.addEventListener('change', () => onChange(input.value.trim()));
    row.append(el('span', { textContent: label }), input);
    return row;
  }

  function numberField(label: string, value: number | undefined, onChange: (v: number | undefined) => void): HTMLElement {
    const row = el('label', { className: 'figure-row' });
    const input = el('input', { type: 'number', value: value === undefined ? '' : String(value) });
    input.addEventListener('change', () => onChange(input.value === '' ? undefined : Number(input.value)));
    row.append(el('span', { textContent: label }), input);
    return row;
  }

  function checkboxField(label: string, checked: boolean, onChange: (v: boolean) => void): HTMLElement {
    const row = el('label', { className: 'figure-row' });
    const input = el('input', { type: 'checkbox', checked });
    input.addEventListener('change', () => onChange(input.checked));
    row.append(input, el('span', { textContent: label }));
    return row;
  }

  function tissueField(t: { part: string; tissue: string; colours: string[] }): HTMLElement {
    const cur = figure.tissues.find(x => x.part === t.part && x.tissue === t.tissue);
    const box = el('div', { className: 'figure-group' });
    box.append(el('div', { className: 'figure-group-label', textContent: `${t.part} ${t.tissue}` }));
    const set = (patch: Partial<TissueState>) => {
      const others = figure.tissues.filter(x => !(x.part === t.part && x.tissue === t.tissue));
      figure = { ...figure, tissues: [...others, { part: t.part, tissue: t.tissue, ...cur, ...patch }] };
      rerender();
    };
    box.append(textField('Colour', cur?.color, t.colours, v => set({ color: v || undefined })));
    box.append(numberField('Length', cur?.length, v => set({ length: v })));
    box.append(textField('Shaping', cur?.shaping, [], v => set({ shaping: v || undefined })));
    return box;
  }

  function wornField(w: WornItem): HTMLElement {
    const on = figure.worn.some(x => x.mode === w.mode && x.part === w.part && x.type === w.type && x.item === w.item);
    return checkboxField(`${w.item} (${w.part})`, on, checked => {
      figure = { ...figure, worn: checked ? [...figure.worn, w] : figure.worn.filter(x => !(x.mode === w.mode && x.part === w.part && x.type === w.type && x.item === w.item)) };
      rerender();
    });
  }

  function paletteField(pal: LsPalette): HTMLElement {
    const row = numberField(`Palette ${pal.name} row`, rowOverrides.get(pal.name) ?? pal.defaultRow, v => {
      if (v === undefined) rowOverrides.delete(pal.name); else rowOverrides.set(pal.name, v);
      rerender();
    });
    if (pal.file) {
      const addBtn = el('button', { type: 'button', textContent: '+ row', title: `Add a new colour row to ${pal.name} (copies the default row's colours)` });
      addBtn.addEventListener('click', () => {
        // Always adds the row (copying the current default row's colours);
        // the confirm only decides whether it also becomes the new default.
        const makeDefault = window.confirm(`Added a new colour row to ${pal.name}, copied from the current default row.\n\nMake this new row the palette's default too? (OK = yes, Cancel = no, keep current default)`);
        applyAddPaletteRow(store, pal, makeDefault);
        rerender();
      });
      row.append(addBtn);
    }
    return row;
  }

  function buildControls(lg: LayeredGraphics, set: LayerSet | undefined): void {
    controls.innerHTML = '';
    const states = [...new Set(lg.sets.map(s => s.state))];
    const ageRow = el('label', { className: 'figure-row' });
    const ageSelect = el('select');
    for (const a of ['adult', 'child', 'baby'] as const) ageSelect.appendChild(el('option', { value: a, textContent: a, selected: figure.age === a }));
    ageSelect.addEventListener('change', () => { figure = { ...figure, age: ageSelect.value as Figure['age'] }; rerender(); });
    ageRow.append(el('span', { textContent: 'Age' }), ageSelect);
    controls.append(ageRow);

    const stateRow = el('label', { className: 'figure-row' });
    const stateSelect = el('select');
    for (const s of states) stateSelect.appendChild(el('option', { value: s, textContent: s, selected: figure.state === s }));
    stateSelect.addEventListener('change', () => { figure = { ...figure, state: stateSelect.value }; rerender(); });
    stateRow.append(el('span', { textContent: 'State' }), stateSelect);
    controls.append(stateRow);

    controls.append(checkboxField('Ghost', figure.ghost, v => { figure = { ...figure, ghost: v }; rerender(); }));

    const choices = scanChoices(set);
    controls.append(textField('Caste', figure.caste, choices.castes, v => { figure = { ...figure, caste: v || undefined }; rerender(); }));
    controls.append(textField('Profession', figure.professionCategory, choices.professions, v => { figure = { ...figure, professionCategory: v || undefined }; rerender(); }));
    controls.append(textField('Syn class', figure.synClasses.join(','), choices.synClasses, v => { figure = { ...figure, synClasses: v ? v.split(',').map(s => s.trim()).filter(Boolean) : [] }; rerender(); }));

    if (choices.randomParts.length) {
      controls.append(el('div', { className: 'figure-section', textContent: 'Random part index' }));
      for (const p of choices.randomParts) controls.append(numberField(p, figure.randomPartIndex[p] ?? 1, v => { figure = { ...figure, randomPartIndex: { ...figure.randomPartIndex, [p]: v ?? 1 } }; rerender(); }));
    }
    if (choices.tissues.length) {
      controls.append(el('div', { className: 'figure-section', textContent: 'Tissues' }));
      for (const t of choices.tissues) controls.append(tissueField(t));
    }
    if (choices.worn.length) {
      controls.append(el('div', { className: 'figure-section', textContent: 'Worn items' }));
      for (const w of choices.worn) controls.append(wornField(w));
    }
    if (set?.palettes.length) {
      controls.append(el('div', { className: 'figure-section', textContent: 'Palette rows' }));
      for (const p of set.palettes) controls.append(paletteField(p));
    }
  }

  function rerender(): void { compute(); }

  function compute(): void {
    const { ui } = store.get();
    const L = ui.layered;
    if (!L) return;
    flushLayered(store);
    if (seededFor !== L.creatureId) {
      // New creature: seed from its DEFAULT/adult set so the panel opens populated.
      rowOverrides.clear();
      figure = seedFigure(pickSet(L.lg, defaultFigure()), 'adult', 'DEFAULT');
      seededFor = L.creatureId;
    }
    const set = pickSet(L.lg, figure);
    buildControls(L.lg, set);
    const c = withRowOverrides(composite(L.lg, figure), rowOverrides);
    const rendered = renderComposite(c, L.pages, L.palettes);
    drawComposite(canvas, rendered.image);
    fitZoom(canvas);
    status.textContent = `${L.creatureId}: ${set ? `${set.stage ?? 'ADULT'} ${set.state}` : 'no matching layer set'}`;
    notesEl.innerHTML = '';
    if (rendered.notes.length) {
      notesEl.append(el('div', { className: 'figure-section', textContent: 'Could not evaluate' }));
      for (const n of rendered.notes) notesEl.append(el('div', { className: 'figure-note', textContent: n }));
    }
  }

  function render(): void {
    const { ui } = store.get();
    const L = ui.layered;
    container.style.display = L ? 'flex' : 'none';
    sceneEl.style.display = L ? 'none' : 'flex';
    controlsHost.style.display = L ? 'flex' : 'none';
    if (!L) return;
    compute();
  }

  container.innerHTML = '';
  container.append(status, canvas, notesEl);
  controlsHost.innerHTML = '';
  controlsHost.append(controls);
  if ('ResizeObserver' in window) new ResizeObserver(() => fitZoom(canvas)).observe(container);

  store.subscribe(render);
  render();
  return { render, fitZoom: () => fitZoom(canvas) };
}
