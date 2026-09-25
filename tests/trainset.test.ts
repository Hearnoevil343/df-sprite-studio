import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImage, setPixel, trainingCaption, trainingImages, TRAIN_CANVAS } from '../src/engine/index.ts';
import { decodePng } from '../tools/png.ts';
import { writeTrainingSet } from '../tools/studio-server.ts';

function sprite() {
  const img = createImage(32, 32);
  setPixel(img, 10, 20, [10, 20, 30, 255]);
  setPixel(img, 11, 20, [10, 20, 30, 255]);
  return img;
}

test('trainingImages crops, x8, centres on magenta', () => {
  const { tile, train } = trainingImages(sprite());
  assert.equal(tile.width, 32);
  assert.equal(train.width, TRAIN_CANVAS);
  assert.deepEqual([...train.data.slice(0, 4)], [255, 0, 255, 255]);
  const mid = ((TRAIN_CANVAS / 2) * TRAIN_CANVAS + TRAIN_CANVAS / 2) * 4;
  assert.deepEqual([...train.data.slice(mid, mid + 3)], [10, 20, 30]);
});

test('trainingImages and caption reject empty input', () => {
  assert.throws(() => trainingImages(createImage(32, 32)), /nothing drawn/);
  assert.throws(() => trainingCaption('  '));
  assert.match(trainingCaption(' brown  bear '), /^dfsprite style, .*brown bear, magenta background$/);
});

test('writeTrainingSet writes tiles/ + train/ png and caption, never overwrites', () => {
  const root = mkdtempSync(join(tmpdir(), 'trainset-'));
  const s = sprite();
  const body = { name: 'Bear DEFAULT', caption: 'brown bear', width: 32, height: 32, rgba: Buffer.from(s.data).toString('base64') };
  const a = writeTrainingSet(root, body);
  const b = writeTrainingSet(root, body);
  assert.equal(a, 'studio__bear_default');
  assert.equal(b, 'studio__bear_default_2');
  assert.equal(decodePng(readFileSync(join(root, 'tiles', `${a}.png`))).width, 32);
  assert.equal(decodePng(readFileSync(join(root, 'train', `${a}.png`))).width, 1024);
  assert.match(readFileSync(join(root, 'train', `${a}.txt`), 'utf8'), /brown bear/);
  assert.equal(readdirSync(join(root, "train")).length, 4);
  assert.ok(existsSync(join(root, 'tiles', `${b}.png`)));
});
