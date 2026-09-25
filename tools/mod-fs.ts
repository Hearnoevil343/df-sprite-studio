// Node file I/O for a mod folder: finding mod roots (a folder with info.txt,
// or one level of such folders, which covers `mods`, `data/installed_mods`
// and a Steam workshop folder), reading one into ModFile[], and writing one
// back out.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { decodePng, encodePng } from './png.ts';
import type { ModFile } from '../src/engine/index.ts';

const hasInfoTxt = (dir: string) => existsSync(join(dir, 'info.txt'));

export function findModRoots(path: string): string[] {
  if (!existsSync(path) || !statSync(path).isDirectory()) return [];
  if (hasInfoTxt(path)) return [path];
  return readdirSync(path, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => join(path, d.name))
    .filter(hasInfoTxt)
    .sort();
}

export function readModDir(root: string): ModFile[] {
  const out: ModFile[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      const path = relative(root, full).split(sep).join('/');
      if (/\.png$/i.test(entry.name)) out.push({ path, image: decodePng(new Uint8Array(readFileSync(full))) });
      else out.push({ path, bytes: new Uint8Array(readFileSync(full)) });
    }
  };
  walk(root);
  return out;
}

export function writeModDir(root: string, files: ModFile[]): void {
  for (const f of files) {
    const bytes = f.bytes ?? (f.image ? encodePng(f.image) : undefined);
    if (!bytes) throw new Error(`writeModDir: ${f.path} has neither bytes nor an image to encode`);
    const dest = join(root, ...f.path.split('/'));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, bytes);
  }
}
