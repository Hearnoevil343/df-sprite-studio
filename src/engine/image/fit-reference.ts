// Fits a reference image to an entry's pixel size:
// nearest-neighbour scale that keeps the reference's own proportions, then
// anchors it bottom-centre on a canvas of exactly (w, h) -- DF creatures
// stand on the tile's bottom edge, so a vanilla 32x32 reference lines up over
// a resized 96x64 (3x2) entry the same way a same-size reference already
// does. A reference already the right size comes back unchanged (same object).
import { createImage, getPixel, setPixel } from './pixels.ts';
import type { RgbaImage } from './pixels.ts';

export function fitReference(ref: RgbaImage, w: number, h: number): RgbaImage {
  if (ref.width === w && ref.height === h) return ref;
  if (w <= 0 || h <= 0 || ref.width <= 0 || ref.height <= 0) return createImage(Math.max(0, w), Math.max(0, h));
  const scale = Math.min(w / ref.width, h / ref.height);
  const sw = Math.max(1, Math.round(ref.width * scale));
  const sh = Math.max(1, Math.round(ref.height * scale));
  const out = createImage(w, h);
  const ox = Math.floor((w - sw) / 2);
  const oy = h - sh;
  for (let y = 0; y < sh; y++) {
    const dy = oy + y;
    if (dy < 0 || dy >= h) continue;
    const sy = Math.min(ref.height - 1, Math.floor(y / scale));
    for (let x = 0; x < sw; x++) {
      const dx = ox + x;
      if (dx < 0 || dx >= w) continue;
      const sx = Math.min(ref.width - 1, Math.floor(x / scale));
      setPixel(out, dx, dy, getPixel(ref, sx, sy));
    }
  }
  return out;
}
