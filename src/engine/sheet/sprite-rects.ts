// Pixel rectangles of a creature's sprites on their tile pages, for browsing
// vanilla art by creature. Entry meaning beyond the coordinates (layers,
// conditions) is left to the template layer; this only resolves tile
// coordinates to a pixel rect on a named page.
import type { CreatureGraphics, RawDocument } from '../raw/document.ts';
import type { Box } from '../stats/sheet-stats.ts';

export type SpriteRect = {
  token: string;
  caste?: string;
  page: string;
  rect: Box;
};

const DEFAULT_TILE: [number, number] = [32, 32];

// Reads the x1:y1:x2:y2 tile span (in tiles, inclusive) out of a creature or
// statue entry's arguments, whatever form it was written in.
export function tileSpan(args: string[], isStatue: boolean): [number, number, number, number] | null {
  const rest = args.slice(2);
  const nums = (a: string[]) => a.map(Number);
  if (isStatue) {
    if (rest.length < 2) return null;
    const [x1, y1, x2, y2] = nums(rest.length >= 4 ? rest.slice(0, 4) : [rest[0], rest[1], rest[0], rest[1]]);
    return [x1, y1, x2, y2].some(Number.isNaN) ? null : [x1, y1, x2, y2];
  }
  if (rest[0] === 'LARGE_IMAGE') {
    const [x1, y1, x2, y2] = nums(rest.slice(1, 5));
    return [x1, y1, x2, y2].some(Number.isNaN) ? null : [x1, y1, x2, y2];
  }
  const [x, y] = nums(rest.slice(0, 2));
  return Number.isNaN(x) || Number.isNaN(y) ? null : [x, y, x, y];
}

export type TileGraphicsRect = { page: string; name: string; rect: Box };

// Resolves plain [TILE_GRAPHICS:page:x:y:name] entries (floor tiles, spatters,
// etc. — not creature graphics, which spriteRects above handles) to pixel
// rects on their page. tileDim defaults to 32x32 since the page defining it
// (TILE_PAGE) commonly lives in a different vanilla file than the one with
// the TILE_GRAPHICS entries; pass the real value when known.
export function tileGraphicsRects(doc: RawDocument, page: string, tileDim: [number, number] = DEFAULT_TILE): TileGraphicsRect[] {
  const [tw, th] = tileDim;
  const out: TileGraphicsRect[] = [];
  for (const b of doc.blocks()) {
    if (b.header.args[0] !== 'TILE_GRAPHICS' || b.header.args[1] !== page) continue;
    const [, , xs, ys, name] = b.header.args;
    const x = Number(xs), y = Number(ys);
    if (Number.isNaN(x) || Number.isNaN(y) || !name) continue;
    out.push({ page, name, rect: { x: x * tw, y: y * th, w: tw, h: th } });
  }
  return out;
}

export function spriteRects(doc: RawDocument, creatureId: string): SpriteRect[] {
  const pages = new Map(doc.tilePages().map(tp => [tp.id, tp]));
  const out: SpriteRect[] = [];
  const groups: CreatureGraphics[] = doc.creatureGraphics().filter(cg => cg.creatureId === creatureId);
  for (const cg of groups) {
    for (const e of cg.entries) {
      const [token, page] = e.args;
      if (!page) continue;
      const span = tileSpan(e.args, cg.isStatue);
      if (!span) continue;
      const [tw, th] = pages.get(page)?.tileDim ?? DEFAULT_TILE;
      const [x1, y1, x2, y2] = span;
      out.push({
        token, caste: cg.caste, page,
        rect: { x: x1 * tw, y: y1 * th, w: (x2 - x1 + 1) * tw, h: (y2 - y1 + 1) * th },
      });
    }
  }
  return out;
}
