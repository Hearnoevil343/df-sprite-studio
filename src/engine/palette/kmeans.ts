// Weighted k-means in OKLab, k-means++ seeded. Shared by the vanilla palette
// builder (tools/vanilla-stats.ts) and the palette-align DF-look pass
// (reduce/df-look.ts). A small deterministic PRNG keeps a re-run with the
// same seed reproducible.
//
// Seeding is load-bearing: lightness-sorted seeding starts every centroid
// near the L axis and can never reach a rare, low-population hue (skin,
// beard) that sits off to the side in a*/b*. k-means++'s distance-weighted
// pick instead favours points far from existing centroids in the full OKLab
// space, so a rare hue gets a real chance to seed its own cluster.
import type { Oklab } from './oklab.ts';
import { oklabDistSq } from './oklab.ts';

export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function weightedPick<T>(items: T[], weight: (t: T) => number, rand: () => number): T {
  const total = items.reduce((s, t) => s + weight(t), 0);
  let r = rand() * total;
  for (const t of items) { r -= weight(t); if (r <= 0) return t; }
  return items[items.length - 1];
}

export function kmeansOklab(points: (Oklab & { w: number })[], k: number, seed: number): Oklab[] {
  const rand = mulberry32(seed);
  const centroids: Oklab[] = [weightedPick(points, p => p.w, rand)];
  while (centroids.length < k && centroids.length < points.length) {
    const dist = points.map(p => Math.min(...centroids.map(c => oklabDistSq(p, c))));
    const weighted = points.map((p, i) => ({ p, w: p.w * dist[i] }));
    centroids.push(weightedPick(weighted, x => x.w, rand).p);
  }
  for (let iter = 0; iter < 30; iter++) {
    const sums = centroids.map(() => ({ L: 0, a: 0, b: 0, w: 0 }));
    for (const p of points) {
      let best = 0, bestD = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const d = oklabDistSq(p, centroids[c]);
        if (d < bestD) { bestD = d; best = c; }
      }
      const s = sums[best];
      s.L += p.L * p.w; s.a += p.a * p.w; s.b += p.b * p.w; s.w += p.w;
    }
    let moved = 0;
    for (let c = 0; c < centroids.length; c++) {
      if (sums[c].w === 0) continue; // empty cluster: leave it where it was
      const next = { L: sums[c].L / sums[c].w, a: sums[c].a / sums[c].w, b: sums[c].b / sums[c].w };
      moved += Math.hypot(next.L - centroids[c].L, next.a - centroids[c].a, next.b - centroids[c].b);
      centroids[c] = next;
    }
    if (moved < 1e-5) break;
  }
  return centroids;
}
