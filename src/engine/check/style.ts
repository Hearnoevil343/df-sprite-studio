// Style checker: palette, colour count, outline lightness, stray pixels,
// proportions, foot baseline, floor contrast and blank-entry checks against
// vanilla-derived bands.
// `styleMetrics` is the single source of truth for how each metric is
// measured, so `tools/vanilla-stats.ts --style` (which builds the bands) and
// `checkSprite` (which checks against them) can't drift apart.
import type { Issue } from './issue.ts';
import type { Rgba, RgbaImage } from '../image/pixels.ts';
import { getPixel } from '../image/pixels.ts';
import type { Palette } from '../palette/palette.ts';
import { offPalette } from '../palette/palette.ts';
import { oklabDistSq, rgbToOklab } from '../palette/oklab.ts';
import { OPAQUE, paletteCounts, spriteProportions } from '../stats/sheet-stats.ts';
import type { ProportionGuide } from '../stats/guide.ts';

export type EdgePixel = { x: number; y: number; colour: Rgba };

const NEIGHBOURS4 = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const;
const NEIGHBOURS8 = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]] as const;

function isOpaque(img: RgbaImage, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return false;
  return getPixel(img, x, y)[3] >= OPAQUE;
}

// Opaque pixels with at least one transparent (or off-canvas) 4-neighbour.
export function edgePixels(img: RgbaImage): EdgePixel[] {
  const out: EdgePixel[] = [];
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (!isOpaque(img, x, y)) continue;
      if (NEIGHBOURS4.some(([dx, dy]) => !isOpaque(img, x + dx, y + dy))) out.push({ x, y, colour: getPixel(img, x, y) });
    }
  }
  return out;
}

// A connected (8-way) opaque component this small or smaller, when it isn't
// the sprite's main body, reads as a stray mark rather than intentional art.
export const STRAY_MAX_ISLAND = 2;

export function strayPixels(img: RgbaImage): { x: number; y: number }[] {
  const w = img.width, h = img.height;
  const seen = new Uint8Array(w * h);
  const components: { x: number; y: number }[][] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (seen[i] || !isOpaque(img, x, y)) continue;
      const comp: { x: number; y: number }[] = [];
      const stack: [number, number][] = [[x, y]];
      seen[i] = 1;
      while (stack.length) {
        const [cx, cy] = stack.pop()!;
        comp.push({ x: cx, y: cy });
        for (const [dx, dy] of NEIGHBOURS8) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          if (seen[ni] || !isOpaque(img, nx, ny)) continue;
          seen[ni] = 1;
          stack.push([nx, ny]);
        }
      }
      components.push(comp);
    }
  }
  if (components.length <= 1) return [];
  const main = components.reduce((a, b) => (b.length > a.length ? b : a));
  const strays: { x: number; y: number }[] = [];
  for (const c of components) if (c !== main && c.length <= STRAY_MAX_ISLAND) strays.push(...c);
  return strays;
}

// OKLab lightness above which an edge pixel reads as a light (rather than
// dark, shading-style) outline.
export const LIGHT_L = 0.75;

export function lightEdges(edges: EdgePixel[]): EdgePixel[] {
  return edges.filter(e => rgbToOklab(e.colour).L > LIGHT_L);
}

// Share of edge pixels within `threshold` OKLab distance of any floor
// colour, and which pixels those are (for highlighting).
export function floorCloseness(edges: EdgePixel[], floorColours: Rgba[], threshold: number): { share: number; pixels: { x: number; y: number }[] } {
  if (!edges.length || !floorColours.length) return { share: 0, pixels: [] };
  const floorLabs = floorColours.map(rgbToOklab);
  const pixels: { x: number; y: number }[] = [];
  for (const e of edges) {
    const lab = rgbToOklab(e.colour);
    const dist = Math.sqrt(Math.min(...floorLabs.map(f => oklabDistSq(f, lab))));
    if (dist <= threshold) pixels.push({ x: e.x, y: e.y });
  }
  return { share: pixels.length / edges.length, pixels };
}

// The same metrics vanilla-stats.ts --style measures over vanilla sprites,
// so a checked sprite and the bands it's checked against are built the same
// way.
export type StyleMetrics = {
  blank: boolean;
  colourCount: number;
  edges: EdgePixel[];
  outlineLightShare: number;
  footBaseline: number | null;
};

export function styleMetrics(img: RgbaImage): StyleMetrics {
  const colourCount = paletteCounts(img).size;
  if (colourCount === 0) return { blank: true, colourCount: 0, edges: [], outlineLightShare: 0, footBaseline: null };
  const edges = edgePixels(img);
  const outlineLightShare = edges.length ? lightEdges(edges).length / edges.length : 0;
  const proportions = spriteProportions(img, { x: 0, y: 0, w: img.width, h: img.height });
  return { blank: false, colourCount, edges, outlineLightShare, footBaseline: proportions?.footBaseline ?? null };
}

