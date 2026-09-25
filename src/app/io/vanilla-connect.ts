// Shared DF-folder connect: one scan in ui.vanillaScan that
// finder/reference/layer-tree/scene-preview all read, replacing their four
// independent connect buttons and scanVanilla() calls.
import type { Store } from '../state/store.ts';
import { ensureReadPermission, isDfFolder, loadDfHandle, pickDfFolder } from './df-handle.ts';
import { scanVanilla } from './vanilla-scan.ts';

export async function connectDfFolder(store: Store, handle: FileSystemDirectoryHandle): Promise<void> {
  if (!(await ensureReadPermission(handle))) {
    store.update(s => { s.ui.vanillaScanStatus = 'Permission to read the folder was denied.'; });
    return;
  }
  if (!(await isDfFolder(handle))) {
    store.update(s => { s.ui.vanillaScanStatus = `"${handle.name}" has no data/vanilla folder. Pick the DF install root.`; });
    return;
  }
  store.update(s => { s.ui.vanillaScanStatus = 'Scanning vanilla graphics...'; });
  const scan = await scanVanilla(handle);
  const summary = `"${handle.name}" connected: ${scan.docs.length} raw files, ${scan.pages.size} tile pages, ${scan.pngHandles.size} images.`;
  store.update(s => { s.ui.vanillaScan = scan; s.ui.vanillaScanStatus = summary; });
}

export async function pickAndConnectDfFolder(store: Store): Promise<void> {
  try {
    store.update(s => { s.ui.vanillaScanStatus = 'Opening folder picker...'; });
    await connectDfFolder(store, await pickDfFolder());
  } catch (err) {
    store.update(s => {
      s.ui.vanillaScanStatus = err instanceof Error ? `Could not open folder: ${err.message}` : 'Could not open folder.';
    });
  }
}

export function autoConnectDfFolder(store: Store): void {
  loadDfHandle().then(handle => { if (handle) connectDfFolder(store, handle).catch(() => {}); });
}
