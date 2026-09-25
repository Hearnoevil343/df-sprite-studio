// Vanilla sheet statistics: master palette and average proportions of every
// single-tile 32x32 creature sprite that a vanilla graphics raw points at.
// Usage: node tools/vanilla-stats.ts [--df <path>] [--out data/vanilla-stats.json]
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  RawDocument, buildRamps, crop, kmeansOklab, oklabDistSq, oklabToRgb, paletteCounts, rgbToOklab, spriteProportions,
  styleMetrics, tileGraphicsRects,
} from '../src/engine/index.ts';
import type {
  Box, FloorBand, Oklab, Palette, Rgba, RgbaImage, SpriteProportions, StyleBand, StyleTokenBands, VanillaStyle,
} from '../src/engine/index.ts';
import { dfDir } from './df-dir.ts';
import { decodePng } from './png.ts';

const argv = process.argv.slice(2);
const vanilla = join(dfDir(argv), 'data', 'vanilla');
const oi = argv.indexOf('--out');
const out = oi >= 0 ? argv[oi + 1] : join('data', 'vanilla-stats.json');
const paletteOutIdx = argv.indexOf('--palette-out');
const paletteOut = paletteOutIdx >= 0 ? argv[paletteOutIdx + 1] : join('data', 'vanilla-palette.json');
const kIdx = argv.indexOf('--k');
const K = kIdx >= 0 ? +argv[kIdx + 1] : 64;
const seedIdx = argv.indexOf('--seed');
const SEED = seedIdx >= 0 ? +argv[seedIdx + 1] : 1;
const STYLE = argv.includes('--style');
const styleOutIdx = argv.indexOf('--style-out');
const styleOut = styleOutIdx >= 0 ? argv[styleOutIdx + 1] : join('data', 'vanilla-style.json');
const TOKENS = new Set(['DEFAULT', 'CHILD', 'ANIMATED', 'CORPSE', 'VERMIN']);
const TILE = 32;

// Packed-colour (0xRRGGBB) -> RGBA. Needed by the floor-colour loading below
// as well as the k-means palette code further down.
const unpack = (k: number): Rgba => [(k >> 16) & 255, (k >> 8) & 255, k & 255, 255];

const raws = (readdirSync(vanilla, { recursive: true }) as string[])
  .filter(f => f.endsWith('.txt') && /[\\/]graphics[\\/]/.test(f)).map(f => join(vanilla, f)).sort();

// Tile pages, then the sprites that creature blocks reference.
const pages = new Map<string, { png: string; tile: [number, number] }>();
const docs = raws.map(p => ({ dir: dirname(p), doc: RawDocument.fromBytes(new Uint8Array(readFileSync(p))) }));
for (const { dir, doc } of docs)
  for (const tp of doc.tilePages())
    if (tp.file && tp.tileDim) pages.set(tp.id, { png: join(dir, tp.file), tile: tp.tileDim });

type Sprite = { token: string; page: string; x: number; y: number };
const sprites = new Map<string, Sprite>();
for (const { doc } of docs) {
  for (const cg of doc.creatureGraphics()) {
    if (cg.isStatue) continue;
    for (const e of cg.entries) {
      const [token, page, xs, ys] = e.args;
      if (!TOKENS.has(token) || xs === 'LARGE_IMAGE' || !/^\d+$/.test(xs ?? '') || !/^\d+$/.test(ys ?? '')) continue;
      const pg = pages.get(page);
      if (!pg || pg.tile[0] !== TILE || pg.tile[1] !== TILE) continue;
      sprites.set(`${token}:${page}:${xs}:${ys}`, { token, page, x: +xs, y: +ys });
    }
  }
}

// Measure, one sheet in memory at a time.
const byPage = new Map<string, Sprite[]>();
for (const s of sprites.values()) byPage.set(s.page, [...(byPage.get(s.page) ?? []), s]);
const palette = new Map<number, number>();
const measured: (SpriteProportions & { token: string; page: string })[] = [];
const sheetInfo: Record<string, { sprites: number; empty: number; colours: number }> = {};
type StyleSample = { token: string; colourCount: number; outlineLightShare: number; footBaseline: number | null; edgeColours: Rgba[] };
const styleSamples: StyleSample[] = [];
for (const [page, list] of [...byPage].sort()) {
  const img: RgbaImage = decodePng(new Uint8Array(readFileSync(pages.get(page)!.png)));
  const own = new Map<number, number>();
  let empty = 0;
  for (const s of list) {
    const rect = { x: s.x * TILE, y: s.y * TILE, w: TILE, h: TILE };
    if (rect.x + TILE > img.width || rect.y + TILE > img.height) { empty++; continue; }
    const p = spriteProportions(img, rect);
    if (!p) { empty++; continue; }
    measured.push({ ...p, token: s.token, page });
    paletteCounts(img, rect, own);
    if (STYLE) {
      const sm = styleMetrics(crop(img, rect));
      if (!sm.blank) {
        styleSamples.push({
          token: s.token, colourCount: sm.colourCount, outlineLightShare: sm.outlineLightShare,
          footBaseline: sm.footBaseline, edgeColours: sm.edges.map(e => e.colour),
        });
      }
    }
  }
  for (const [k, n] of own) palette.set(k, (palette.get(k) ?? 0) + n);
  sheetInfo[page] = { sprites: list.length, empty, colours: own.size };
}

