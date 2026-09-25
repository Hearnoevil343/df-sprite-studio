// Writing an exported mod into DF's mods folder and reading a mod folder
// back, through the File System Access API. Work on any directory handle, so
// they can be checked against the origin private file system
// (navigator.storage.getDirectory()) without the native picker.
import { STUDIO_FILE, modId } from '../../engine/index.ts';
import type { ModFile, RgbaImage } from '../../engine/index.ts';
import { decodeImageBlob } from './browser-png.ts';
import { idbGet, idbSet } from './idb.ts';

const MODS_KEY = 'modsDir';

export async function encodePng(img: RgbaImage): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D context unavailable');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('PNG encode failed'))), 'image/png'));
}

async function has(dir: FileSystemDirectoryHandle, name: string, kind: 'file' | 'directory'): Promise<boolean> {
  try {
    await (kind === 'file' ? dir.getFileHandle(name) : dir.getDirectoryHandle(name));
    return true;
  } catch {
    return false;
  }
}

// The mods folder from the last export, if write permission is (or can be)
// granted; otherwise asks the user to pick it. Picking the DF install folder
// itself also works: its mods folder is used.
export async function modsFolder(): Promise<FileSystemDirectoryHandle> {
  const saved = await idbGet<FileSystemDirectoryHandle>(MODS_KEY);
  const opts = { mode: 'readwrite' } as const;
  if (saved && ((await saved.queryPermission(opts)) === 'granted' || (await saved.requestPermission(opts)) === 'granted')) return saved;
  let dir = await window.showDirectoryPicker({ id: 'df-mods', mode: 'readwrite' });
  if (await has(dir, 'data', 'directory') && await has(dir, 'mods', 'directory')) dir = await dir.getDirectoryHandle('mods');
  await idbSet(MODS_KEY, dir);
  return dir;
}

export async function forgetModsFolder(): Promise<void> {
  await idbSet(MODS_KEY, undefined);
}

// True when <mods>/<id> exists and was not written by this app, so an
// export would overwrite someone else's files.
export async function isForeignMod(mods: FileSystemDirectoryHandle, id: string): Promise<boolean> {
  const name = modId(id);
  if (!(await has(mods, name, 'directory'))) return false;
  return !(await has(await mods.getDirectoryHandle(name), STUDIO_FILE, 'file'));
}

// Writes the files into <mods>/<id>, creating folders as needed. Returns the
// mod folder's name.
export async function writeModFiles(mods: FileSystemDirectoryHandle, id: string, files: ModFile[]): Promise<string> {
  const name = modId(id);
  const root = await mods.getDirectoryHandle(name, { create: true });
  for (const f of files) {
    const parts = f.path.split('/');
    let dir = root;
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
    const handle = await dir.getFileHandle(parts[parts.length - 1], { create: true });
    const data: Blob = f.image ? await encodePng(f.image) : new Blob([f.bytes as Uint8Array<ArrayBuffer>]);
    const w = await handle.createWritable();
    await w.write(data);
    await w.close();
  }
  return name;
}

// Reads what readMod needs from a mod folder: the root's .txt and .json
// files, graphics/*.txt, and every PNG under graphics/.
export async function readModFolder(dir: FileSystemDirectoryHandle): Promise<ModFile[]> {
  const out: ModFile[] = [];
  async function walk(d: FileSystemDirectoryHandle, prefix: string, depth: number): Promise<void> {
    for await (const [name, handle] of d.entries()) {
      const path = prefix + name;
      if (handle.kind === 'directory') {
        const lower = path.toLowerCase();
        if (lower === 'graphics' || lower.startsWith('graphics/')) await walk(handle as FileSystemDirectoryHandle, path + '/', depth + 1);
        continue;
      }
      const file = await (handle as FileSystemFileHandle).getFile();
      if (/\.png$/i.test(name) && depth > 0) out.push({ path, image: await decodeImageBlob(file) });
      else if (/\.(txt|json)$/i.test(name) && depth <= 1) out.push({ path, bytes: new Uint8Array(await file.arrayBuffer()) });
    }
  }
  await walk(dir, '', 0);
  return out;
}
