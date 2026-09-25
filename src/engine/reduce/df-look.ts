// DF-look finishing passes for hand-driven sprite cleanup. Each is pure,
// non-destructive (returns a new image) and independently toggleable — a
// person runs whichever subset looks right through tools/studio.ts, not a
// fixed pipeline.
import { type Rgba, type RgbaImage, cloneImage, createImage, getPixel, inBounds, samePixel, setPixel } from '../image/index.ts';
import { kmeansOklab, nearest, oklabToOklch, oklabToRgb, oklchToOklab, rampStep, rgbToOklab } from '../palette/index.ts';
import type { Palette } from '../palette/palette.ts';

const CLEAR: Rgba = [0, 0, 0, 0];

// Pass 1: flatten each `cell`x`cell` block to its OKLab mean, downscaling the
// image by exactly `cell` (ceil on a non-exact remainder, so no edge pixels
// are dropped). Not a modal vote (compare image/downscale.ts, which picks
// the cell's most common colour): the in-cell variation in generated output
// is a gradient, not a handful of competing flat colours, so the mean is
// what the cell means. A block reads as background only when fewer than
// half its pixels are opaque.
export function snapToGrid(img: RgbaImage, cell: number): RgbaImage {
  if (!Number.isInteger(cell) || cell < 1) throw new Error(`snapToGrid: cell must be a positive integer, got ${cell}`);
  const outW = Math.ceil(img.width / cell);
  const outH = Math.ceil(img.height / cell);
  const out = createImage(outW, outH);
  for (let by = 0; by < outH; by++) {
    for (let bx = 0; bx < outW; bx++) {
      const x0 = bx * cell, y0 = by * cell;
      const x1 = Math.min(img.width, x0 + cell), y1 = Math.min(img.height, y0 + cell);
      let sumL = 0, sumA = 0, sumB = 0, opaque = 0, total = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          total++;
          const c = getPixel(img, x, y);
          if (c[3] === 0) continue;
          const lab = rgbToOklab(c);
          sumL += lab.L; sumA += lab.a; sumB += lab.b; opaque++;
        }
      }
      if (total === 0 || opaque * 2 < total) { setPixel(out, bx, by, CLEAR); continue; }
      const [r, g, b] = oklabToRgb({ L: sumL / opaque, a: sumA / opaque, b: sumB / opaque });
      setPixel(out, bx, by, [r, g, b, 255]);
    }
  }
  return out;
}

// Pass 2: cluster the image's own opaque colours in OKLab with weighted
// k-means (k-means++ seeded, see palette/kmeans.ts), then snap each cluster
// centroid to the nearest vanilla palette colour and repaint every pixel in
// that cluster with the snapped colour. Seeding is load-bearing: lightness-
// sorted seeding turned a dwarf's beard, skin and shirt into grey mud in
// testing; k-means++ recovered them (353 colours -> 13 in that run).
// Default k=16: compared against `quantize`'s own default k=24 on the same
// tuning sample — paletteAlign snaps to vanilla's real 65-colour palette, so a
// lower k still reads as flat, DF-like colour blocks, while quantize at the
// same or higher k keeps the generator's own muted/off-palette blends and
// reads muddier by eye.
// snapToVanilla: when true, each cluster centroid is snapped to the
// nearest vanilla palette colour. This is exactly what mutes colour on
// generated input: vanilla's 65-colour palette has no near neighbour for a
// muted/saturated generated hue, so snapping pulls every cluster toward
// whichever vanilla colour is closest, greying/flattening real colour range.
// Pass false to keep each cluster's own OKLab centroid instead (still
// clustered/denoised, edges and outline unaffected) -- clean blocks of the
// image's OWN colour rather than vanilla's.
// snapToVanilla defaults to false: keeps edges/outline clean while colour
// stays close to the input rather than pulled toward vanilla's 65-colour
// palette. Pass `true` to restore the old snap-to-vanilla behaviour.
export type PaletteAlignOptions = { k?: number; seed?: number; snapToVanilla?: boolean };
export function paletteAlign(img: RgbaImage, palette: Palette, opts: PaletteAlignOptions = {}): RgbaImage {
  const k = opts.k ?? 16;
  const snapToVanilla = opts.snapToVanilla ?? false;
  const counts = new Map<string, { c: Rgba; w: number }>();
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const c = getPixel(img, x, y);
      if (c[3] === 0) continue;
      const key = c.join(',');
      const e = counts.get(key);
      if (e) e.w++; else counts.set(key, { c, w: 1 });
    }
  }
  const entries = [...counts.values()];
  if (!entries.length) return cloneImage(img);

  const points = entries.map(({ c, w }) => ({ ...rgbToOklab(c), w }));
  const kClamped = Math.min(k, points.length);
  const centroids = kmeansOklab(points, kClamped, opts.seed ?? 1);
  const snapped = centroids.map(c => snapToVanilla ? nearest(palette, [...oklabToRgb(c), 255] as Rgba) : ([...oklabToRgb(c), 255] as Rgba));

  const remap = new Map<string, Rgba>();
  for (const { c } of entries) {
    const lab = rgbToOklab(c);
    let best = 0, bestD = Infinity;
    for (let i = 0; i < centroids.length; i++) {
      const d = (lab.L - centroids[i].L) ** 2 + (lab.a - centroids[i].a) ** 2 + (lab.b - centroids[i].b) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    remap.set(c.join(','), snapped[best]);
  }

  const out = cloneImage(img);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const c = getPixel(img, x, y);
      if (c[3] === 0) continue;
      setPixel(out, x, y, remap.get(c.join(','))!);
    }
  }
  return out;
}

