// Proportion guide overlay: what data/vanilla-stats.json supports and
// nothing more.
import type { Box } from './sheet-stats.ts';

export type StatBand = { x0: [number, number]; y0: [number, number]; x1: [number, number]; y1: [number, number]; footBaseline: [number, number] };

export type StatGroup = {
  sprites: number;
  bbox: Box;
  footBaseline: number;
  headFound: number;
  headSide: Record<string, number>;
  bySide: Record<string, { head: Box; body: Box }>;
  band: StatBand;
};

export type VanillaStats = {
  proportions: {
    all: StatGroup;
    byToken: Record<string, StatGroup>;
    byPage: Record<string, StatGroup>;
    byPageToken: Record<string, StatGroup>;
  };
};

export type ProportionGuide = {
  bbox: Box;
  band: StatBand;
  footBaseline: number;
  head?: Box;
  sprites: number;
};

// A group under this many measured sprites is too thin to draw from.
export const MIN_GROUP_SPRITES = 20;

// Head box only for groups where a found head lands on top (upright
// creatures) at least half the time; side-on groups get no head box (the
// heuristic is unreliable there).
const TOP_HEAD_SHARE = 0.5;

function group(stats: VanillaStats, page?: string, token?: string): StatGroup {
  const p = stats.proportions;
  const enough = (g: StatGroup | undefined) => g && g.sprites >= MIN_GROUP_SPRITES ? g : undefined;
  return enough(page && token ? p.byPageToken[`${page}|${token}`] : undefined)
    ?? enough(token ? p.byToken[token] : undefined)
    ?? enough(page ? p.byPage[page] : undefined)
    ?? p.all;
}

export function proportionGuide(stats: VanillaStats, opts: { page?: string; token?: string } = {}): ProportionGuide {
  const g = group(stats, opts.page, opts.token);
  const totalHeads = Object.values(g.headSide).reduce((a, b) => a + b, 0);
  const topShare = totalHeads ? (g.headSide.top ?? 0) / totalHeads : 0;
  const head = topShare >= TOP_HEAD_SHARE ? g.bySide.top?.head : undefined;
  return { bbox: g.bbox, band: g.band, footBaseline: g.footBaseline, head, sprites: g.sprites };
}
