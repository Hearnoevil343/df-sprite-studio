// Missing-art finder panel: scans a connected DF install for
// creatures with no or partial graphics and lets the user add one to the
// project with the suggested template.
// Reads the shared ui.vanillaScan instead of connecting itself.
import { findMissingArt, templateById } from '../../engine/index.ts';
import type { MissingArt, ModSource } from '../../engine/index.ts';
import type { VanillaScan } from '../io/vanilla-scan.ts';
import { addCreature, findCreature, selectEntry } from '../state/selection.ts';
import type { Store } from '../state/store.ts';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props);
}

export function createFinderPanel(store: Store, container: HTMLElement, summary?: HTMLElement): { render: () => void } {
  let scannedFor: VanillaScan | null = null;
  let missing: MissingArt[] = [];

  const status = el('div', { className: 'finder-status', textContent: 'No DF folder connected.' });
  const list = el('div', { className: 'finder-list' });

  function recompute(): void {
    const scan = store.get().ui.vanillaScan;
    if (scan === scannedFor) return;
    scannedFor = scan;
    if (!scan) { missing = []; return; }
    const vanilla: ModSource = {
      id: 'vanilla', root: 'vanilla', vanilla: true,
      files: scan.docs.map(d => ({ path: d.path, bytes: d.doc.toBytes() })),
    };
    missing = findMissingArt([vanilla]);
  }

  function render(): void {
    recompute();
    const { ui } = store.get();
    status.textContent = ui.vanillaScan ? `Connected: ${missing.length} creature(s) with missing art.` : ui.vanillaScanStatus || 'No DF folder connected.';
    list.innerHTML = '';
    let shown = 0;
    for (const m of missing) {
      const ref = { id: m.id, caste: m.caste, templateId: m.template };
      if (findCreature(store, ref)) continue; // already in the project
      shown++;
      const template = templateById(m.template);
      const row = el('div', { className: 'finder-row' });
      const label = `${m.id}${m.caste ? `:${m.caste}` : ''} (${template?.name ?? m.template}, ${m.status}, missing ${m.missing.join(',')})`;
      row.append(el('span', { textContent: label }));
      const addBtn = el('button', { type: 'button', textContent: 'Add to project' });
      addBtn.addEventListener('click', () => {
        addCreature(store, m.id, m.template, m.caste);
        const t = templateById(m.template);
        const first = t?.entries.find(e => m.missing.includes(e.key)) ?? t?.entries[0];
        if (first) selectEntry(store, ref, first.key);
        render();
      });
      row.append(addBtn);
      list.appendChild(row);
    }
    if (summary) summary.textContent = ui.vanillaScan ? `Missing art (${shown})` : 'Missing art';
  }

  container.innerHTML = '';
  container.append(status, list);

  store.subscribe(render);
  render();
  return { render };
}
