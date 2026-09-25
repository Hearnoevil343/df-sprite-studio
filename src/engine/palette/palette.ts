// Locked palette: a fixed colour set per mod, plus the ramps (same hue and
// chroma, ordered by lightness) that rampStep and the light helper walk.

import type { Rgba, RgbaImage } from '../image/pixels.ts';
import { cloneImage, getPixel } from '../image/pixels.ts';
import { oklabDistSq, oklabToOklch, rgbToOklab } from './oklab.ts';

export type Palette = {
  colours: Rgba[];
  // Indices into `colours`, one array per ramp, ordered darkest to lightest.
  ramps: number[][];
};

const isTransparent = (c: Rgba): boolean => c[3] === 0;
const sameRgba = (a: Rgba, b: Rgba): boolean => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];

// Nearest palette colour to `rgb` by OKLab distance. A transparent pixel
// maps to the palette's transparent entry, if it has one, rather than being
// matched to whatever opaque colour happens to be closest in OKLab.
export function nearest(palette: Palette, rgb: Rgba): Rgba {
  if (isTransparent(rgb)) {
    const t = palette.colours.find(isTransparent);
    if (t) return t;
  }
  const target = rgbToOklab(rgb);
  let best: Rgba | null = null, bestD = Infinity;
  for (const c of palette.colours) {
    if (isTransparent(c)) continue;
    const d = oklabDistSq(rgbToOklab(c), target);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best ?? rgb;
}

export function snapToPalette(img: RgbaImage, palette: Palette): RgbaImage {
  const out = cloneImage(img);
  for (let i = 0; i < out.data.length; i += 4) {
    const c: Rgba = [out.data[i], out.data[i + 1], out.data[i + 2], out.data[i + 3]];
    const n = nearest(palette, c);
    out.data[i] = n[0]; out.data[i + 1] = n[1]; out.data[i + 2] = n[2]; out.data[i + 3] = n[3];
  }
  return out;
}

// Pixels whose colour is not an exact palette entry (e.g. after loading a
// reference PNG), for a UI to flag before the user snaps or paints over them.
export function offPalette(img: RgbaImage, palette: Palette): { x: number; y: number; colour: Rgba }[] {
  const result: { x: number; y: number; colour: Rgba }[] = [];
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const c = getPixel(img, x, y);
      if (!palette.colours.some(p => sameRgba(p, c))) result.push({ x, y, colour: c });
    }
  }
  return result;
}

const HUE_BUCKETS = 16;
const NEUTRAL_CHROMA = 0.02;

// Group opaque colours into ramps: one hue-independent group for near-grey
// colours (chroma below NEUTRAL_CHROMA, where hue angle is unstable anyway),
// then one group per hue bucket for the rest. A shade family's chroma
// commonly drifts with its lightness (a dark red is often less saturated
// than its bright version), so chroma only decides the near-grey cutoff, not
// a further split within a hue - that would tear a light/dark pair apart
// whenever it straddled a global chroma threshold. Each group is ordered
// darkest to lightest.
export function buildRamps(colours: Rgba[]): number[][] {
  const opaque = colours.map((c, i) => ({ i, c })).filter(({ c }) => !isTransparent(c));
  const lch = opaque.map(({ i, c }) => ({ i, ...oklabToOklch(rgbToOklab(c)) }));

  const groups = new Map<string, number[]>();
  for (const p of lch) {
    const key = p.C < NEUTRAL_CHROMA ? 'neutral' : `${Math.floor(p.H / (360 / HUE_BUCKETS))}`;
    const g = groups.get(key);
    if (g) g.push(p.i); else groups.set(key, [p.i]);
  }

  const byL = (i: number) => rgbToOklab(colours[i]).L;
  return [...groups.values()]
    .map(idxs => idxs.sort((a, b) => byL(a) - byL(b)))
    .sort((a, b) => a[0] - b[0]);
}

// One step lighter (+1) or darker (-1) along the ramp that contains `colour`.
// Returns `colour` unchanged if it isn't in the palette, isn't on any ramp,
// or is already at that end of its ramp.
export function rampStep(palette: Palette, colour: Rgba, dir: 1 | -1): Rgba {
  const idx = palette.colours.findIndex(c => sameRgba(c, colour));
  if (idx < 0) return colour;
  for (const ramp of palette.ramps) {
    const pos = ramp.indexOf(idx);
    if (pos < 0) continue;
    const next = ramp[pos + dir];
    return next === undefined ? colour : palette.colours[next];
  }
  return colour;
}
