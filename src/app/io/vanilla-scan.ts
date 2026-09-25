// Walk a DF install's data/vanilla folder for graphics raws and their tile
// page images, mirroring what tools/vanilla-stats.ts does over Node's fs.
import { RawDocument, spriteRects } from '../../engine/index.ts';
import type { SpriteRect } from '../../engine/index.ts';

export type VanillaRaw = { path: string; doc: RawDocument };
export type VanillaPage = { pngPath: string; tile: [number, number] };
export type VanillaScan = {
  docs: VanillaRaw[];
  pages: Map<string, VanillaPage>;      // TILE_PAGE id -> its png path and tile size
  pngHandles: Map<string, FileSystemFileHandle>; // path (as seen while walking) -> handle
};

async function* walk(dir: FileSystemDirectoryHandle, path: string): AsyncGenerator<{ path: string; handle: FileSystemHandle }> {
  for await (const [name, entry] of dir.entries()) {
    const p = path ? `${path}/${name}` : name;
    if (entry.kind === 'directory') yield* walk(entry as FileSystemDirectoryHandle, p);
    else yield { path: p, handle: entry };
  }
}

function joinPath(dir: string, file: string): string {
  return dir ? `${dir}/${file}` : file;
}

export async function scanVanilla(dfRoot: FileSystemDirectoryHandle): Promise<VanillaScan> {
  const vanilla = await dfRoot.getDirectoryHandle('data').then(d => d.getDirectoryHandle('vanilla'));
  const docs: VanillaRaw[] = [];
  const pngHandles = new Map<string, FileSystemFileHandle>();
  for await (const { path, handle } of walk(vanilla, '')) {
    if (handle.kind !== 'file') continue;
    if (path.endsWith('.txt')) {
      const file = await (handle as FileSystemFileHandle).getFile();
      const bytes = new Uint8Array(await file.arrayBuffer());
      docs.push({ path, doc: RawDocument.fromBytes(bytes) });
    } else if (/\.png$/i.test(path)) {
      pngHandles.set(path, handle as FileSystemFileHandle);
    }
  }
  const pages = new Map<string, VanillaPage>();
  for (const { path, doc } of docs) {
    const dir = path.split('/').slice(0, -1).join('/');
    for (const tp of doc.tilePages()) {
      if (tp.file && tp.tileDim) pages.set(tp.id, { pngPath: joinPath(dir, tp.file), tile: tp.tileDim });
    }
  }
  return { docs, pages, pngHandles };
}

export function listCreatures(scan: VanillaScan): string[] {
  const ids = new Set<string>();
  for (const { doc } of scan.docs)
    for (const cg of doc.creatureGraphics())
      if (!cg.isStatue) ids.add(cg.creatureId);
  return [...ids].sort();
}

export type FoundSprite = SpriteRect & { pngPath?: string };

export function findCreatureSprites(scan: VanillaScan, creatureId: string): FoundSprite[] {
  const out: FoundSprite[] = [];
  for (const { doc } of scan.docs)
    for (const r of spriteRects(doc, creatureId))
      out.push({ ...r, pngPath: scan.pages.get(r.page)?.pngPath });
  return out;
}
