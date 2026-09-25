import { type RgbaImage, getPixel, inBounds } from './pixels.ts';

export type LightDir = 'top' | 'top-right' | 'right' | 'bottom-right' | 'bottom' | 'bottom-left' | 'left' | 'top-left';

// Unit-ish vector pointing from the sprite toward the light source.
const DIR_VECTOR: Record<LightDir, readonly [number, number]> = {
  'top': [0, -1], 'top-right': [1, -1], 'right': [1, 0], 'bottom-right': [1, 1],
  'bottom': [0, 1], 'bottom-left': [-1, 1], 'left': [-1, 0], 'top-left': [-1, -1],
};

const NEIGHBOURS = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const;

// Silhouette-edge pixels classified as lit (their open side faces the light)
// or in shadow (it faces away). An edge whose open side is perpendicular to
// the light direction (dot product 0) is neither and is left out. A UI
// applies the actual shading with rampStep(palette, colour, +1 for lit, -1
// for shadow) on whichever hints the user confirms.
export function lightHints(img: RgbaImage, dir: LightDir): { x: number; y: number; kind: 'lit' | 'shadow' }[] {
  const [lx, ly] = DIR_VECTOR[dir];
  const hints: { x: number; y: number; kind: 'lit' | 'shadow' }[] = [];
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (getPixel(img, x, y)[3] === 0) continue;
      let ox = 0, oy = 0, isEdge = false;
      for (const [dx, dy] of NEIGHBOURS) {
        const nx = x + dx, ny = y + dy;
        if (!inBounds(img, nx, ny) || getPixel(img, nx, ny)[3] === 0) {
          isEdge = true;
          ox += dx; oy += dy;
        }
      }
      if (!isEdge) continue;
      const dot = ox * lx + oy * ly;
      if (dot === 0) continue;
      hints.push({ x, y, kind: dot > 0 ? 'lit' : 'shadow' });
    }
  }
  return hints;
}
