// Palette and proportion statistics over RGBA pixel data. No image loading
// here: callers pass decoded pixels (a PNG decoder in tools/, canvas later).

export type RgbaImage = { width: number; height: number; data: Uint8Array | Uint8ClampedArray };
export type Box = { x: number; y: number; w: number; h: number };
export type Rect = Box;

// Measured inside one sprite, coordinates relative to its top left.
export type SpriteProportions = {
  bbox: Box;              // all opaque pixels
  head: Box | null;       // part beyond the narrowest "neck"; null when no clear neck
  body: Box;              // the rest (the whole bbox when head is null)
  headSide: 'top' | 'left' | 'right' | null;
  footBaseline: number;   // row of the lowest opaque pixel
};

// Pixels at or above this alpha count as part of the sprite.
export const OPAQUE = 128;

// Opaque pixel counts per colour (key 0xRRGGBB), optionally inside a rect.
export function paletteCounts(img: RgbaImage, rect?: Rect, into = new Map<number, number>()): Map<number, number> {
  const r = rect ?? { x: 0, y: 0, w: img.width, h: img.height };
  const d = img.data;
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const i = (y * img.width + x) * 4;
      if (d[i + 3] < OPAQUE) continue;
      const k = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
      into.set(k, (into.get(k) ?? 0) + 1);
    }
  }
  return into;
}

function mask(img: RgbaImage, r: Rect): Uint8Array {
  const m = new Uint8Array(r.w * r.h);
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++)
      m[y * r.w + x] = img.data[((r.y + y) * img.width + r.x + x) * 4 + 3] >= OPAQUE ? 1 : 0;
  return m;
}

function boxOf(m: Uint8Array, w: number, keep: (x: number, y: number) => boolean): Box | null {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let i = 0; i < m.length; i++) {
    if (!m[i]) continue;
    const x = i % w, y = (i / w) | 0;
    if (!keep(x, y)) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// Narrowest slice of a profile between from and to (inclusive), and how
// narrow it is against the widest slice on the head side of it (0-1, lower
// is a clearer neck). The head side runs from the profile start to the neck.
function neck(profile: number[], from: number, to: number): { at: number; ratio: number } | null {
  let at = -1;
  for (let i = from; i <= to; i++) if (at < 0 || profile[i] < profile[at]) at = i;
  if (at < 0) return null;
  const headMax = Math.max(...profile.slice(0, at));
  return headMax > 0 ? { at, ratio: profile[at] / headMax } : null;
}

// A neck counts when it is at most this fraction of the head's widest slice.
export const NECK_RATIO = 0.6;

// Head, body and foot baseline of the sprite inside rect. Heuristic: find the
// narrowest row in 20-60% of the height from the top (upright creatures), or
// the narrowest column in 20-60% of the width from either side (side-on
// animals), and take the clearest. Returns null for an empty tile.
export function spriteProportions(img: RgbaImage, rect: Rect): SpriteProportions | null {
  const m = mask(img, rect);
  const bbox = boxOf(m, rect.w, () => true);
  if (!bbox) return null;
  const rows: number[] = [], cols: number[] = [];
  for (let y = 0; y < bbox.h; y++) {
    let n = 0;
    for (let x = 0; x < bbox.w; x++) n += m[(bbox.y + y) * rect.w + bbox.x + x];
    rows.push(n);
  }
  for (let x = 0; x < bbox.w; x++) {
    let n = 0;
    for (let y = 0; y < bbox.h; y++) n += m[(bbox.y + y) * rect.w + bbox.x + x];
    cols.push(n);
  }
  const span = (len: number) => [Math.ceil(len * 0.2), Math.floor(len * 0.6)] as const;
  const cands: { side: 'top' | 'left' | 'right'; at: number; ratio: number }[] = [];
  if (bbox.h >= 6) { const n = neck(rows, ...span(bbox.h)); if (n) cands.push({ side: 'top', ...n }); }
  if (bbox.w >= 6) {
    const l = neck(cols, ...span(bbox.w));
    if (l) cands.push({ side: 'left', ...l });
    const r = neck([...cols].reverse(), ...span(bbox.w));
    if (r) cands.push({ side: 'right', at: bbox.w - 1 - r.at, ratio: r.ratio });
  }
  const best = cands.filter(c => c.ratio <= NECK_RATIO).sort((a, b) => a.ratio - b.ratio)[0];
  const footBaseline = bbox.y + bbox.h - 1;
  if (!best) return { bbox, head: null, body: bbox, headSide: null, footBaseline };
  const cut = (best.side === 'top' ? bbox.y : bbox.x) + best.at;
  const inHead = (x: number, y: number) =>
    best.side === 'top' ? y < cut : best.side === 'left' ? x < cut : x > cut;
  const head = boxOf(m, rect.w, inHead);
  const body = boxOf(m, rect.w, (x, y) => !inHead(x, y)) ?? bbox;
  return { bbox, head, body, headSide: head ? best.side : null, footBaseline };
}
