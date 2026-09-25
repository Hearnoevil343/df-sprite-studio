// Full-image flip (Edit menu Flip horizontal/vertical).
// Distinct from mirror() in mirror.ts, which copies one half onto the other
// for symmetric freehand drawing -- this reverses every pixel, so a lopsided
// sprite comes out mirrored end to end.
import { type RgbaImage, createImage, getPixel, setPixel } from './pixels.ts';

export function flip(img: RgbaImage, axis: 'x' | 'y'): RgbaImage {
  const out = createImage(img.width, img.height);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const c = getPixel(img, x, y);
      if (axis === 'x') setPixel(out, img.width - 1 - x, y, c);
      else setPixel(out, x, img.height - 1 - y, c);
    }
  }
  return out;
}