export type StyleBand = [number, number];

export type StyleTokenBands = {
  sprites: number;
  colourCount: StyleBand;
  outlineLightShare: StyleBand;
  footBaseline: StyleBand;
};

export type FloorBand = {
  id: string;
  label: string;
  colours: Rgba[];
  distanceThreshold: number; // vanilla's 5th percentile edge-to-floor distance
  closeShare: StyleBand;     // band of vanilla sprites' own share within that distance
};

export type VanillaStyle = {
  byToken: Record<string, StyleTokenBands>;
  floors: FloorBand[];
};

// A group under this many measured sprites is too thin to check against.
export const MIN_STYLE_SPRITES = 20;

function tokenBands(style: VanillaStyle, token: string): StyleTokenBands | undefined {
  const own = style.byToken[token];
  if (own && own.sprites >= MIN_STYLE_SPRITES) return own;
  const all = style.byToken.ALL;
  return all && all.sprites >= MIN_STYLE_SPRITES ? all : undefined;
}

export type StyleContext = {
  token: string;
  palette?: Palette;
  locked?: boolean;
  style?: VanillaStyle;
  guide?: ProportionGuide;
  floors?: FloorBand[];
};

export function checkSprite(img: RgbaImage, ctx: StyleContext): Issue[] {
  const metrics = styleMetrics(img);
  if (metrics.blank) return [{ rule: 'blank', severity: 'warn', message: 'Drawn but fully transparent.' }];

  const issues: Issue[] = [];

  if (ctx.palette) {
    const off = offPalette(img, ctx.palette);
    if (off.length) {
      issues.push({
        rule: 'palette', severity: ctx.locked ? 'error' : 'warn',
        message: `${off.length} pixel(s) not in the palette.`,
        pixels: off.map(({ x, y }) => ({ x, y })),
      });
    }
  }

  const badAlpha: { x: number; y: number }[] = [];
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const a = getPixel(img, x, y)[3];
      if (a !== 0 && a !== 255) badAlpha.push({ x, y });
    }
  }
  if (badAlpha.length) issues.push({ rule: 'alpha', severity: 'error', message: `${badAlpha.length} pixel(s) with partial alpha.`, pixels: badAlpha });

  const stray = strayPixels(img);
  if (stray.length) issues.push({ rule: 'stray', severity: 'warn', message: `${stray.length} stray pixel(s) with no connection to the main body.`, pixels: stray });

  const bands = ctx.style ? tokenBands(ctx.style, ctx.token) : undefined;

  if (bands) {
    if (metrics.colourCount > bands.colourCount[1]) {
      issues.push({ rule: 'colour-count', severity: 'warn', message: `${metrics.colourCount} distinct colours, above vanilla's usual range.`, band: bands.colourCount });
    }
    if (metrics.outlineLightShare > bands.outlineLightShare[1]) {
      issues.push({
        rule: 'outline', severity: 'warn', message: 'More of the outline reads light than vanilla usually does.',
        band: bands.outlineLightShare, pixels: lightEdges(metrics.edges).map(({ x, y }) => ({ x, y })),
      });
    }
    if (metrics.footBaseline != null && (metrics.footBaseline < bands.footBaseline[0] || metrics.footBaseline > bands.footBaseline[1])) {
      issues.push({
        rule: 'baseline', severity: 'warn', message: `Foot baseline at row ${metrics.footBaseline}, outside vanilla's usual band.`,
        band: bands.footBaseline, pixels: Array.from({ length: img.width }, (_, x) => ({ x, y: metrics.footBaseline! })),
      });
    }
  }

  if (ctx.guide) {
    const proportions = spriteProportions(img, { x: 0, y: 0, w: img.width, h: img.height });
    issues.push({
      rule: 'proportions', severity: 'info', message: 'Head/body split for reference against vanilla proportions.',
      pixels: proportions?.head ? headOutline(proportions.head) : undefined,
    });
  }

  if (ctx.floors) {
    for (const floor of ctx.floors) {
      const { share, pixels } = floorCloseness(metrics.edges, floor.colours, floor.distanceThreshold);
      if (share > floor.closeShare[1]) {
        issues.push({
          rule: 'floor-contrast', severity: 'warn', message: `Low contrast against the ${floor.label} floor on ${Math.round(share * 100)}% of the outline.`,
          band: floor.closeShare, pixels,
        });
      }
    }
  }

  return issues;
}

function headOutline(head: { x: number; y: number; w: number; h: number }): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let x = head.x; x < head.x + head.w; x++) { out.push({ x, y: head.y }); out.push({ x, y: head.y + head.h - 1 }); }
  for (let y = head.y; y < head.y + head.h; y++) { out.push({ x: head.x, y }); out.push({ x: head.x + head.w - 1, y }); }
  return out;
}