// Pass 3: cell-averaging (snapToGrid, or any resampling downscale) pulls
// every pixel toward its neighbourhood mean, which reads muddy next to
// vanilla's flat, saturated blocks. Pushes each opaque pixel's OKLab
// lightness away from the image's mean lightness and scales up its OKLCH
// chroma, both clamped to sane ranges.
export type ContrastLiftOptions = { lightness?: number; chroma?: number };
export function contrastLift(img: RgbaImage, opts: ContrastLiftOptions = {}): RgbaImage {
  const lightnessGain = opts.lightness ?? 1.3;
  const chromaGain = opts.chroma ?? 1.3;
  let sumL = 0, n = 0;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const c = getPixel(img, x, y);
      if (c[3] === 0) continue;
      sumL += rgbToOklab(c).L; n++;
    }
  }
  if (!n) return cloneImage(img);
  const meanL = sumL / n;

  const out = cloneImage(img);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const c = getPixel(img, x, y);
      if (c[3] === 0) continue;
      const lab = rgbToOklab(c);
      const newL = Math.min(1, Math.max(0, meanL + (lab.L - meanL) * lightnessGain));
      const lch = oklabToOklch(lab);
      const newC = Math.min(0.4, Math.max(0, lch.C * chromaGain));
      const [r, g, b] = oklabToRgb(oklchToOklab({ L: newL, C: newC, H: lch.H }));
      setPixel(out, x, y, [r, g, b, c[3]]);
    }
  }
  return out;
}

// Pass 4: a pixel that agrees with none of its four orthogonal neighbours is
// noise, not detail; replace it with the neighbours' majority colour (>= 2 of
// 4). Border pixels (missing a neighbour) are left alone, as is any pixel
// with no clear majority — this pass only ever removes lone speckles, never
// redraws a real edge.
export function despeckle(img: RgbaImage): RgbaImage {
  const out = cloneImage(img);
  for (let y = 1; y < img.height - 1; y++) {
    for (let x = 1; x < img.width - 1; x++) {
      const c = getPixel(img, x, y);
      const neighbours = [getPixel(img, x - 1, y), getPixel(img, x + 1, y), getPixel(img, x, y - 1), getPixel(img, x, y + 1)];
      if (neighbours.some(n => samePixel(n, c))) continue;

      const counts = new Map<string, { c: Rgba; n: number }>();
      for (const n of neighbours) {
        const key = n.join(',');
        const e = counts.get(key);
        if (e) e.n++; else counts.set(key, { c: n, n: 1 });
      }
      let best: Rgba | null = null, bestN = 0;
      for (const e of counts.values()) if (e.n > bestN) { bestN = e.n; best = e.c; }
      if (bestN >= 2) setPixel(out, x, y, best!);
    }
  }
  return out;
}

// Pass 5: darken every opaque pixel that touches background (silhouette
// edge) by one palette ramp step — same hue, one shade darker, per
// palette/palette.ts's rampStep. NOT a fixed dark/black stamp: at small
// sizes (18x31) thin limbs make most pixels edge pixels, and a black stamp
// eats the whole silhouette. rampStep is a safe no-op for a colour that
// isn't on any ramp or is already its ramp's darkest, so repeated or
// out-of-order use never grinds a sprite to black.
const NEIGHBOURS = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const;
export function repairOutline(img: RgbaImage, palette: Palette): RgbaImage {
  const out = cloneImage(img);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const c = getPixel(img, x, y);
      if (c[3] === 0) continue;
      const isEdge = NEIGHBOURS.some(([dx, dy]) => {
        const nx = x + dx, ny = y + dy;
        return !inBounds(img, nx, ny) || getPixel(img, nx, ny)[3] === 0;
      });
      if (!isEdge) continue;
      setPixel(out, x, y, rampStep(palette, c, -1));
    }
  }
  return out;
}

