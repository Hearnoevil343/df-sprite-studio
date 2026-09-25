import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createImage, setPixel } from '../src/engine/index.ts';
import { decodePng, encodePng } from '../tools/png.ts';

test('encodePng / decodePng round trip an RGBA image pixel-for-pixel', () => {
  const img = createImage(3, 2);
  setPixel(img, 0, 0, [255, 0, 0, 255]);
  setPixel(img, 1, 0, [0, 255, 0, 128]);
  setPixel(img, 2, 1, [0, 0, 0, 0]);
  const back = decodePng(encodePng(img));
  assert.equal(back.width, 3);
  assert.equal(back.height, 2);
  assert.deepEqual([...back.data], [...img.data]);
});

test('encodePng writes a valid PNG signature and chunk structure', () => {
  const bytes = encodePng(createImage(1, 1));
  assert.deepEqual([...bytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const chunkTypes: string[] = [];
  let pos = 8;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (pos < bytes.length) {
    const len = dv.getUint32(pos);
    chunkTypes.push(String.fromCharCode(...bytes.subarray(pos + 4, pos + 8)));
    pos += 12 + len;
  }
  assert.deepEqual(chunkTypes, ['IHDR', 'IDAT', 'IEND']);
});
