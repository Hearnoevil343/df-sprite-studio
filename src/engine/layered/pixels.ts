// Pixels for layered creatures: page images, tile rect read and write-back,
// LS_PALETTE row swap, and rendering a Composite's Draw list to one image.
// Pure: callers decode the PNGs (tools/png.ts, app/io/browser-png.ts) and pass
// them in. Layered sprites are page-backed, so art edits write into the page
// image and change no raw tokens.
import { compose, crop, createImage, getPixel, samePixel, setPixel } from '../image/index.ts';
import type { Rgba, RgbaImage } from '../image/index.ts';
import type { TilePage } from '../raw/document.ts';
import type { LayerRef } from '../raw/layers.ts';
import type { Composite } from './evaluate.ts';

export type PageImage = { tile: [number, number]; image: RgbaImage };
export type PageImages = Map<string, PageImage>;
type PageRef = Extract<LayerRef, { page: string }>;

// Page id -> image, sized by the page's TILE_DIM. `load` gets the page's FILE
// path as written; pages with no FILE, no TILE_DIM or no image are skipped.
export function buildPageImages(pages: TilePage[], load: (file: string) => RgbaImage | undefined): PageImages {
  const out: PageImages = new Map();
  for (const p of pages) {
    const file = p.file, tile = p.tileDim;
    const image = file ? load(file) : undefined;
    if (image && tile) out.set(p.id, { tile, image });
  }
  return out;
}

// Pixel rect of a layer's tiles. A LARGE_IMAGE rect is two inclusive tile corners.
export function tileRect(ref: PageRef, tile: [number, number]): { x: number; y: number; w: number; h: number } {
  const [x1, y1, x2, y2] = ref.rect;
  return { x: x1 * tile[0], y: y1 * tile[1], w: (x2 - x1 + 1) * tile[0], h: (y2 - y1 + 1) * tile[1] };
}

export function readTile(pages: PageImages, ref: PageRef): RgbaImage | undefined {
  const p = pages.get(ref.page);
  return p && crop(p.image, tileRect(ref, p.tile));
}

// Copy `img` into the page image in place. Returns false if the page is
// unknown, the size differs from the rect, or the rect leaves the page.
export function writeTile(pages: PageImages, ref: PageRef, img: RgbaImage): boolean {
  const p = pages.get(ref.page);
  if (!p) return false;
  const r = tileRect(ref, p.tile);
  if (img.width !== r.w || img.height !== r.h) return false;
  if (r.x < 0 || r.y < 0 || r.x + r.w > p.image.width || r.y + r.h > p.image.height) return false;
  for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) setPixel(p.image, r.x + x, r.y + y, getPixel(img, x, y));
  return true;
}

// A palette PNG: one row per palette, one column per colour.
export function paletteRow(img: RgbaImage, row: number): Rgba[] | undefined {
  if (row < 0 || row >= img.height) return undefined;
  return Array.from({ length: img.width }, (_, x) => getPixel(img, x, row));
}

// Every pixel equal to column c of `from` becomes column c of `to`.
export function swapPalette(img: RgbaImage, from: Rgba[], to: Rgba[]): RgbaImage {
  const out = createImage(img.width, img.height);
  out.data.set(img.data);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const px = getPixel(img, x, y);
      if (px[3] === 0) continue;
      const c = from.findIndex(f => samePixel(f, px));
      if (c >= 0 && c < to.length) setPixel(out, x, y, to[c]);
    }
  }
  return out;
}

// Appends a new row to a palette PNG (11x13 for BODY, one colour per
// column) and returns the grown image plus the new row's index, so a mod
// can define e.g. a skin tone or hair colour vanilla doesn't have. `colours`
// fills the row left to right; any column past its length is left blank
// (alpha 0), matching how a short row already reads in swapPalette (no
// column match -> pixel unswapped). No raw token names the row's colours --
// LS_PALETTE_DEFAULT (setPaletteDefaultRow, raw/layers.ts) only names which
// row is the *default*; a new USE_PALETTE:<name>:<row> on a layer is what
// makes a mod actually draw with it.
export function addPaletteRow(img: RgbaImage, colours: Rgba[]): { image: RgbaImage; row: number } {
  const row = img.height;
  const out = createImage(img.width, img.height + 1);
  out.data.set(img.data);
  colours.slice(0, img.width).forEach((c, x) => setPixel(out, x, row, c));
  return { image: out, row };
}

export type Rendered = { image: RgbaImage; origin: [number, number]; notes: string[] };

// Turn a Composite's Draw list into pixels. `palettes` maps an LS_PALETTE_FILE
// path to its decoded PNG. Offsets are pixels; the canvas grows to fit them and
// `origin` is where offset (0,0) landed. Missing art or palettes become notes.
export function renderComposite(c: Composite, pages: PageImages, palettes: Map<string, RgbaImage>): Rendered {
  const notes = [...c.notes];
  const parts: { img: RgbaImage; x: number; y: number }[] = [];
  for (const d of c.draws) {
    const ref = d.layer.ref;
    if (!('page' in ref)) { notes.push(`${d.layer.name}: argument art not drawn`); continue; }
    let img = readTile(pages, ref);
    if (!img) { notes.push(`${d.layer.name}: page ${ref.page} has no image`); continue; }
    const pal = d.layer.palette;
    if (pal === 'FROM_ITEM') notes.push(`${d.layer.name}: item palette not known, drawn as authored`);
    else if (pal) {
      const ls = c.set?.palettes.find(p => p.name === pal.name);
      const src = ls?.file ? palettes.get(ls.file) : undefined;
      const from = src && ls && paletteRow(src, ls.defaultRow);
      const to = src && paletteRow(src, pal.row);
      if (from && to) img = swapPalette(img, from, to);
      else notes.push(`${d.layer.name}: palette ${pal.name} row ${pal.row} not found, drawn unswapped`);
    }
    parts.push({ img, x: d.offset[0], y: d.offset[1] });
  }
  const minX = Math.min(0, ...parts.map(p => p.x)), minY = Math.min(0, ...parts.map(p => p.y));
  const maxX = Math.max(0, ...parts.map(p => p.x + p.img.width)), maxY = Math.max(0, ...parts.map(p => p.y + p.img.height));
  const image = compose(maxX - minX, maxY - minY, parts.map(p => ({ img: p.img, x: p.x - minX, y: p.y - minY })));
  return { image, origin: [-minX, -minY], notes };
}
