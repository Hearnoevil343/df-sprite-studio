import { type RgbaImage, cloneImage, getPixel, setPixel } from './pixels.ts';

// Mirrors the image in place, left half onto right (or top half onto bottom)
// so freehand sprite drawing stays symmetric. Reads from a clone so source
// and destination never alias each other mid-copy.
export function mirror(img: RgbaImage, axis: 'x' | 'y'): void {
  const src = cloneImage(img);
  if (axis === 'x') {
    const half = Math.floor(img.width / 2);
    for (let y = 0; y < img.height; y++)
      for (let x = 0; x < half; x++)
        setPixel(img, img.width - 1 - x, y, getPixel(src, x, y));
  } else {
    const half = Math.floor(img.height / 2);
    for (let y = 0; y < half; y++)
      for (let x = 0; x < img.width; x++)
        setPixel(img, x, img.height - 1 - y, getPixel(src, x, y));
  }
}
