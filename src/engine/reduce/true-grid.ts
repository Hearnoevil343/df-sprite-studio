// True-grid finish: for generator output that draws every sprite pixel as an
// exact ~8 px block from the canvas origin. Detect that grid, sample each
// cell's centre, clear the background in cell space, crop. Averaging whole
// blocks at a guessed cell size (snapToGrid) mixes two real pixels plus
// canvas and makes halos; this does not. Thresholds tuned by eye on a range
// of sample sprites.
import { type Rgba, type RgbaImage, createImage, getPixel, setPixel } from '../image/index.ts';
import { type Oklab, oklabToRgb, rgbToOklab } from '../palette/index.ts';

export type TrueGridOptions = {
  pMin?: number;     // period search range, source px per cell
  pMax?: number;
  step?: number;     // flood: max OKLab step to the bg neighbour
  global?: number;   // flood: max OKLab distance to the border median
  dark?: number;     // flood never enters cells darker than this (outline)
  pocket?: number;   // enclosed regions within this of the canvas are cleared
  halo?: number;     // canvas-to-black chroma residual below this is a halo
  stray?: number;    // pieces smaller than this fraction of the largest are dropped
};
export type TrueGrid = { img: RgbaImage; period: number; phaseX: number; phaseY: number; cellsW: number; cellsH: number };

