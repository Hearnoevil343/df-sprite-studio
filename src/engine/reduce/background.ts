// Background removal and crop-to-subject for the LoRA-output reducer.
import { type RgbaImage, cloneImage, crop, getPixel, setPixel } from '../image/index.ts';
import { type Oklab, oklabDistSq, rgbToOklab } from '../palette/index.ts';
import { OPAQUE } from '../stats/sheet-stats.ts';
import type { Issue } from '../check/issue.ts';

// OKLab distance (not squared) under which a pixel counts as background.
// 0.08 was picked against solid-background test images and was too tight for
// a real dfsprite_clean_v2 canvas: its "magenta" background is a vignette
// (corner and mid-edge OKLab differ), so 0.08 cleared only 10.8% of the frame
// and cropToSubject cropped nothing. 0.15 clears 97.8% and finds the real
// subject.
export const DEFAULT_TOLERANCE = 0.15;

// Fraction of border pixels that must read as background before the stage
// runs at all; below this the source likely has no flat background to strip.
const MIN_BORDER_MATCH = 0.05;

// Fraction of the whole frame that must end up cleared for the stage to call
// itself done; a generator canvas is mostly background, so clearing far less
// than this (while still passing MIN_BORDER_MATCH) means the tolerance is too
// tight, not that the subject is unusually large. This is exactly the 0.08
// failure above: 10.8% cleared cleared the 5% border floor and reported
// nothing wrong, while cropToSubject and detectCell silently ran on noise.
const MIN_CLEARED_FRACTION = 0.3;

function borderPoints(w: number, h: number): [number, number][] {
  const pts: [number, number][] = [];
  for (let x = 0; x < w; x++) { pts.push([x, 0]); if (h > 1) pts.push([x, h - 1]); }
  for (let y = 1; y < h - 1; y++) { pts.push([0, y]); if (w > 1) pts.push([w - 1, y]); }
  return pts;
}

// A caller-supplied tolerance is respected exactly (no retry): retrying is
// only useful when we picked the default ourselves and it turned out too
// tight for this particular canvas's background (e.g. a busier gradient than
// dwarf_miner's vignette). At most this many automatic retries, each at 1.6x
// the previous tolerance, before giving up and reporting `reduce-bg-thin` as
// before. Chosen empirically so cases that clear only just past
// MIN_CLEARED_FRACTION at the default tolerance clear past it within 2
// retries (0.15 -> 0.24 -> 0.384) without eating the subject the way a
// single big jump to 0.30 did for the magenta-cast case noted in `deCast`
// above.
const MAX_AUTO_RETRIES = 2;

// The flood stops at the subject's dark outline: a pixel this much darker (OKLab
// L) than the darkest corner is never background, whatever its hue. A pale cap
// (dwarf_miner's is near the grey-magenta canvas) sits inside that outline, so
// the fill cannot reach it even when its colour is inside the tolerance.
// Typical values: canvas L 0.61-0.64, outline L 0.32-0.34, cap L 0.70.
const OUTLINE_DROP = 0.10;
const RETRY_GROWTH = 1.6;
// The flood also refuses a step this large between neighbouring pixels: canvas
// vignettes shift a hair per pixel, but a pale subject part against the canvas
// is a hard edge even when both sit inside the corner tolerance. A subject's
// pale cap can be kept at a small step but lost past it; other pale parts
// were eaten before this limit was added. A canvas whose per-pixel noise is
// bigger than this comes out thin, and is retried with no step limit.
const STEP_TOLERANCE = 0.05;

