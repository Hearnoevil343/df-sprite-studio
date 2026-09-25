// Fake pixel grid detection for the LoRA-output reducer: finds the upscale
// factor of pixel art rendered with soft/antialiased cell edges.
import { type RgbaImage, getPixel } from '../image/index.ts';
import { oklabDistSq, rgbToOklab } from '../palette/index.ts';

export const MIN_CELL = 1;
export const MAX_CELL = 32;

// Per-pixel difference rule: 1 where alpha-zero-ness disagrees, 0 where both
// are transparent, OKLab distance otherwise.
function pixelDiff(a: ReturnType<typeof getPixel>, b: ReturnType<typeof getPixel>): number {
  if ((a[3] === 0) !== (b[3] === 0)) return 1;
  if (a[3] === 0) return 0;
  return Math.sqrt(oklabDistSq(rgbToOklab(a), rgbToOklab(b)));
}

// diffs[x] (x in 1..len-1) = mean difference between line x and line x-1.
function edgeProfile(img: RgbaImage, cols: boolean): number[] {
  const len = cols ? img.width : img.height;
  const span = cols ? img.height : img.width;
  const diffs = new Array<number>(len).fill(0);
  for (let i = 1; i < len; i++) {
    let sum = 0;
    for (let j = 0; j < span; j++) {
      const a = cols ? getPixel(img, i, j) : getPixel(img, j, i);
      const b = cols ? getPixel(img, i - 1, j) : getPixel(img, j, i - 1);
      sum += pixelDiff(a, b);
    }
    diffs[i] = span === 0 ? 0 : sum / span;
  }
  return diffs;
}

// diffs2[x] (x in 1..len-2) = mean OKLab second difference at line x. A linear
// (bilinear) upscale has a flat first difference but kinks at cell centres, so
// its period only shows here.
function kinkProfile(img: RgbaImage, cols: boolean): number[] {
  const len = cols ? img.width : img.height;
  const span = cols ? img.height : img.width;
  const diffs = new Array<number>(len).fill(0);
  for (let i = 1; i < len - 1; i++) {
    let sum = 0;
    for (let j = 0; j < span; j++) {
      const p = cols ? [getPixel(img, i - 1, j), getPixel(img, i, j), getPixel(img, i + 1, j)] : [getPixel(img, j, i - 1), getPixel(img, j, i), getPixel(img, j, i + 1)];
      const t = p.filter((q) => q[3] === 0).length;
      if (t === 3) continue;
      if (t > 0) { sum += 1; continue; }
      const [a, b, c] = p.map((q) => rgbToOklab(q));
      sum += Math.hypot(a.L + c.L - 2 * b.L, a.a + c.a - 2 * b.a, a.b + c.b - 2 * b.b);
    }
    diffs[i] = span === 0 ? 0 : sum / span;
  }
  return diffs;
}

// Share of a profile's edge energy a phase must hold to count: a sparse sprite
// can put a lucky handful of edges on some large period by chance, but a true
// grid holds nearly all of it.
const MIN_EDGE_SHARE = 0.7;

// Best phase's (a boundary is two lines wide: a smooth upscale's kink or a
// nearest-neighbour edge can straddle two adjacent lines) boundary-vs-interior contrast for period n, in units of the
// profile's overall mean: (boundary - interior) / mean. A true period n scores
// about n; a multiple or divisor of it scores lower.
function periodScore(diffs: number[], n: number): number {
  let best = -Infinity;
  let total = 0;
  for (let x = 1; x < diffs.length; x++) total += diffs[x];
  const mean = total / Math.max(1, diffs.length - 1);
  for (let o = 0; o < n; o++) {
    let bSum = 0, bN = 0, iSum = 0, iN = 0;
    for (let x = 1; x < diffs.length; x++) {
      if ((x - o + n) % n < 2) { bSum += diffs[x]; bN++; } else { iSum += diffs[x]; iN++; }
    }
    if (bN === 0 || iN === 0) continue;
    if (total <= 1e-9 || bSum / total < MIN_EDGE_SHARE) continue;
    const b = bSum / bN, i = iSum / iN;
    const score = mean > 1e-9 ? (b - i) / mean : 0;
    if (score > best) best = score;
  }
  return Number.isFinite(best) ? best : 0;
}

// Below this contrast no candidate counts as a real grid.
const SCORE_FLOOR = 0.5;

// Edge periodicity: pixel art upscaled by n changes colour sharply at cell
// boundaries and barely inside cells, even through a smooth upscale. Scores
// each n in 2..min(32, W/3, H/3) by boundary-vs-interior edge energy (best
// phase, columns and rows averaged); the smallest n within 5% of the best
// wins. Size 1 is the answer when nothing clears the floor. confidence is
// (best - runnerUp) / best over candidates outside the tie tolerance that
// are not a multiple or divisor of the winner (those are its own harmonics).
export function detectCell(img: RgbaImage): { size: number; confidence: number } {
  const maxN = Math.min(MAX_CELL, Math.floor(img.width / 3), Math.floor(img.height / 3));
  if (maxN < 2) return { size: MIN_CELL, confidence: 0 };
  const profiles = [[edgeProfile(img, true), edgeProfile(img, false)], [kinkProfile(img, true), kinkProfile(img, false)]];
  const scores = new Map<number, number>();
  for (let n = 2; n <= maxN; n++) {
    scores.set(n, Math.max(...profiles.map(([c, r]) => (periodScore(c, n) + periodScore(r, n)) / 2)));
  }

  let best = -Infinity;
  for (const s of scores.values()) if (s > best) best = s;
  if (best < SCORE_FLOOR) return { size: MIN_CELL, confidence: 0 };

  const tol = best * 0.05;
  let size = MIN_CELL;
  for (const [n, s] of scores) if (s >= best - tol) { size = n; break; }
  let runnerUp = -Infinity;
  for (const [n, s] of scores) if (s < best - tol && n % size !== 0 && size % n !== 0 && s > runnerUp) runnerUp = s;
  const confidence = Number.isFinite(runnerUp) ? Math.max(0, (best - Math.max(0, runnerUp)) / best) : 1;
  return { size, confidence };
}
