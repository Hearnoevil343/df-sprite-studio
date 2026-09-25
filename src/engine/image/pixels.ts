// Pixel-level ops on RGBA images. Alpha is 0 or 255 only
// (palette lock is enforced by the tools, not the pixel format).

export type RgbaImage = { width: number; height: number; data: Uint8Array | Uint8ClampedArray };
export type Rgba = [number, number, number, number];

export function createImage(width: number, height: number): RgbaImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function inBounds(img: RgbaImage, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < img.width && y < img.height;
}

export function getPixel(img: RgbaImage, x: number, y: number): Rgba {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}

export function setPixel(img: RgbaImage, x: number, y: number, c: Rgba): void {
  const i = (y * img.width + x) * 4;
  img.data[i] = c[0]; img.data[i + 1] = c[1]; img.data[i + 2] = c[2]; img.data[i + 3] = c[3];
}

export function samePixel(a: Rgba, b: Rgba): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

export function cloneImage(img: RgbaImage): RgbaImage {
  return { width: img.width, height: img.height, data: img.data.slice() as Uint8ClampedArray };
}