const r1 = (v: number) => Math.round(v * 10) / 10;
function avgBox(boxes: Box[]) {
  const n = boxes.length || 1, s = (k: keyof Box) => r1(boxes.reduce((a, b) => a + b[k], 0) / n);
  return { x: s('x'), y: s('y'), w: s('w'), h: s('h') };
}
// Linear-interpolated percentile (0-1) of a value list, rounded like avgBox.
function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? r1(s[lo]) : r1(s[lo] + (s[hi] - s[lo]) * (idx - lo));
}
function band(values: number[]): [number, number] { return [percentile(values, 0.1), percentile(values, 0.9)]; }
function summary(list: typeof measured) {
  const heads = list.filter(p => p.head);
  const sides: Record<string, number> = {};
  for (const p of heads) sides[p.headSide!] = (sides[p.headSide!] ?? 0) + 1;
  return {
    sprites: list.length,
    bbox: avgBox(list.map(p => p.bbox)),
    footBaseline: r1(list.reduce((a, p) => a + p.footBaseline, 0) / (list.length || 1)),
    headFound: r1(heads.length / (list.length || 1)),
    headSide: sides,
    // Split by side: a top head and a side-on head average to nonsense.
    bySide: Object.fromEntries(Object.keys(sides).sort().map(side => {
      const h = heads.filter(p => p.headSide === side);
      return [side, { head: avgBox(h.map(p => p.head!)), body: avgBox(h.map(p => p.body)) }];
    })),
    // 10th/90th percentile of each box edge and the baseline, so the guide
    // can draw a band instead of one line.
    band: {
      x0: band(list.map(p => p.bbox.x)),
      y0: band(list.map(p => p.bbox.y)),
      x1: band(list.map(p => p.bbox.x + p.bbox.w)),
      y1: band(list.map(p => p.bbox.y + p.bbox.h)),
      footBaseline: band(list.map(p => p.footBaseline)),
    },
  };
}
const groups = (key: 'token' | 'page' | 'pageToken') => {
  const keyOf = key === 'pageToken' ? (p: typeof measured[number]) => `${p.page}|${p.token}` : (p: typeof measured[number]) => p[key];
  const m: Record<string, ReturnType<typeof summary>> = {};
  for (const k of [...new Set(measured.map(keyOf))].sort()) m[k] = summary(measured.filter(p => keyOf(p) === k));
  return m;
};
const hex = (k: number) => '#' + k.toString(16).padStart(6, '0');
const total = [...palette.values()].reduce((a, b) => a + b, 0);
const ranked = [...palette].sort((a, b) => b[1] - a[1]);

const result = {
  note: 'Generated by tools/vanilla-stats.ts. Boxes are pixels inside a 32x32 tile, top-left origin. '
    + 'Opaque means alpha >= 128. Head and body come from a neck heuristic (engine/stats/sheet-stats.ts); '
    + 'bySide head and body averages cover only sprites where a head was found on that side.',
  tile: TILE,
  sheets: sheetInfo,
  proportions: { all: summary(measured), byToken: groups('token'), byPage: groups('page'), byPageToken: groups('pageToken') },
  palette: {
    uniqueColours: palette.size,
    opaquePixels: total,
    top256Coverage: r1(100 * ranked.slice(0, 256).reduce((a, [, n]) => a + n, 0) / total),
    top: ranked.slice(0, 256).map(([k, n]) => ({ colour: hex(k), pixels: n })),
  },
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(result, null, 1) + '\n');
const a = result.proportions.all;
console.log(`${measured.length} sprites from ${byPage.size} sheets (${Object.values(sheetInfo).reduce((s, i) => s + i.empty, 0)} empty or off-sheet)`);
console.log(`bbox ${JSON.stringify(a.bbox)}, foot ${a.footBaseline}, head found ${a.headFound}`);
console.log(`palette: ${palette.size} colours, top 256 cover ${result.palette.top256Coverage}% of pixels`);
console.log(`written to ${out}`);

