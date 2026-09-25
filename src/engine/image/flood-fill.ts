import { type Rgba, type RgbaImage, getPixel, inBounds, samePixel, setPixel } from './pixels.ts';

// 4-connected flood fill from (x, y) to colour `to`. No-op when the target
// pixel already matches `to`, so a fill click never becomes a wasted undo
// entry. Returns the list of pixels changed, for callers that want it.
export function floodFill(img: RgbaImage, x: number, y: number, to: Rgba): { x: number; y: number }[] {
  if (!inBounds(img, x, y)) return [];
  const from = getPixel(img, x, y);
  if (samePixel(from, to)) return [];
  const changed: { x: number; y: number }[] = [];
  const stack: [number, number][] = [[x, y]];
  while (stack.length) {
    const [cx, cy] = stack.pop()!;
    if (!inBounds(img, cx, cy) || !samePixel(getPixel(img, cx, cy), from)) continue;
    setPixel(img, cx, cy, to);
    changed.push({ x: cx, y: cy });
    stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
  }
  return changed;
}
