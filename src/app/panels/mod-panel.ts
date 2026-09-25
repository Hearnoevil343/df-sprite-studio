// Mod info, export into DF's mods folder, and opening a mod folder.
import { buildPageImages, changedPageFiles, modTilePages, layeredPageFilePaths, layeredRawFiles, modFiles, modId, readMod, validateMod } from '../../engine/index.ts';
import type { LayeredCreature, ModFile, ModInfo, RgbaImage, VanillaIndex } from '../../engine/index.ts';
import { isForeignMod, modsFolder, readModFolder, writeModFiles } from '../io/mod-io.ts';
import { flushLayered } from '../state/layered.ts';
import { flushSelection, loadProject } from '../state/selection.ts';
import type { ModLayered } from '../state/layered.ts';
import type { Store } from '../state/store.ts';

// The open layered creature (layer-tree.ts), as the export files it needs:
// its raw doc re-serialized (layeredRawFiles/changedPageFiles --
// byte-identical when nothing was edited) plus any page PNG actually drawn
// on. Files whose path a template creature's export already wrote win, so
// a shared page/raw never doubles up.
function layeredExportFiles(store: Store): ModFile[] {
  const { ui } = store.get();
  const L = ui.layered;
  if (!L) return [];
  flushLayered(store);
  const creature: LayeredCreature = { id: L.creatureId, path: L.path, graphics: L.lg };
  const pagePaths = layeredPageFilePaths([creature]);
  return [...layeredRawFiles([creature]), ...changedPageFiles(L.pages, L.originalPages, pagePaths)];
}

// The mod's layer-set creatures as the layer tree can open them: page and
// palette images come from the mod folder itself (a mod ships its own PNGs),
// so no DF folder is needed. Paths follow readMod's "graphics/<file>"
// convention, and LS_PALETTE_FILE is relative to the raw file's own
// directory, which in a mod folder is that same graphics/ directory.
function modLayeredFrom(layered: LayeredCreature[], files: ModFile[]): ModLayered[] {
  const image = (path: string): RgbaImage | undefined => files.find(f => f.path.replace(/\\\\/g, '/') === path)?.image;
  // Pages come from every graphics raw in the mod, not just the creature's
  // own file: a mod usually keeps its TILE_PAGE blocks in a separate
  // tile_page_*.txt.
  const tilePages = modTilePages(files);
  return layered.map(c => {
    const pages = buildPageImages(tilePages, file => image(`graphics/${file}`));
    const palettes = new Map<string, RgbaImage>();
    for (const set of c.graphics.sets) for (const pal of set.palettes) {
      if (!pal.file || palettes.has(pal.file)) continue;
      const img = image(`graphics/${pal.file}`);
      if (img) palettes.set(pal.file, img);
    }
    const name = c.path.split('/').pop() ?? c.path;
    return { id: c.id, label: `${c.id} (${name})`, path: c.path, lg: c.graphics, pages, palettes };
  });
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props);
}

const FIELDS: [keyof ModInfo, string][] = [
  ['id', 'Mod id'], ['name', 'Name'], ['version', 'Version'], ['author', 'Author'], ['description', 'Description'],
];

export function createModPanel(store: Store, container: HTMLElement, vanillaIndex: VanillaIndex): void {
  const inputs = new Map<keyof ModInfo, HTMLInputElement>();
  const form = el('div', { className: 'mod-form' });
  for (const [key, label] of FIELDS) {
    const input = el('input', { type: 'text', placeholder: label, title: label });
    input.addEventListener('input', () => store.update(s => { s.project.mod[key] = input.value; }));
    inputs.set(key, input);
    form.append(input);
  }
  const status = el('div', { className: 'mod-status' });
  const say = (msg: string) => { status.textContent = msg; };

  const exportBtn = el('button', { type: 'button', textContent: 'Export to mods folder' });
  exportBtn.addEventListener('click', async () => {
    try {
      flushSelection(store);
      const { project, ui } = store.get();
      if (!project.mod.id.trim()) { say('Set a mod id first.'); return; }
      if (!project.creatures.length && !ui.layered) { say('Add a creature first.'); return; }
      const files = modFiles(project);
      for (const f of layeredExportFiles(store)) if (!files.some(g => g.path === f.path)) files.push(f);
      const issues = validateMod(files, vanillaIndex);
      const errors = issues.filter(i => i.severity === 'error');
      if (errors.length) {
        say(['Export blocked:', ...errors.map(i => `error ${i.creature ?? ''}${i.caste ? `:${i.caste}` : ''} ${i.rule} ${i.message}`)].join('\n'));
        return;
      }
      const warnings = issues.filter(i => i.severity !== 'error');
      const mods = await modsFolder();
      if (await isForeignMod(mods, project.mod.id)
        && !confirm(`${mods.name}/${modId(project.mod.id)} exists and was not made here. Overwrite its files?`)) return;
      const name = await writeModFiles(mods, project.mod.id, files);
      const warnText = warnings.length ? [`${warnings.length} warning(s):`, ...warnings.map(i => `warn ${i.creature ?? ''}${i.caste ? `:${i.caste}` : ''} ${i.rule} ${i.message}`)] : [];
      say([`Exported to ${mods.name}/${name} (${files.length} files).`, ...warnText].join('\n'));
    } catch (e) {
      if ((e as Error).name !== 'AbortError') say(`Export failed: ${(e as Error).message}`);
    }
  });

  const openBtn = el('button', { type: 'button', textContent: 'Open mod folder' });
  openBtn.addEventListener('click', async () => {
    try {
      if (store.get().project.creatures.length && !confirm('Replace the current project with the mod?')) return;
      const dir = await window.showDirectoryPicker({ id: 'df-mod-open', mode: 'read' });
      const files = await readModFolder(dir);
      const result = readMod(files);
      loadProject(store, result);
      const layered = modLayeredFrom(result.layered, files);
      store.update(s => { s.ui.modLayered = layered; });
      say([`Opened ${dir.name}: ${result.creatures.length} creatures${layered.length ? `, ${layered.length} layered (Layers panel)` : ''}.`, ...result.warnings].join('\n'));
    } catch (e) {
      if ((e as Error).name !== 'AbortError') say(`Open failed: ${(e as Error).message}`);
    }
  });

  container.prepend(el('h3', { textContent: 'Mod' }), form, exportBtn, openBtn, status);

  store.subscribe(s => {
    for (const [key, input] of inputs) if (document.activeElement !== input && input.value !== s.project.mod[key]) input.value = s.project.mod[key];
  });
}
