import type { Rgba } from '../../engine/index.ts';
import type { Store } from '../state/store.ts';

export function toCss([r, g, b, a]: Rgba): string {
  return `rgba(${r}, ${g}, ${b}, ${a / 255})`;
}

function toHex([r, g, b]: Rgba): string {
  const h = (n: number) => n.toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

// #rrggbb only (the native colour picker's own format); returns null for
// anything else rather than guessing.
function parseHex(hex: string): Rgba | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
}

function swatchButton(store: Store, colour: Rgba, selected: boolean, onRemove?: () => void): HTMLButtonElement {
  const swatch = document.createElement('button');
  swatch.type = 'button';
  swatch.className = 'swatch';
  swatch.style.background = colour[3] === 0
    ? 'repeating-conic-gradient(#3a3a3a 0% 25%, #2c2c2c 0% 50%) 0 0 / 8px 8px'
    : toCss(colour);
  swatch.setAttribute('aria-pressed', String(selected));
  if (selected) swatch.classList.add('selected');
  swatch.addEventListener('click', () => {
    store.update(s => { s.ui.colour = colour; });
  });
  if (onRemove) {
    swatch.title = 'Right-click to remove';
    swatch.addEventListener('contextmenu', ev => { ev.preventDefault(); onRemove(); });
  }
  return swatch;
}

// Locked DF palette (transparent first, then one row per ramp, darkest to
// lightest, same hue, so the ramp structure that rampStep walks is visible)
// plus a Custom section for the modder's own colours: a hex
// field, the native colour picker, and an Add button. Custom colours aren't
// on any ramp (Darker/Lighter leave them unchanged, per rampStep) and carry
// no off-palette warning -- picking one is already a deliberate choice.
export function createPalettePanel(store: Store, container: HTMLElement): { render: () => void } {
  function render(): void {
    const { ui, project } = store.get();
    const { colours, ramps } = project.palette;
    container.innerHTML = '';
    const isSelected = (c: Rgba) => c.every((v, i) => v === ui.colour[i]);

    container.append(Object.assign(document.createElement('h4'), { className: 'palette-heading', textContent: 'DF palette' }));
    const transparent = colours.find(c => c[3] === 0);
    if (transparent) {
      const row = document.createElement('div');
      row.className = 'ramp-row';
      row.append(swatchButton(store, transparent, isSelected(transparent)));
      container.appendChild(row);
    }
    for (const ramp of ramps) {
      const row = document.createElement('div');
      row.className = 'ramp-row';
      for (const idx of ramp) row.append(swatchButton(store, colours[idx], isSelected(colours[idx])));
      container.appendChild(row);
    }

    container.append(Object.assign(document.createElement('h4'), { className: 'palette-heading', textContent: 'Custom' }));
    const customRow = document.createElement('div');
    customRow.id = 'palette-custom';
    customRow.className = 'ramp-row';
    project.customColours.forEach((c, i) => {
      customRow.append(swatchButton(store, c, isSelected(c), () => {
        store.update(s => { s.project.customColours = s.project.customColours.filter((_, j) => j !== i); });
      }));
    });
    container.appendChild(customRow);

    const addRow = document.createElement('div');
    addRow.className = 'palette-add';
    const hexInput = Object.assign(document.createElement('input'), {
      type: 'text', placeholder: '#rrggbb', className: 'palette-hex', value: toHex(ui.colour),
    });
    const colourInput = Object.assign(document.createElement('input'), { type: 'color', value: toHex(ui.colour) });
    const addBtn = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Add' });
    colourInput.addEventListener('input', () => { hexInput.value = colourInput.value; });
    const addColour = () => {
      const c = parseHex(hexInput.value);
      if (!c) { hexInput.focus(); return; }
      store.update(s => {
        if (!s.project.customColours.some(x => x.every((v, i) => v === c[i]))) s.project.customColours.push(c);
        s.ui.colour = c;
      });
    };
    addBtn.addEventListener('click', addColour);
    hexInput.addEventListener('keydown', ev => { if (ev.key === 'Enter') addColour(); });
    addRow.append(hexInput, colourInput, addBtn);
    container.appendChild(addRow);
  }
  store.subscribe(render);
  render();
  return { render };
}
