// Rectangle-outline tool primitive: outline only, filled rect is Fill
// afterwards. Corners are given in either order.
import { type Rgba, type RgbaImage, inBounds, setPixel } from './pixels.ts';

export function drawRectOutline(img: RgbaImage, x0: number, y0: number, x1: number, y1: number, colour: Rgba): { x: number; y: number }[] {
  const left = Math.min(x0, x1), right = Math.max(x0, x1);
  const top = Math.min(y0, y1), bottom = Math.max(y0, y1);
  const changed: { x: number; y: number }[] = [];
  const put = (x: number, y: number): void => {
    if (!inBounds(img, x, y)) return;
    setPixel(img, x, y, colour);
    changed.push({ x, y });
  };
  for (let x = left; x <= right; x++) { put(x, top); put(x, bottom); }
  for (let y = top; y <= bottom; y++) { put(left, y); put(right, y); }
  return changed;
}
