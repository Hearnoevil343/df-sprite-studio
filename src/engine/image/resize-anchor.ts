// Resizes a sprite's canvas to a new pixel size, anchored bottom-centre (DF
// creatures stand on the tile's bottom edge): growing pads the new rows/
// columns with transparency, shrinking crops from the top and both sides.
// Used by the size picker when a creature's entry
// size changes. `clipped` is true when a crop would have dropped an opaque
// pixel, so the caller can confirm with the user before committing.
import { createImage, getPixel, setPixel } from './pixels.ts';
import type { RgbaImage } from './pixels.ts';

export function resizeAnchored(img: RgbaImage, w: number, h: number): { image: RgbaImage; clipped: boolean } {
  if (img.width === w && img.height === h) return { image: img, clipped: false };
  const dx = Math.floor((w - img.width) / 2);
  const dy = h - img.height;
  const out = createImage(w, h);
  let clipped = false;
  for (let y = 0; y < img.height; y++) {
    const ty = y + dy;
    for (let x = 0; x < img.width; x++) {
      const p = getPixel(img, x, y);
      const tx = x + dx;
      if (tx < 0 || tx >= w || ty < 0 || ty >= h) {
        if (p[3] !== 0) clipped = true;
        continue;
      }
      setPixel(out, tx, ty, p);
    }
  }
  return { image: out, clipped };
}
