import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findModRoots, readModDir, writeModDir } from '../tools/mod-fs.ts';
import { createImage, setPixel } from '../src/engine/index.ts';

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'df-sprite-studio-'));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('findModRoots: a folder with info.txt is itself a mod root', () => {
  withTempDir(dir => {
    writeFileSync(join(dir, 'info.txt'), '[ID:x]');
    assert.deepEqual(findModRoots(dir), [dir]);
  });
});

test('findModRoots: one level down covers mods/, installed_mods/, a workshop folder', () => {
  withTempDir(dir => {
    mkdirSync(join(dir, 'mod_a'));
    writeFileSync(join(dir, 'mod_a', 'info.txt'), '[ID:a]');
    mkdirSync(join(dir, 'mod_b'));
    writeFileSync(join(dir, 'mod_b', 'info.txt'), '[ID:b]');
    mkdirSync(join(dir, 'not_a_mod'));
    assert.deepEqual(findModRoots(dir), [join(dir, 'mod_a'), join(dir, 'mod_b')]);
  });
});

test('findModRoots: neither a mod nor a folder of mods returns nothing', () => {
  withTempDir(dir => assert.deepEqual(findModRoots(dir), []));
});

test('readModDir/writeModDir round-trip a mod folder byte-for-byte', () => {
  withTempDir(dir => {
    const root = join(dir, 'my_mod');
    mkdirSync(join(root, 'graphics'), { recursive: true });
    writeFileSync(join(root, 'info.txt'), '[ID:my_mod]');
    writeFileSync(join(root, 'graphics', 'g.txt'), 'graphics_g\n\n[OBJECT:GRAPHICS]\n');
    const files = readModDir(root);
    assert.deepEqual(files.map(f => f.path).sort(), ['graphics/g.txt', 'info.txt']);

    const out = join(dir, 'out_mod');
    writeModDir(out, files);
    const back = readModDir(out);
    assert.deepEqual(back.map(f => f.path).sort(), files.map(f => f.path).sort());
    for (const f of files) {
      const g = back.find(b => b.path === f.path)!;
      assert.deepEqual(Array.from(g.bytes!), Array.from(f.bytes!));
    }
  });
});

test('readModDir decodes PNGs to images, not raw bytes', () => {
  withTempDir(dir => {
    writeFileSync(join(dir, 'info.txt'), '[ID:x]');
    writeFileSync(join(dir, 'not-a-png.txt'), 'hello');
    const files = readModDir(dir);
    assert.ok(files.every(f => f.bytes && !f.image));
  });
});

test('writeModDir encodes an image-only ModFile to PNG, and it reads back pixel-identical', () => {
  withTempDir(dir => {
    const img = createImage(2, 2);
    setPixel(img, 0, 0, [255, 0, 0, 255]);
    setPixel(img, 1, 1, [0, 0, 0, 0]);
    writeModDir(dir, [{ path: 'graphics/images/a.png', image: img }]);
    const back = readModDir(dir).find(f => f.path === 'graphics/images/a.png')!;
    assert.deepEqual(Array.from(back.image!.data), Array.from(img.data));
  });
});

test('writeModDir refuses a file with neither bytes nor an image', () => {
  withTempDir(dir => {
    assert.throws(() => writeModDir(dir, [{ path: 'a.txt' }]), /neither bytes nor an image/);
  });
});