export function removeBackground(img: RgbaImage, opts: { tolerance?: number } = {}): { img: RgbaImage; issues: Issue[] } {
  const auto = opts.tolerance === undefined;
  const startTolerance = opts.tolerance ?? DEFAULT_TOLERANCE;
  let tolerance = startTolerance;
  let result = removeBackgroundStepped(img, tolerance);
  if (auto) {
    let attempt = 0;
    while (result.thin && attempt < MAX_AUTO_RETRIES) {
      tolerance *= RETRY_GROWTH;
      attempt++;
      const retry = removeBackgroundStepped(img, tolerance);
      // Only keep a retry that (a) actually cleared more of the frame and
      // (b) didn't blow straight through into the subject. A near-total
      // flood (>90% cleared) from a starting point under MIN_CLEARED_FRACTION
      // is exactly the failure mode already documented above for the v2
      // magenta case (0.15 -> 0.30 took a real subject from 22757 to 4332
      // opaque px): a genuine subject that fills nearly the whole frame
      // clears well past 90% on the very first (non-retried) pass already,
      // so a retry that only now jumps there is far more likely eating
      // silhouette than finding real background.
      const RETRY_CEILING = 0.9;
      if (retry.clearedFraction > result.clearedFraction && retry.clearedFraction <= RETRY_CEILING) result = retry; else break;
    }
  }
  const issues: Issue[] = result.skipped
    ? [{ rule: 'reduce-bg-skip', severity: 'info', message: 'no near-uniform background at the corners; background removal skipped' }]
    : result.thin
      ? [{ rule: 'reduce-bg-thin', severity: 'warn', message: `background removal cleared only ${(result.clearedFraction * 100).toFixed(1)}% of the frame even after ${attemptsMessage(tolerance, startTolerance)}; crop and cell detection that follow are likely unreliable` }]
      : [];
  return { img: result.img, issues };
}

function attemptsMessage(finalTolerance: number, startTolerance: number): string {
  return finalTolerance === startTolerance ? `tolerance ${startTolerance.toFixed(3)}` : `retrying up to tolerance ${finalTolerance.toFixed(3)}`;
}

function removeBackgroundStepped(img: RgbaImage, tolerance: number): ReturnType<typeof removeBackgroundOnce> {
  const stepped = removeBackgroundOnce(img, tolerance, STEP_TOLERANCE);
  if (!stepped.thin) return stepped;
  const loose = removeBackgroundOnce(img, tolerance, Infinity);
  return loose.clearedFraction > stepped.clearedFraction ? loose : stepped;
}

