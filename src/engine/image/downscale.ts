// Shrinks an image to w x h, one output pixel per source cell: the cell's
// most common opaque colour, or transparent when fewer than half the cell's
// pixels are opaque. Used by the child draft and by fitting a rotated
// multi-tile corpse back into a single tile.
import { type Rgba, type RgbaImage, createImage, getPixel, setPixel } from './pixels.ts';

export function downscale(img: RgbaImage, w: number, h: number): RgbaImage {
  const out = createImage(w, h);
  const cellW = img.width / w, cellH = img.height / h;
  for (let cy = 0; cy < h; cy++) {
    const y0 = Math.floor(cy * cellH), y1 = Math.floor((cy + 1) * cellH);
    for (let cx = 0; cx < w; cx++) {
      const x0 = Math.floor(cx * cellW), x1 = Math.floor((cx + 1) * cellW);
      const counts = new Map<string, { c: Rgba; n: number }>();
      let total = 0, opaque = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          total++;
          const c = getPixel(img, x, y);
          if (c[3] === 0) continue;
          opaque++;
          const key = c.join(',');
          const e = counts.get(key);
          if (e) e.n++; else counts.set(key, { c, n: 1 });
        }
      }
      if (total === 0 || opaque * 2 < total) continue;
      let best: Rgba = [0, 0, 0, 0], bestN = -1;
      for (const { c, n } of counts.values()) if (n > bestN) { bestN = n; best = c; }
      setPixel(out, cx, cy, best);
    }
  }
  return out;
}
