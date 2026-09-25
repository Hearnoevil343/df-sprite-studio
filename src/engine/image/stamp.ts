// Pastes src onto dest at (x, y), clipped to dest's bounds (selection
// move/paste/flip/rotate-in-place all paste a cropped sub-image back onto
// the sprite). Overwrites fully, including transparent src pixels,
// since a rectangular selection moves as one block.
import { type RgbaImage, getPixel, inBounds, setPixel } from './pixels.ts';

export function stamp(dest: RgbaImage, x: number, y: number, src: RgbaImage): void {
  for (let sy = 0; sy < src.height; sy++) {
    const dy = y + sy;
    for (let sx = 0; sx < src.width; sx++) {
      const dx = x + sx;
      if (!inBounds(dest, dx, dy)) continue;
      setPixel(dest, dx, dy, getPixel(src, sx, sy));
    }
  }
}