function removeBackgroundOnce(img: RgbaImage, tolerance: number, stepTolerance: number): { img: RgbaImage; skipped: boolean; thin: boolean; clearedFraction: number } {
  const tolSq = tolerance * tolerance;
  const { width: w, height: h } = img;
  const corners: [number, number][] = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]];
  const cornerLab = corners.map(([x, y]) => rgbToOklab(getPixel(img, x, y)));

  const stepSq = stepTolerance ** 2;
  const outlineL = Math.min(...cornerLab.map((l) => l.L)) - OUTLINE_DROP;

  const near = (x: number, y: number): boolean => {
    const c = getPixel(img, x, y);
    if (c[3] === 0) return true; // already transparent counts as background
    const lab = rgbToOklab(c);
    return cornerLab.some((from) => oklabDistSq(lab, from) <= tolSq);
  };

  const border = borderPoints(w, h);
  const matched = border.filter(([x, y]) => near(x, y)).length;
  if (matched < border.length * MIN_BORDER_MATCH) {
    return { img: cloneImage(img), skipped: true, thin: false, clearedFraction: 0 };
  }

  const out = cloneImage(img);
  const visited = new Uint8Array(w * h);
  for (let i = 0; i < corners.length; i++) {
    const [cx, cy] = corners[i];
    if (visited[cy * w + cx]) continue;
    const from = cornerLab[i];
    const stack: [number, number, Oklab][] = [[cx, cy, from]];
    while (stack.length) {
      const [x, y, prev] = stack.pop()!;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const idx = y * w + x;
      if (visited[idx]) continue;
      const c = getPixel(img, x, y);
      const lab = rgbToOklab(c);
      const passable = c[3] === 0 || (lab.L >= outlineL && oklabDistSq(lab, from) <= tolSq && oklabDistSq(lab, prev) <= stepSq);
      if (!passable) continue;
      visited[idx] = 1;
      if (c[3] !== 0) setPixel(out, x, y, [c[0], c[1], c[2], 0]);
      const here = c[3] === 0 ? prev : lab;
      stack.push([x + 1, y, here], [x - 1, y, here], [x, y + 1, here], [x, y - 1, here]);
    }
  }

  // Per-pixel generator noise/dithering can wall off a pocket of true
  // background from the flood fill: a handful of pixels along the only path
  // out sit just past `tolerance` of the corner colour even though the
  // pocket reads as flat background by eye, so the anchor-referenced BFS
  // above leaves the whole unreachable pocket opaque. Left unhandled, a
  // pocket like this near a corner can stay opaque and blow out
  // cropToSubject's bounding box far past the true subject size. Mop up any
  // pixel still opaque whose immediate neighbourhood is mostly cleared —
  // real subject pixels are interior to a solid block and rarely qualify,
  // isolated noise/pocket pixels almost always do.
  // Only a pixel that still reads as background colour (within a looser 2x
  // tolerance of some corner) is eligible - a genuine, differently-coloured
  // subject pixel that happens to be isolated (e.g. a thin limb, or a small
  // test fixture) must never be swept just for being surrounded by cleared
  // pixels.
  const looseTolSq = (tolerance * 2) ** 2;
  const looseNear = (x: number, y: number): boolean => {
    const c = getPixel(out, x, y);
    if (c[3] === 0) return true;
    const lab = rgbToOklab(c);
    return cornerLab.some((from) => oklabDistSq(lab, from) <= looseTolSq);
  };
  for (let pass = 0; pass < 3; pass++) {
    const toClear: number[] = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        if (out.data[idx * 4 + 3] === 0) continue;
        if (!looseNear(x, y)) continue;
        let clearNeighbours = 0, total = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            total++;
            if (out.data[(ny * w + nx) * 4 + 3] === 0) clearNeighbours++;
          }
        }
        if (total > 0 && clearNeighbours / total >= 0.75) toClear.push(idx);
      }
    }
    if (toClear.length === 0) break;
    for (const idx of toClear) out.data[idx * 4 + 3] = 0;
  }

  let cleared = 0;
  for (let i = 3; i < out.data.length; i += 4) if (out.data[i] === 0) cleared++;
  const clearedFraction = cleared / (w * h);
  return { img: out, skipped: false, thin: clearedFraction < MIN_CLEARED_FRACTION, clearedFraction };
}

function opaqueBox(img: RgbaImage): { x: number; y: number; w: number; h: number } | null {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (getPixel(img, x, y)[3] < OPAQUE) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// `cell` snaps the crop outward to the source canvas's fake-pixel grid. The
// generator renders at a fixed scale from the canvas origin (8x on a 1024
// canvas), so a subject whose bounding box does not start on a multiple of
// `cell` leaves every later cell-sized block straddling two of the
// generator's own pixels. Measured on a v2 dwarf: the subject box started at
// y=388, a phase of 4 — exactly half a cell — which smeared every row and
// produced the dark halo that ate the silhouette. Snapping the bounds out to
// the grid costs at most `cell - 1` transparent pixels a side and removes the
// smear entirely. Omit `cell` (the default) to crop tight, as before.
export function cropToSubject(img: RgbaImage, padding = 0, cell = 0): { img: RgbaImage; issues: Issue[] } {
  const box = opaqueBox(img);
  if (!box) {
    return { img: cloneImage(img), issues: [{ rule: 'reduce-blank', severity: 'warn', message: 'no opaque pixels found; nothing to crop' }] };
  }
  let rect = { x: box.x - padding, y: box.y - padding, w: box.w + padding * 2, h: box.h + padding * 2 };
  if (cell > 1) {
    const x0 = Math.floor(rect.x / cell) * cell;
    const y0 = Math.floor(rect.y / cell) * cell;
    const x1 = Math.ceil((rect.x + rect.w) / cell) * cell;
    const y1 = Math.ceil((rect.y + rect.h) / cell) * cell;
    rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  return { img: crop(img, rect), issues: [] };
}