const dist = (p: Oklab, q: Oklab): number => Math.hypot(p.L - q.L, p.a - q.a, p.b - q.b);
const N4: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export function trueGridSample(img: RgbaImage, opts: TrueGridOptions = {}): TrueGrid | null {
  const { pMin = 7.6, pMax = 8.4, step = 0.02, global = 0.15, dark = 0.3, pocket = 0.02, halo = 0.015, stray = 0.05 } = opts;
  const W = img.width, H = img.height;
  const lab: Oklab[] = new Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) lab[y * W + x] = rgbToOklab(getPixel(img, x, y));

  // Subject box: where edge energy is above its mean.
  const Ex = new Float64Array(W), Ey = new Float64Array(H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W - 1; x++) Ex[x] += dist(lab[y * W + x], lab[y * W + x + 1]);
  for (let y = 0; y < H - 1; y++) for (let x = 0; x < W; x++) Ey[y] += dist(lab[y * W + x], lab[(y + 1) * W + x]);
  const bounds = (E: Float64Array): [number, number] => {
    const m = E.reduce((t, v) => t + v, 0) / E.length;
    let lo = 0, hi = E.length - 1;
    while (lo < hi && E[lo] < m) lo++;
    while (hi > lo && E[hi] < m) hi--;
    return [lo, hi];
  };
  const [bx0, bx1] = bounds(Ex), [by0, by1] = bounds(Ey);

  // Period and phase: the ones that leave cells flattest (1D within-segment
  // OKLab spread along rows and columns). Edge-energy periodicity locks onto
  // harmonics (15.9, 23.55), so it is not used.
  const spread = (p: number, phi: number, horiz: boolean): number => {
    let tot = 0;
    const [a0, a1, b0, b1] = horiz ? [bx0, bx1, by0, by1] : [by0, by1, bx0, bx1];
    for (let line = b0; line <= b1; line += 2) {
      for (let seg = phi + Math.floor((a0 - phi) / p) * p; seg < a1; seg += p) {
        const s0 = Math.max(a0, Math.ceil(seg)), s1 = Math.min(a1, Math.ceil(seg + p) - 1);
        if (s1 <= s0) continue;
        let L = 0, A = 0, B = 0;
        for (let t = s0; t <= s1; t++) { const c = horiz ? lab[line * W + t] : lab[t * W + line]; L += c.L; A += c.a; B += c.b; }
        const n = s1 - s0 + 1;
        L /= n; A /= n; B /= n;
        for (let t = s0; t <= s1; t++) { const c = horiz ? lab[line * W + t] : lab[t * W + line]; tot += Math.hypot(c.L - L, c.a - A, c.b - B); }
      }
    }
    return tot;
  };
  let bestS = Infinity, p = 8, px = 0, py = 0;
  for (let pp = pMin; pp <= pMax + 0.001; pp += 0.05) {
    let bxS = Infinity, bxP = 0, byS = Infinity, byP = 0;
    for (let phi = 0; phi < pp; phi += 0.5) {
      const sx = spread(pp, phi, true); if (sx < bxS) { bxS = sx; bxP = phi; }
      const sy = spread(pp, phi, false); if (sy < byS) { byS = sy; byP = phi; }
    }
    if (bxS + byS < bestS) { bestS = bxS + byS; p = pp; px = bxP; py = byP; }
  }

  // Middle 40% of each cell, OKLab mean.
  const cw = Math.floor((W - px) / p), ch = Math.floor((H - py) / p);
  if (cw < 1 || ch < 1) return null;
  const cells: Oklab[] = [];
  for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) {
    const x0 = Math.round(px + i * p + 0.3 * p), x1 = Math.round(px + i * p + 0.7 * p);
    const y0 = Math.round(py + j * p + 0.3 * p), y1 = Math.round(py + j * p + 0.7 * p);
    let L = 0, a = 0, b = 0, n = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const c = lab[y * W + x]; L += c.L; a += c.a; b += c.b; n++; }
    cells.push({ L: L / n, a: a / n, b: b / n });
  }

  // Background: flood from border cells; each step close to its bg neighbour
  // and to the canvas colour (border median), never through the outline.
  const border: Oklab[] = [];
  for (let i = 0; i < cw; i++) border.push(cells[i], cells[(ch - 1) * cw + i]);
  for (let j = 0; j < ch; j++) border.push(cells[j * cw], cells[j * cw + cw - 1]);
  const med = (f: (l: Oklab) => number): number => border.map(f).sort((u, v) => u - v)[border.length >> 1];
  const ref: Oklab = { L: med(l => l.L), a: med(l => l.a), b: med(l => l.b) };
  const bg = new Uint8Array(cw * ch);
  const q: number[] = [];
  for (let k = 0; k < cw * ch; k++) { const i = k % cw, j = (k / cw) | 0; if (i === 0 || j === 0 || i === cw - 1 || j === ch - 1) { bg[k] = 1; q.push(k); } }
  while (q.length) {
    const k = q.pop()!; const i = k % cw, j = (k / cw) | 0;
    for (const [di, dj] of N4) {
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= cw || nj >= ch) continue;
      const n = nj * cw + ni;
      if (bg[n]) continue;
      const c = cells[n];
      if (c.L < dark) continue;
      if (dist(c, cells[k]) < step && dist(c, ref) < global) { bg[n] = 1; q.push(n); }
    }
  }

  // Enclosed canvas pockets (a tail loop): regions whose every cell is
  // within `pocket` of the canvas. Wing membrane is 0.03-0.04 off, so stays.
  const seen = new Uint8Array(cw * ch);
  for (let k = 0; k < cw * ch; k++) {
    if (bg[k] || seen[k] || dist(cells[k], ref) >= pocket) continue;
    const reg = [k], st = [k]; seen[k] = 1;
    while (st.length) {
      const m = st.pop()!; const i = m % cw, j = (m / cw) | 0;
      for (const [di, dj] of N4) {
        const ni = i + di, nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= cw || nj >= ch) continue;
        const n = nj * cw + ni;
        if (bg[n] || seen[n] || dist(cells[n], ref) >= pocket) continue;
        seen[n] = 1; reg.push(n); st.push(n);
      }
    }
    if (reg.length >= 2) for (const m of reg) bg[m] = 1;
  }

  // Halo: an edge cell on the canvas-to-black line is generator
  // anti-aliasing, not art.
  for (let pass = 0; pass < 2; pass++) {
    const kill: number[] = [];
    for (let k = 0; k < cw * ch; k++) {
      if (bg[k]) continue;
      const i = k % cw, j = (k / cw) | 0;
      if (!N4.some(([di, dj]) => { const ni = i + di, nj = j + dj; return ni >= 0 && nj >= 0 && ni < cw && nj < ch && bg[nj * cw + ni] === 1; })) continue;
      const c = cells[k];
      const t = Math.min(1, Math.max(0, (ref.L - c.L) / (ref.L - 0.15)));
      if (t > 0.6) continue;
      if (Math.hypot(c.a - ref.a * (1 - t), c.b - ref.b * (1 - t)) < halo) kill.push(k);
    }
    for (const k of kill) bg[k] = 1;
  }

  // Strays: drop 8-connected pieces under `stray` of the largest piece
  // (generator specks beyond the subject stretch the crop).
  const comp = new Int32Array(cw * ch).fill(-1);
  const sizes: number[] = [];
  for (let k = 0; k < cw * ch; k++) {
    if (bg[k] || comp[k] >= 0) continue;
    const id = sizes.length; let n = 0; const st = [k]; comp[k] = id;
    while (st.length) {
      const m = st.pop()!; n++; const i = m % cw, j = (m / cw) | 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ni = i + di, nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= cw || nj >= ch) continue;
        const t = nj * cw + ni;
        if (bg[t] || comp[t] >= 0) continue;
        comp[t] = id; st.push(t);
      }
    }
    sizes.push(n);
  }
  const biggest = Math.max(0, ...sizes);
  for (let k = 0; k < cw * ch; k++) if (!bg[k] && sizes[comp[k]] < Math.max(4, stray * biggest)) bg[k] = 1;

  // Crop to the subject.
  let x0 = cw, y0 = ch, x1 = -1, y1 = -1;
  for (let k = 0; k < cw * ch; k++) if (!bg[k]) { const i = k % cw, j = (k / cw) | 0; x0 = Math.min(x0, i); x1 = Math.max(x1, i); y0 = Math.min(y0, j); y1 = Math.max(y1, j); }
  if (x1 < 0) return null;
  const ow = x1 - x0 + 1, oh = y1 - y0 + 1;
  const out = createImage(ow, oh);
  for (let j = 0; j < oh; j++) for (let i = 0; i < ow; i++) {
    const k = (j + y0) * cw + i + x0;
    if (bg[k]) continue;
    const [r, g, b] = oklabToRgb(cells[k]);
    setPixel(out, i, j, [r, g, b, 255]);
  }
  return { img: out, period: p, phaseX: px, phaseY: py, cellsW: cw, cellsH: ch };
}

export type EdgeDarkenOptions = { lightness?: number; chroma?: number; dark?: number };

// Darken silhouette-edge pixels (touching clear or the frame) in OKLab, hue
// kept. Own pass because repairOutline is a no-op off the vanilla palette.
export function edgeDarken(img: RgbaImage, opts: EdgeDarkenOptions = {}): RgbaImage {
  const { lightness = 0.45, chroma = 0.8, dark = 0.3 } = opts;
  const out = createImage(img.width, img.height);
  out.data.set(img.data);
  const solid = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < img.width && y < img.height && getPixel(img, x, y)[3] > 0;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    if (!solid(x, y)) continue;
    if (solid(x - 1, y) && solid(x + 1, y) && solid(x, y - 1) && solid(x, y + 1)) continue;
    const l = rgbToOklab(getPixel(img, x, y));
    if (l.L < dark) continue;
    const [r, g, b] = oklabToRgb({ L: Math.max(0.12, l.L * lightness), a: l.a * chroma, b: l.b * chroma });
    setPixel(out, x, y, [r, g, b, 255] as Rgba);
  }
  return out;
}