// Pass 6: remove the generator's background colour cast. v2 renders every
// subject on a magenta canvas, and that magenta bleeds into the subject: not
// just as an anti-aliased rim (only ~1.8% of opaque pixels, and raising
// removeBackground's tolerance enough to clear it eats the subject itself)
// but as a whole-image tint, so near-neutral cloth carries a faint magenta
// lean. Left alone it is invisible; after contrastLift's chroma gain it
// erupts into lavender across flat areas. Scales chroma down for hues within
// `span` degrees of `castHue`, hardest at the cast hue itself and fading to
// nothing at the edge of the span, leaving every other hue untouched.
export const DEFAULT_CAST_HUE = 317;   // OKLCH hue of the v2 magenta canvas
export type DeCastOptions = { castHue?: number; span?: number; strength?: number };
export function deCast(img: RgbaImage, opts: DeCastOptions = {}): RgbaImage {
  const castHue = opts.castHue ?? DEFAULT_CAST_HUE;
  const span = opts.span ?? 55;
  const strength = opts.strength ?? 1;
  const out = cloneImage(img);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const c = getPixel(img, x, y);
      if (c[3] === 0) continue;
      const lch = oklabToOklch(rgbToOklab(c));
      const apart = Math.abs((((lch.H - castHue + 180) % 360) + 360) % 360 - 180);
      if (apart > span) continue;
      const k = 1 - apart / span;
      const [r, g, b] = oklabToRgb(oklchToOklab({ L: lch.L, C: lch.C * (1 - strength * k), H: lch.H }));
      setPixel(out, x, y, [r, g, b, c[3]]);
    }
  }
  return out;
}

// Pass 7: stretch lightness so the sprite spans the full usable range.
// Generated output sits in a narrow, dark band (the canvas vignette pulls the
// whole subject down), which reads flat and muddy beside vanilla art drawn
// across the full range. Linear on OKLab L, hue and chroma untouched.
export type LevelsOptions = { low?: number; high?: number };
export function levels(img: RgbaImage, opts: LevelsOptions = {}): RgbaImage {
  const low = opts.low ?? 0.12;
  const high = opts.high ?? 0.95;
  let min = Infinity, max = -Infinity;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const c = getPixel(img, x, y);
      if (c[3] === 0) continue;
      const L = rgbToOklab(c).L;
      if (L < min) min = L;
      if (L > max) max = L;
    }
  }
  if (!Number.isFinite(min) || max - min < 1e-6) return cloneImage(img);

  const out = cloneImage(img);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const c = getPixel(img, x, y);
      if (c[3] === 0) continue;
      const lch = oklabToOklch(rgbToOklab(c));
      const L = low + ((lch.L - min) / (max - min)) * (high - low);
      const [r, g, b] = oklabToRgb(oklchToOklab({ L, C: lch.C, H: lch.H }));
      setPixel(out, x, y, [r, g, b, c[3]]);
    }
  }
  return out;
}

// Pass 8: cut the colour count by clustering the image's own colours and
// keeping the cluster centroids, WITHOUT snapping to the vanilla palette.
// paletteAlign (pass 2) snaps to vanilla's 65 colours under a plain OKLab
// distance, and on generated output that collapses skin, beard and cloth
// into grey mud — vanilla's spread simply has no near neighbour for a muted
// generated hue, so the nearest entry is whatever grey is closest in
// lightness. Quantizing to the sprite's own centroids keeps every hue and
// still lands in vanilla's range (a vanilla dwarf uses 42 colours at 19x32;
// k = 24 here). Use paletteAlign instead when the output must be strictly
// on-palette and the hue loss is acceptable.
export type QuantizeOptions = { k: number; seed?: number };
export function quantize(img: RgbaImage, opts: QuantizeOptions): RgbaImage {
  const counts = new Map<string, { c: Rgba; w: number }>();
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const c = getPixel(img, x, y);
      if (c[3] === 0) continue;
      const key = c.join(',');
      const e = counts.get(key);
      if (e) e.w++; else counts.set(key, { c, w: 1 });
    }
  }
  const entries = [...counts.values()];
  if (!entries.length) return cloneImage(img);

  const points = entries.map(({ c, w }) => ({ ...rgbToOklab(c), w }));
  const centroids = kmeansOklab(points, Math.min(opts.k, points.length), opts.seed ?? 1);
  const colours = centroids.map(c => { const [r, g, b] = oklabToRgb(c); return [r, g, b, 255] as Rgba; });

  const remap = new Map<string, Rgba>();
  for (const { c } of entries) {
    const lab = rgbToOklab(c);
    let best = 0, bestD = Infinity;
    for (let i = 0; i < centroids.length; i++) {
      const d = (lab.L - centroids[i].L) ** 2 + (lab.a - centroids[i].a) ** 2 + (lab.b - centroids[i].b) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    remap.set(c.join(','), colours[best]);
  }

  const out = cloneImage(img);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const c = getPixel(img, x, y);
      if (c[3] === 0) continue;
      setPixel(out, x, y, remap.get(c.join(','))!);
    }
  }
  return out;
}
