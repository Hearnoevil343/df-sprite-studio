// Stack images onto a blank canvas of the given size, later layers on top.
// Alpha is 0 or 255 only (project convention), so this is a plain overwrite
// of opaque source pixels, not alpha blending.
import { createImage, getPixel, setPixel } from './pixels.ts';
import type { RgbaImage } from './pixels.ts';

export type Layer = { img: RgbaImage; x: number; y: number };

export function compose(width: number, height: number, layers: Layer[]): RgbaImage {
  const out = createImage(width, height);
  for (const { img, x, y } of layers) {
    for (let j = 0; j < img.height; j++) {
      const oy = y + j;
      if (oy < 0 || oy >= height) continue;
      for (let i = 0; i < img.width; i++) {
        const ox = x + i;
        if (ox < 0 || ox >= width) continue;
        const src = getPixel(img, i, j);
        if (src[3] === 0) continue;
        setPixel(out, ox, oy, src);
      }
    }
  }
  return out;
}
