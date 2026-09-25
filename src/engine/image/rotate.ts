// Rotates an image a quarter turn; width and height swap. Used by the corpse
// draft (a creature drawn lying on its side).
import { type RgbaImage, createImage, getPixel, setPixel } from './pixels.ts';

// dir 1 = clockwise, -1 = counter-clockwise.
export function rotate90(img: RgbaImage, dir: 1 | -1 = 1): RgbaImage {
  const out = createImage(img.height, img.width);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const c = getPixel(img, x, y);
      if (dir === 1) setPixel(out, img.height - 1 - y, x, c);
      else setPixel(out, y, img.width - 1 - x, c);
    }
  }
  return out;
}