// --- Style bands (data/vanilla-style.json) -------------------------------
// 2nd/98th percentile, distinct from proportions' 10th/90th `band()`, so the
// two stats files' meanings don't quietly drift. Was 5th/95th; widened after
// measuring that stacking 5 independently-~5%-tailed rules made ~20% of
// genuine vanilla sprites trip at least one rule (see logs/ for the measurement).
function stylePercentileBand(values: number[]): StyleBand { return [percentile(values, 0.02), percentile(values, 0.98)]; }
function styleTokenBands(list: StyleSample[]): StyleTokenBands {
  return {
    sprites: list.length,
    colourCount: stylePercentileBand(list.map(s => s.colourCount)),
    outlineLightShare: stylePercentileBand(list.map(s => s.outlineLightShare)),
    footBaseline: stylePercentileBand(list.map(s => s.footBaseline).filter((v): v is number => v != null)),
  };
}

if (STYLE) {
  const byToken: Record<string, StyleTokenBands> = {};
  for (const token of [...TOKENS].sort()) byToken[token] = styleTokenBands(styleSamples.filter(s => s.token === token));
  byToken.ALL = styleTokenBands(styleSamples);

  const FLOOR_DEFS = [
    { id: 'grass', label: 'Grass', tileName: 'GRASS_1' },
    { id: 'stone', label: 'Stone', tileName: 'STONE_FLOOR_1' },
  ];
  const floors: FloorBand[] = [];
  const floorPage = pages.get('FLOORS');
  if (floorPage) {
    const floorImg = decodePng(new Uint8Array(readFileSync(floorPage.png)));
    const floorRects = docs.flatMap(({ doc }) => tileGraphicsRects(doc, 'FLOORS', floorPage.tile));
    for (const def of FLOOR_DEFS) {
      const found = floorRects.find(r => r.name === def.tileName);
      if (!found) continue;
      const floorTile = crop(floorImg, found.rect);
      const own = new Map<number, number>();
      paletteCounts(floorTile, { x: 0, y: 0, w: floorTile.width, h: floorTile.height }, own);
      const colours = [...own.keys()].map(unpack);
      const floorLabs = colours.map(rgbToOklab);
      const perSampleDists = styleSamples.map(s => s.edgeColours.map(c => Math.sqrt(Math.min(...floorLabs.map(f => oklabDistSq(f, rgbToOklab(c)))))));
      const distanceThreshold = percentile(perSampleDists.flat(), 0.05);
      const shares = perSampleDists.filter(d => d.length).map(d => d.filter(v => v <= distanceThreshold).length / d.length);
      floors.push({ id: def.id, label: def.label, colours, distanceThreshold, closeShare: stylePercentileBand(shares) });
    }
  }

  const styleResult: VanillaStyle = { byToken, floors };
  mkdirSync(dirname(styleOut), { recursive: true });
  writeFileSync(styleOut, JSON.stringify(styleResult, null, 1) + '\n');
  console.log(`style: ${styleSamples.length} sprites measured, ${floors.length} floor(s), written to ${styleOut}`);
}

// --- Clustered locked palette (data/vanilla-palette.json) ---------------
// Weighted k-means in OKLab over the full histogram (not just the top 256),
// weights = pixel counts. kmeansOklab (src/engine/palette/kmeans.ts) is
// shared with the palette-align DF-look pass.

// Mean OKLab distance from every histogram colour to its nearest palette
// colour, weighted by pixel count across every measured vanilla sprite.
function meanSnapError(hist: Map<number, number>, colours: Rgba[]): number {
  const labs = colours.map(rgbToOklab);
  let sumW = 0, sumErr = 0;
  for (const [k, w] of hist) {
    const p = rgbToOklab(unpack(k));
    const bestD = Math.min(...labs.map(l => oklabDistSq(p, l)));
    sumErr += w * Math.sqrt(bestD);
    sumW += w;
  }
  return sumW ? sumErr / sumW : 0;
}

const histPoints = [...palette].map(([k, w]) => ({ ...rgbToOklab(unpack(k)), w }));
const centroids = kmeansOklab(histPoints, Math.min(K, histPoints.length), SEED);
const clustered = centroids.map(c => oklabToRgb(c));
const seen = new Set<string>();
const paletteColours: Rgba[] = [[0, 0, 0, 0]]; // transparent, index 0
for (const [r, g, b] of clustered) {
  const key = `${r},${g},${b}`;
  if (seen.has(key)) continue;
  seen.add(key);
  paletteColours.push([r, g, b, 255]);
}
const vanillaPalette: Palette = { colours: paletteColours, ramps: buildRamps(paletteColours) };
const snapError = meanSnapError(palette, paletteColours);
mkdirSync(dirname(paletteOut), { recursive: true });
writeFileSync(paletteOut, JSON.stringify(vanillaPalette, null, 1) + '\n');
console.log(`palette: k=${K} requested, ${paletteColours.length - 1} distinct colours after clustering, `
  + `${vanillaPalette.ramps.length} ramps, mean OKLab snap error ${snapError.toFixed(4)}`);
console.log(`written to ${paletteOut}`);
