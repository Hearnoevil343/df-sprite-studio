// Extract a sub-image. Pixels outside img's bounds come back transparent.
import { createImage, getPixel, setPixel } from './pixels.ts';
import type { RgbaImage } from './pixels.ts';

export function crop(img: RgbaImage, rect: { x: number; y: number; w: number; h: number }): RgbaImage {
  const out = createImage(rect.w, rect.h);
  for (let y = 0; y < rect.h; y++) {
    const sy = rect.y + y;
    if (sy < 0 || sy >= img.height) continue;
    for (let x = 0; x < rect.w; x++) {
      const sx = rect.x + x;
      if (sx < 0 || sx >= img.width) continue;
      setPixel(out, x, y, getPixel(img, sx, sy));
    }
  }
  return out;
}
