// Pure layout for "add to training set": the 32 px original for tiles/, and
// the 1024 px magenta-keyed image plus caption for train/, in the same shape
// as E:\df-ai-art-5080\tools\build_creatures.py (crop to the drawn box, x8 nearest,
// centred on a 1024 magenta canvas). No file I/O here; see tools/studio-server.ts.
import { createImage } from '../image/index.ts';
import type { RgbaImage } from '../image/index.ts';

export const TRAIN_CANVAS = 1024;
export const TRAIN_SCALE = 8;
const KEY = [255, 0, 255];

export function trainingCaption(description: string): string {
  const d = description.trim().replace(/\s+/g, ' ');
  if (!d) throw new Error('empty caption');
  return `dfsprite style, pixel art creature sprite, ${d}, magenta background`;
}

// Throws if nothing is drawn: a blank tile must never enter the training set.
export function trainingImages(sprite: RgbaImage): { tile: RgbaImage; train: RgbaImage } {
  let x0 = sprite.width, y0 = sprite.height, x1 = -1, y1 = -1;
  for (let y = 0; y < sprite.height; y++) {
    for (let x = 0; x < sprite.width; x++) {
      if (sprite.data[(y * sprite.width + x) * 4 + 3] === 0) continue;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
  }
  if (x1 < 0) throw new Error('nothing drawn');
  const train = createImage(TRAIN_CANVAS, TRAIN_CANVAS);
  for (let i = 0; i < train.data.length; i += 4) { train.data[i] = KEY[0]; train.data[i + 1] = KEY[1]; train.data[i + 2] = KEY[2]; train.data[i + 3] = 255; }
  const ox = (TRAIN_CANVAS - (x1 - x0 + 1) * TRAIN_SCALE) >> 1;
  const oy = (TRAIN_CANVAS - (y1 - y0 + 1) * TRAIN_SCALE) >> 1;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const s = (y * sprite.width + x) * 4;
      if (sprite.data[s + 3] === 0) continue;
      for (let dy = 0; dy < TRAIN_SCALE; dy++) {
        for (let dx = 0; dx < TRAIN_SCALE; dx++) {
          const d = ((oy + (y - y0) * TRAIN_SCALE + dy) * TRAIN_CANVAS + ox + (x - x0) * TRAIN_SCALE + dx) * 4;
          train.data[d] = sprite.data[s]; train.data[d + 1] = sprite.data[s + 1]; train.data[d + 2] = sprite.data[s + 2]; train.data[d + 3] = 255;
        }
      }
    }
  }
  return { tile: sprite, train };
}
