import type { Palette } from '../palette/palette.ts';
import { rampStep } from '../palette/palette.ts';
import { type Rgba, type RgbaImage, cloneImage, getPixel, inBounds, setPixel } from './pixels.ts';

const NEIGHBOURS = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const;

// Fills transparent pixels next to the sprite's silhouette with an outline
// colour: one ramp step darker than the opaque neighbour they touch (mode
// 'ramp'), or a single fixed colour (mode is that Rgba). Reads from a frozen
// copy of `img` so the outline never spreads into itself, then mutates `img`
// in place and returns the changed pixels (mirroring floodFill's contract).
export function outline(img: RgbaImage, palette: Palette, mode: 'ramp' | Rgba): { x: number; y: number }[] {
  const before = cloneImage(img);
  const changed: { x: number; y: number }[] = [];
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (getPixel(before, x, y)[3] !== 0) continue;
      let neighbour: Rgba | null = null;
      for (const [dx, dy] of NEIGHBOURS) {
        const nx = x + dx, ny = y + dy;
        if (!inBounds(before, nx, ny)) continue;
        const n = getPixel(before, nx, ny);
        if (n[3] !== 0) { neighbour = n; break; }
      }
      if (!neighbour) continue;
      const colour = mode === 'ramp' ? rampStep(palette, neighbour, -1) : mode;
      setPixel(img, x, y, colour);
      changed.push({ x, y });
    }
  }
  return changed;
}
