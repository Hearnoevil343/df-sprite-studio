// Style checker panel: runs checkSprite on the sprite currently
// open on the canvas, against vanilla-style.json's bands, and highlights an
// issue's pixels on the canvas (ui.styleOverlay, drawn by canvas.ts) when its
// row is clicked (click, not hover: hovering while the store notifies a
// rebuild of this same list would drop the pointer off the row mid-hover).
// Mirrors tools/studio.ts's "check" command, one entry at a time instead of
// a whole mod.
import { checkSprite, proportionGuide, templateById } from '../../engine/index.ts';
import type { Issue, VanillaStats, VanillaStyle } from '../../engine/index.ts';
import { noEntryOpenMessage } from '../state/messages.ts';
import type { Store } from '../state/store.ts';

const SEVERITY_ORDER: Record<Issue['severity'], number> = { error: 0, warn: 1, info: 2 };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props);
}

export function createStylePanel(store: Store, container: HTMLElement, stats: VanillaStats, style: VanillaStyle): { render: () => void } {
  const status = el('div', { className: 'style-status' });
  const list = el('div', { className: 'style-list' });
  let activeRule: string | null = null;

  function render(): void {
    const { project, ui } = store.get();
    const sel = ui.selection;
    const creature = sel && project.creatures.find(c => c.id === sel.id && c.caste === sel.caste && c.templateId === sel.templateId);
    const template = creature ? templateById(creature.templateId) : undefined;
    const entry = sel && template?.entries.find(e => e.key === sel.entryKey);
    list.innerHTML = '';
    if (!sel || !entry) {
      status.textContent = noEntryOpenMessage(ui, 'No sprite open.');
      return;
    }
    const singleTile = !entry.size || (entry.size[0] === 1 && entry.size[1] === 1);
    const guide = singleTile ? proportionGuide(stats, { token: entry.token }) : undefined;
    const issues = checkSprite(project.sprite, {
      token: entry.token, palette: project.palette, locked: project.paletteLocked, style, floors: style.floors, guide,
    }).filter(i => singleTile || i.rule !== 'baseline');
    issues.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

    const errors = issues.filter(i => i.severity === 'error').length;
    status.textContent = `${entry.token}: ${issues.length} issue(s), ${errors} error(s).`;
    for (const issue of issues) {
      const row = el('div', { className: `style-row style-${issue.severity}` });
      row.classList.toggle('active', issue.rule === activeRule);
      row.append(el('span', { className: 'style-severity', textContent: issue.severity }), el('span', { textContent: issue.message }));
      if (issue.pixels?.length) {
        row.addEventListener('click', () => {
          activeRule = activeRule === issue.rule ? null : issue.rule;
          store.update(s => { s.ui.styleOverlay = activeRule ? issue.pixels! : null; });
        });
      }
      list.appendChild(row);
    }
  }

  container.innerHTML = '';
  container.append(el('h3', { textContent: 'Style check' }), status, list);

  store.subscribe(render);
  render();
  return { render };
}
