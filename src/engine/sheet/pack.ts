// Packer and slicer for a mod's creature sheet. Each creature gets a band of
// rows as tall as its template's footprint, stacked top to bottom, so the
// layout depends only on the creature list and template choices (not on
// which sprites happen to be drawn) and stays stable across exports.
import { createImage, getPixel, setPixel } from '../image/pixels.ts';
import type { RgbaImage } from '../image/pixels.ts';
import { crop } from '../image/crop.ts';
import type { Box } from '../stats/sheet-stats.ts';
import { resolveEntries, templateById, templateFootprint } from '../templates/template.ts';
import type { EntrySizes } from '../templates/template.ts';

export const TILE = 32;

export type SheetCreature = {
  templateId: string;
  include: string[];
  omit: string[];
  sprites: Record<string, RgbaImage>;
  sizes?: EntrySizes;      // per-entry size override
};

// Re-exported for callers that used to get it from here (sheet/index.ts).
export { templateFootprint };

export type PackedSheet = {
  image: RgbaImage;
  tiles: [number, number];       // page size in tiles
  origins: [number, number][];   // origin tile per creature, input order
};

function blit(dst: RgbaImage, src: RgbaImage, dx: number, dy: number, w: number, h: number): void {
  for (let y = 0; y < Math.min(h, src.height); y++) {
    for (let x = 0; x < Math.min(w, src.width); x++) setPixel(dst, dx + x, dy + y, getPixel(src, x, y));
  }
}

export function packSheet(creatures: SheetCreature[]): PackedSheet {
  const origins: [number, number][] = [];
  const perCreature = creatures.map(c => {
    const t = templateById(c.templateId);
    if (!t) throw new Error(`packSheet: unknown template ${c.templateId}`);
    return resolveEntries(t, c);
  });
  let width = 1, height = 0;
  perCreature.forEach((entries, i) => {
    // Start from the template's own (unresized) footprint -- covering every
    // entry, on or off -- so a creature with no size override packs into
    // exactly the same band as before (stable regardless of which sprites
    // are drawn or omitted); grow it only if a resized entry needs more room.
    const [fw, fh] = templateFootprint(templateById(creatures[i].templateId)!);
    let w = fw, h = fh;
    for (const e of entries) { w = Math.max(w, e.at[0] + e.size[0]); h = Math.max(h, e.at[1] + e.size[1]); }
    origins.push([0, height]);
    width = Math.max(width, w);
    height += h;
  });
  height = Math.max(height, 1);
  const image = createImage(width * TILE, height * TILE);
  creatures.forEach((c, i) => {
    const [ox, oy] = origins[i];
    for (const e of perCreature[i]) {
      const sprite = c.sprites[e.key];
      if (!sprite) continue;
      blit(image, sprite, (ox + e.at[0]) * TILE, (oy + e.at[1]) * TILE, e.size[0] * TILE, e.size[1] * TILE);
    }
  });
  return { image, tiles: [width, height], origins };
}

export function isBlank(img: RgbaImage): boolean {
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] !== 0) return false;
  return true;
}

// Cuts named rects out of a page. Blank rects are left out, since a sprite
// that was never drawn packs to a fully transparent rect.
export function sliceSheet(page: RgbaImage, rects: { key: string; rect: Box }[]): Record<string, RgbaImage> {
  const out: Record<string, RgbaImage> = {};
  for (const { key, rect } of rects) {
    const img = crop(page, rect);
    if (!isBlank(img)) out[key] = img;
  }
  return out;
}
