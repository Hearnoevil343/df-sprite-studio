// Docking shell: dockview-core hosts the right-side panel tabs
// and the center canvas region; the menu bar, left tool strip and status bar
// are plain DOM siblings, not dockview panels. Layout persists to
// localStorage so the user's arrangement survives a reload.
import { createDockview } from 'dockview-core';
import type { DockviewApi } from 'dockview-core';

// Palette moved out of the tool strip into its own dockable
// panel, so an older saved layout (built before that panel existed) is
// dropped in favour of a fresh default layout that includes it.
const LAYOUT_KEY = 'dfSpriteStudio.dockLayout.v5';

export type Shell = {
  menubar: HTMLElement;
  toolstrip: HTMLElement;
  statusbar: HTMLElement;
  dockview: DockviewApi;
  // Returns (creating if needed) the plain content div a panel factory
  // should mount into for the given dockview panel id.
  contentFor: (id: string) => HTMLElement;
};

export function createShell(root: HTMLElement): Shell {
  root.innerHTML = '';
  const menubar = document.createElement('div');
  menubar.id = 'menubar';
  const workspace = document.createElement('div');
  workspace.id = 'workspace';
  const toolstrip = document.createElement('div');
  toolstrip.id = 'toolstrip';
  const dockHost = document.createElement('div');
  dockHost.id = 'dock';
  dockHost.className = 'dockview-theme-dark';
  const statusbar = document.createElement('div');
  statusbar.id = 'statusbar';

  workspace.append(toolstrip, dockHost);
  root.append(menubar, workspace, statusbar);

  const panelContent = new Map<string, HTMLElement>();
  function contentFor(id: string): HTMLElement {
    let el = panelContent.get(id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'dock-panel-content';
      el.id = id;
      panelContent.set(id, el);
    }
    return el;
  }

  const dockview = createDockview(dockHost, {
    createComponent: options => ({ element: contentFor(options.id), init: () => {} }),
  });

  return { menubar, toolstrip, statusbar, dockview, contentFor };
}

export type PanelDef = { id: string; title: string };

// Builds the default right-dock layout (canvas center, everything else
// tabbed together on the right) the first time the app runs, or when a
// saved layout fails to restore. `panels` is every non-canvas panel, added
// as tabs of one group so the user can drag them apart from there.
export function buildDefaultLayout(shell: Shell, panels: PanelDef[]): void {
  shell.dockview.addPanel({
    id: 'canvas-panel', title: 'Canvas', component: 'canvas-panel', minimumWidth: 240, renderer: 'always',
  });
  let referencePanel = 'canvas-panel';
  let first = true;
  let firstPanel: ReturnType<typeof shell.dockview.addPanel> | undefined;
  for (const p of panels) {
    const panel = shell.dockview.addPanel({
      id: p.id,
      title: p.title,
      component: p.id,
      renderer: 'always',
      position: first
        ? { direction: 'right', referencePanel: 'canvas-panel' }
        : { direction: 'within', referencePanel },
      initialWidth: first ? 380 : undefined,
    });
    if (first) {
      referencePanel = p.id;
      firstPanel = panel;
    }
    first = false;
  }
  // Adding a panel to a tab group activates it, so the last panel added
  // (AI) would otherwise end up focused on first run. Activate the first
  // panel (Project) only after every panel has been added, since each
  // later `addPanel` into the same group re-steals activation.
  firstPanel?.api.setActive();
}

export function restoreOrBuildLayout(shell: Shell, panels: PanelDef[]): void {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw) {
      shell.dockview.fromJSON(JSON.parse(raw));
      return;
    }
  } catch {
    // fall through to the default layout
  }
  buildDefaultLayout(shell, panels);
}

// Re-adds a panel closed via its tab's X (Window menu "reopen"). If it's
// already open, just focuses it instead of erroring on a duplicate id.
export function reopenPanel(shell: Shell, def: PanelDef): void {
  const existing = shell.dockview.getPanel(def.id);
  if (existing) { existing.api.setActive(); return; }
  const anyPanel = shell.dockview.panels[0];
  shell.dockview.addPanel({
    id: def.id, title: def.title, component: def.id, renderer: 'always',
    ...(def.id === 'canvas-panel' ? { minimumWidth: 240 } : {}),
    ...(anyPanel ? { position: { direction: 'within', referencePanel: anyPanel.id } } : {}),
  });
}

export function persistLayoutOnChange(shell: Shell): void {
  shell.dockview.onDidLayoutChange(() => {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(shell.dockview.toJSON())); } catch { /* ignore */ }
  });
}
