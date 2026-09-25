// DF install folder access: File System Access API, handle persisted in
// IndexedDB so the user doesn't re-pick it every reload (Chromium only).
import { idbGet, idbSet } from './idb.ts';
import { folderPickerAvailable, pickDfFolderViaInput } from './folder-input-handle.ts';

const KEY = 'dfDir';

export async function loadDfHandle(): Promise<FileSystemDirectoryHandle | null> {
  return (await idbGet<FileSystemDirectoryHandle>(KEY)) ?? null;
}

// Falls back to a folder <input> when the File System Access API isn't
// available (Firefox, Safari, or the app opened as a file:// document).
// The fallback handle isn't persisted -- its File blobs
// can't be reopened after a reload the way a real handle can.
export async function pickDfFolder(): Promise<FileSystemDirectoryHandle> {
  if (!folderPickerAvailable()) return pickDfFolderViaInput();
  const handle = await window.showDirectoryPicker({ id: 'df-install', mode: 'read' });
  await idbSet(KEY, handle);
  return handle;
}

// Chromium re-asks for permission on a handle restored from IndexedDB after
// a reload; query first since a granted permission doesn't need a re-prompt.
export async function ensureReadPermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const opts = { mode: 'read' } as const;
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  return (await handle.requestPermission(opts)) === 'granted';
}

export async function isDfFolder(handle: FileSystemDirectoryHandle): Promise<boolean> {
  try {
    await handle.getDirectoryHandle('data').then(d => d.getDirectoryHandle('vanilla'));
    return true;
  } catch {
    return false;
  }
}
