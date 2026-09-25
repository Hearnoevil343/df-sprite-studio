// PNG decode for the browser: createImageBitmap + a canvas, unlike
// tools/png.ts (Node, zlib-only, used offline by the stats tool).
import type { RgbaImage } from '../../engine/index.ts';

export async function decodeImageBlob(blob: Blob): Promise<RgbaImage> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D context unavailable');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bitmap, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  return { width, height, data };
}

// PNG bytes of an image, nearest-neighbour scaled up, as base64 (no data: prefix).
export function encodeImageBase64(img: RgbaImage, scale = 1): string {
  const small = document.createElement('canvas');
  small.width = img.width;
  small.height = img.height;
  small.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  const big = document.createElement('canvas');
  big.width = img.width * scale;
  big.height = img.height * scale;
  const ctx = big.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, big.width, big.height);
  return big.toDataURL('image/png').split(',')[1];
}

export async function decodeImageFile(handle: FileSystemFileHandle): Promise<RgbaImage> {
  return decodeImageBlob(await handle.getFile());
}
