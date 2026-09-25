// Scene preview: the open sprite composited over a real vanilla floor
// tile, at true 1x, so it can be checked by eye against an actual DF floor.
// Only grass and stone are backed by vanilla art (graphics_tiles.txt has no
// snow or cavern floor — snow is a spatter overlay, caverns just tint stone
// in-engine), and per project rule, no reference means no preview for now.
import { compose, crop, tileGraphicsRects } from '../../engine/index.ts';
import type { RgbaImage } from '../../engine/index.ts';
import { decodeImageFile } from '../io/browser-png.ts';
import type { VanillaScan } from '../io/vanilla-scan.ts';
import type { Store } from '../state/store.ts';

const FLOOR_PAGE = 'FLOORS';
const FLOORS = [
  { id: 'grass', label: 'Grass', tileName: 'GRASS_1' },
  { id: 'stone', label: 'Stone', tileName: 'STONE_FLOOR_1' },
] as const;
type FloorId = (typeof FLOORS)[number]['id'];

const BUILTIN_TILE_SIZE = 32;

// A generic placeholder floor: drawn whenever no real
// vanilla floor tile is available, so the preview always shows an image
// instead of a blank canvas. A plain two-tone checker reads as "placeholder"
// rather than as real DF art.
function builtinFloorTile(): RgbaImage {
  const size = BUILTIN_TILE_SIZE;
  const img: RgbaImage = { width: size, height: size, data: new Uint8ClampedArray(size * size * 4) };
  const half = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dark = (x < half) === (y < half);
      const i = (y * size + x) * 4;
      const v = dark ? 58 : 70;
      img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = 255;
    }
  }
  return img;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props);
}

function findFloorTile(scan: VanillaScan, tileName: string): { pngPath: string; rect: { x: number; y: number; w: number; h: number } } | null {
  const page = scan.pages.get(FLOOR_PAGE);
  if (!page) return null;
  for (const { doc } of scan.docs) {
    const found = tileGraphicsRects(doc, FLOOR_PAGE, page.tile).find(r => r.name === tileName);
    if (found) return { pngPath: page.pngPath, rect: found.rect };
  }
  return null;
}

function drawComposite(canvas: HTMLCanvasElement, img: RgbaImage): void {
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
}

export function createScenePreviewPanel(store: Store, container: HTMLElement): { render: () => void; fitZoom: () => void } {
  let scannedFor: VanillaScan | null = null;
  const floorCache = new Map<string, Promise<RgbaImage | null>>();
  let floor: FloorId = 'grass';

  const status = el('div', { className: 'scene-status', textContent: 'No DF folder connected.' });
  const floorSelect = el('select');
  for (const f of FLOORS) floorSelect.appendChild(el('option', { value: f.id, textContent: f.label }));
  const canvas = el('canvas', { className: 'scene-canvas' });

  // The composite draws at native pixel size (a 32x32 sprite is a tiny
  // patch in a much larger panel), so scale it up by the largest integer
  // zoom that fits the panel, same idea as the main and reference canvases.
  function fitZoom(): void {
    const parent = canvas.parentElement;
    if (!parent || !canvas.width || !canvas.height) return;
    const availW = parent.clientWidth;
    const availH = parent.clientHeight;
    if (!availW || !availH) return;
    const zoom = Math.max(1, Math.floor(Math.min(availW / canvas.width, availH / canvas.height)));
    canvas.style.width = `${canvas.width * zoom}px`;
    canvas.style.height = `${canvas.height * zoom}px`;
  }

  function floorTile(scan: VanillaScan, tileName: string): Promise<RgbaImage | null> {
    let p = floorCache.get(tileName);
    if (!p) {
      p = (async () => {
        const found = findFloorTile(scan, tileName);
        if (!found) return null;
        const handle = scan.pngHandles.get(found.pngPath);
        if (!handle) return null;
        const page = await decodeImageFile(handle);
        return crop(page, found.rect);
      })();
      floorCache.set(tileName, p);
    }
    return p;
  }

  floorSelect.addEventListener('change', () => { floor = floorSelect.value as FloorId; render(); });

  async function render(): Promise<void> {
    const { project, ui } = store.get();
    if (ui.vanillaScan !== scannedFor) { scannedFor = ui.vanillaScan; floorCache.clear(); }
    const sprite = project.sprite;
    const tileName = FLOORS.find(f => f.id === floor)!.tileName;
    const realTile = ui.vanillaScan ? await floorTile(ui.vanillaScan, tileName) : null;
    const tile = realTile ?? builtinFloorTile();
    status.textContent = realTile
      ? 'How Dwarf Fortress will draw this, over a real vanilla floor tile.'
      : 'No DF folder connected -- showing a placeholder floor instead of the real vanilla tile.';
    const cols = Math.ceil(sprite.width / tile.width);
    const rows = Math.ceil(sprite.height / tile.height);
    const layers = [];
    for (let ty = 0; ty < rows; ty++)
      for (let tx = 0; tx < cols; tx++)
        layers.push({ img: tile, x: tx * tile.width, y: ty * tile.height });
    layers.push({ img: sprite, x: 0, y: 0 });
    drawComposite(canvas, compose(sprite.width, sprite.height, layers));
    fitZoom();
  }

  container.innerHTML = '';
  container.append(status, el('label', { textContent: 'Floor' }), floorSelect, canvas);
  if ('ResizeObserver' in window) new ResizeObserver(fitZoom).observe(container);

  store.subscribe(() => { render(); });
  render();
  return { render: () => { render(); }, fitZoom };
}
