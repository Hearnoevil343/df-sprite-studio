// Line tool primitive: a Bresenham line drawn straight
// into the image, mutating it in place and returning the touched pixels so
// the caller can mirror them (Mirror X) the same way floodFill's changed list
// already works.
import { type Rgba, type RgbaImage, inBounds, setPixel } from './pixels.ts';

export function drawLine(img: RgbaImage, x0: number, y0: number, x1: number, y1: number, colour: Rgba): { x: number; y: number }[] {
  const changed: { x: number; y: number }[] = [];
  let x = x0, y = y0;
  const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    if (inBounds(img, x, y)) { setPixel(img, x, y, colour); changed.push({ x, y }); }
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
  return changed;
}
