// Drafts a CHILD, CORPSE, ANIMATED (zombie) or GHOST sprite from a drawn one
// (usually DEFAULT) for the modder to touch up. Every result is snapped to
// the palette and outlined, so drafts obey the palette lock like any other
// edit.
import { type Rgba, type RgbaImage, cloneImage, createImage, getPixel, setPixel } from '../image/pixels.ts';
import { bottomAlign } from '../image/align.ts';
import { downscale } from '../image/downscale.ts';
import { outline } from '../image/outline.ts';
import { rotate90 } from '../image/rotate.ts';
import type { Palette } from '../palette/palette.ts';
import { rampStep, snapToPalette } from '../palette/palette.ts';
import { oklabToOklch, oklabToRgb, oklchToOklab, rgbToOklab } from '../palette/oklab.ts';

export type DraftKind = 'child' | 'corpse' | 'animated' | 'ghost';

export type DraftOptions = {
  childRatio?: number;  // vanilla CHILD/DEFAULT box-height median
  footBaseline?: number;
};

// Fallbacks when vanilla-style.json hasn't been generated yet or has no
// figure for this token (see data/vanilla-stats.json "all" group).
export const DEFAULT_CHILD_RATIO = 0.75;
export const DEFAULT_FOOT_BASELINE = 28;

export function draftVariant(src: RgbaImage, kind: DraftKind, palette: Palette, opts: DraftOptions = {}): RgbaImage {
  const footBaseline = opts.footBaseline ?? DEFAULT_FOOT_BASELINE;
  const shaped = kind === 'child' ? draftChild(src, opts.childRatio ?? DEFAULT_CHILD_RATIO, footBaseline)
    : kind === 'corpse' ? draftCorpse(src, palette, footBaseline)
    : kind === 'animated' ? draftAnimated(src)
    : draftGhost(src, palette);
  const snapped = snapToPalette(shaped, palette);
  outline(snapped, palette, 'ramp');
  return snapped;
}

// Downscale by the box-height ratio, centred horizontally, same canvas size,
// dropped back onto the shared foot baseline.
function draftChild(src: RgbaImage, ratio: number, footBaseline: number): RgbaImage {
  const w = Math.max(1, Math.round(src.width * ratio));
  const h = Math.max(1, Math.round(src.height * ratio));
  const small = downscale(src, w, h);
  const canvas = createImage(src.width, src.height);
  const ox = Math.floor((src.width - w) / 2);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) setPixel(canvas, ox + x, y, getPixel(small, x, y));
  return bottomAlign(canvas, footBaseline);
}

// Rotated onto its side, downscaled back to the source's own footprint if the
// rotation swapped a multi-tile sprite's dimensions, dropped to the foot
// baseline, one ramp step darker.
function draftCorpse(src: RgbaImage, palette: Palette, footBaseline: number): RgbaImage {
  let img = rotate90(src, 1);
  if (img.width !== src.width || img.height !== src.height) img = downscale(img, src.width, src.height);
  img = bottomAlign(img, footBaseline);
  return darken(img, palette);
}

function darken(img: RgbaImage, palette: Palette): RgbaImage {
  const out = cloneImage(img);
  for (let i = 0; i < out.data.length; i += 4) {
    if (out.data[i + 3] === 0) continue;
    const c: Rgba = [out.data[i], out.data[i + 1], out.data[i + 2], out.data[i + 3]];
    const d = rampStep(palette, c, -1);
    out.data[i] = d[0]; out.data[i + 1] = d[1]; out.data[i + 2] = d[2]; out.data[i + 3] = d[3];
  }
  return out;
}

const ANIMATED_HUE = 140; // green-grey, degrees
const ANIMATED_CHROMA_SCALE = 0.4;
const ANIMATED_DARKEN = 0.08; // subtracted from OKLab L (0-1)

// Chroma cut, hue pulled halfway toward green-grey, one step darker. Left
// unsnapped: draftVariant's common snap-and-outline pass is the "then
// snapped" step.
function draftAnimated(src: RgbaImage): RgbaImage {
  const out = cloneImage(src);
  const targetRad = (ANIMATED_HUE * Math.PI) / 180;
  for (let i = 0; i < out.data.length; i += 4) {
    if (out.data[i + 3] === 0) continue;
    const c: Rgba = [out.data[i], out.data[i + 1], out.data[i + 2], out.data[i + 3]];
    const { L, C, H } = oklabToOklch(rgbToOklab(c));
    const hueRad = (H * Math.PI) / 180;
    const mixRad = Math.atan2(Math.sin(hueRad) + Math.sin(targetRad), Math.cos(hueRad) + Math.cos(targetRad));
    const lab = oklchToOklab({ L: Math.max(0, L - ANIMATED_DARKEN), C: C * ANIMATED_CHROMA_SCALE, H: (mixRad * 180) / Math.PI });
    const [r, g, b] = oklabToRgb(lab);
    out.data[i] = r; out.data[i + 1] = g; out.data[i + 2] = b;
  }
  return out;
}

const GHOST_HUE_MIN = 180, GHOST_HUE_MAX = 300; // blue/cyan/purple family counts as "cool"

// The palette's ramp that reads as cool (falls back to every ramp if none
// do) and is palest among those, i.e. highest average lightness.
function coolestRamp(palette: Palette): number[] {
  const info = palette.ramps.filter(r => r.length).map(ramp => {
    const lchs = ramp.map(i => oklabToOklch(rgbToOklab(palette.colours[i])));
    const avgL = lchs.reduce((s, c) => s + c.L, 0) / lchs.length;
    const avgH = lchs.reduce((s, c) => s + c.H, 0) / lchs.length;
    return { ramp, avgL, avgH };
  });
  const cool = info.filter(r => r.avgH >= GHOST_HUE_MIN && r.avgH <= GHOST_HUE_MAX);
  const pool = cool.length ? cool : info;
  return pool.length ? pool.reduce((best, r) => (r.avgL > best.avgL ? r : best)).ramp : [];
}

// Every opaque pixel remapped, by its own lightness, onto the palest cool
// ramp - the GHOST token is unverified in game (see simple-creature.json).
function draftGhost(src: RgbaImage, palette: Palette): RgbaImage {
  const ramp = coolestRamp(palette);
  const out = cloneImage(src);
  if (!ramp.length) return out;
  const rampLs = ramp.map(i => rgbToOklab(palette.colours[i]).L);
  for (let i = 0; i < out.data.length; i += 4) {
    if (out.data[i + 3] === 0) continue;
    const c: Rgba = [out.data[i], out.data[i + 1], out.data[i + 2], out.data[i + 3]];
    const L = rgbToOklab(c).L;
    let best = 0, bestD = Infinity;
    for (let r = 0; r < rampLs.length; r++) { const d = Math.abs(rampLs[r] - L); if (d < bestD) { bestD = d; best = r; } }
    const p = palette.colours[ramp[best]];
    out.data[i] = p[0]; out.data[i + 1] = p[1]; out.data[i + 2] = p[2]; out.data[i + 3] = p[3];
  }
  return out;
}
