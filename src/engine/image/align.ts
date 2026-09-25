// Shifts a sprite vertically, same canvas size, so its own lowest opaque row
// lands on `footBaseline`. Pixels shifted off the canvas are dropped. A
// sprite with no opaque pixels comes back unchanged.
import { type RgbaImage, cloneImage, createImage, getPixel, setPixel } from './pixels.ts';

export function bottomAlign(img: RgbaImage, footBaseline: number): RgbaImage {
  let bottom = -1;
  outer: for (let y = img.height - 1; y >= 0; y--) {
    for (let x = 0; x < img.width; x++) {
      if (getPixel(img, x, y)[3] !== 0) { bottom = y; break outer; }
    }
  }
  if (bottom < 0) return cloneImage(img);
  const dy = footBaseline - bottom;
  if (dy === 0) return cloneImage(img);
  const out = createImage(img.width, img.height);
  for (let y = 0; y < img.height; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= img.height) continue;
    for (let x = 0; x < img.width; x++) setPixel(out, x, y, getPixel(img, x, sy));
  }
  return out;
}
