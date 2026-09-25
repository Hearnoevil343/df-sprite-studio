// Creature list: add a creature (id + template choice), select one to
// edit, remove one. Selecting a creature opens its template's first active
// entry so the checklist and canvas always agree on what's open.
import { TEMPLATES, activeEntries, templateById } from '../../engine/index.ts';
import { addCreature, findCreature, removeCreature, sameCreature, selectEntry } from '../state/selection.ts';
import type { Store } from '../state/store.ts';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props);
}

export function createCreatureListPanel(store: Store, container: HTMLElement): { render: () => void } {
  const idInput = el('input', { type: 'text', placeholder: 'CREATURE_ID' });
  const templateSelect = el('select');
  for (const t of TEMPLATES) templateSelect.appendChild(el('option', { value: t.id, textContent: t.name }));
  const addBtn = el('button', { type: 'button', textContent: 'Add creature' });
  const list = el('div', { className: 'creature-list' });

  addBtn.addEventListener('click', () => {
    const id = idInput.value.trim().toUpperCase();
    const ref = { id, templateId: templateSelect.value };
    if (!id || findCreature(store, ref)) return;
    addCreature(store, id, templateSelect.value);
    const t = templateById(templateSelect.value)!;
    const first = activeEntries(t, { include: [] })[0];
    if (first) selectEntry(store, ref, first.key);
    idInput.value = '';
  });

  function render(): void {
    const { project, ui } = store.get();
    list.innerHTML = '';
    for (const creature of project.creatures) {
      const ref = { id: creature.id, caste: creature.caste, templateId: creature.templateId };
      const row = el('div', { className: 'creature-row' });
      const btn = el('button', {
        type: 'button',
        textContent: `${creature.id}${creature.caste ? `:${creature.caste}` : ''} (${templateById(creature.templateId)?.name ?? creature.templateId})`,
      });
      btn.classList.toggle('active', !!ui.selection && sameCreature(ui.selection, ref));
      btn.addEventListener('click', () => {
        const t = templateById(creature.templateId);
        const first = t && activeEntries(t, creature).find(e => creature.sprites[e.key]);
        const entryKey = first?.key ?? (t ? activeEntries(t, creature)[0]?.key : undefined);
        if (entryKey) selectEntry(store, ref, entryKey);
      });
      const removeBtn = el('button', { type: 'button', textContent: '×', title: `Remove ${creature.id}` });
      removeBtn.addEventListener('click', ev => { ev.stopPropagation(); removeCreature(store, ref); });
      row.append(btn, removeBtn);
      list.appendChild(row);
    }
  }

  container.innerHTML = '';
  container.append(idInput, templateSelect, addBtn, list);

  store.subscribe(render);
  render();
  return { render };
}
