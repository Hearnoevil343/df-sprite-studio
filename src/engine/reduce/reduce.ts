// Fit-to-tile pipeline for the LoRA-output reducer: wires background removal,
// crop-to-subject and grid detection (this module's own primitives) together
// with downscale/bottomAlign/snapToPalette/outline into a single entry point.
import { type RgbaImage, createImage, downscale, getPixel, setPixel } from '../image/index.ts';
import { bottomAlign } from '../image/align.ts';
import { outline } from '../image/outline.ts';
import type { Palette } from '../palette/palette.ts';
import { snapToPalette } from '../palette/palette.ts';
import { TILE } from '../sheet/pack.ts';
import { proportionGuide } from '../stats/guide.ts';
import type { VanillaStats } from '../stats/guide.ts';
import { DEFAULT_FOOT_BASELINE } from '../draft/draft-variant.ts';
import type { Issue } from '../check/issue.ts';
import { cropToSubject, removeBackground } from './background.ts';
import { MIN_CELL, detectCell } from './grid.ts';

export type ReduceOptions = {
  tolerance?: number;   // removeBackground's OKLab tolerance
  padding?: number;     // cropToSubject's transparent margin
  tileSpan?: number;    // output tile size in pixels; TILE (32) for a single tile
  // Foot baseline source: proportionGuide's group, same as the style checker
  // uses (data/vanilla-stats.json), so a reduced and a hand-drawn sprite are
  // judged against the same line. Falls back to DEFAULT_FOOT_BASELINE, same
  // as draftVariant, when no stats are supplied (e.g. a unit test fixture).
  stats?: VanillaStats;
  token?: string;
  cell?: number;        // explicit fake-pixel cell size; skips detection
  // Skip background removal/crop/cell-detection when the source is already
  // at or under ALREADY_SPRITE_SCALE pixels on its longer side (see that
  // constant below). Off by default so existing small test fixtures (which
  // exercise the full chain on deliberately tiny scenes) are unaffected;
  // real callers reading an unknown file from disk (tools/studio.ts's
  // `reduce`/`df-look` commands) opt in, since only there does "small" imply
  // "probably already a finished-scale sprite" rather than "small test
  // fixture".
  skipIfAlreadySpriteScale?: boolean;
};

// Scales `img` down to fit inside a target x target canvas (aspect kept, never
// upscaled), then centres it on transparent padding.
function fitToTile(img: RgbaImage, target: number): RgbaImage {
  let src = img;
  if (img.width > target || img.height > target) {
    const k = Math.min(target / img.width, target / img.height);
    src = downscale(img, Math.max(1, Math.round(img.width * k)), Math.max(1, Math.round(img.height * k)));
  }
  const out = createImage(target, target);
  const ox = Math.floor((target - src.width) / 2);
  const oy = Math.floor((target - src.height) / 2);
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) setPixel(out, x + ox, y + oy, getPixel(src, x, y));
  }
  return out;
}

// A source whose longer side is already at or below this many pixels is
// already near finished-sprite scale (vanilla tiles top out at a handful of
// tiles across, well under 64px on a side) rather than a raw 1024-class
// generator canvas. Running the full background/crop/cell chain on one of
// these assumes a big canvas with a flood-fillable background margin and a
// fake-pixel grid to detect; on an already-small input it instead crushes
// the image: on a pre-reduced 32x32-class source, the chain's own
// cell-detection can guess a cell size against a subject with no such grid
// and downscale a recognisable
// dwarf down to a 4x4 smear. Matches `tools/studio.ts compare`'s own
// RAW_CANVAS_MIN convention for telling a raw canvas from a finished sprite.
const ALREADY_SPRITE_SCALE = 64;

export function reduceImage(src: RgbaImage, palette: Palette, opts: ReduceOptions = {}): { img: RgbaImage; cell: number; issues: Issue[] } {
  const tileSpan = opts.tileSpan ?? TILE;
  const issues: Issue[] = [];

  if (opts.skipIfAlreadySpriteScale && Math.max(src.width, src.height) <= ALREADY_SPRITE_SCALE) {
    issues.push({ rule: 'reduce-already-sprite-scale', severity: 'info', message: `source is ${src.width}x${src.height}, already at or under sprite scale; skipping background removal, crop and cell detection` });
    const footBaseline = opts.stats ? Math.round(proportionGuide(opts.stats, { token: opts.token }).footBaseline) : DEFAULT_FOOT_BASELINE;
    const fitted = fitToTile(src, tileSpan);
    const aligned = bottomAlign(fitted, footBaseline);
    const snapped = snapToPalette(aligned, palette);
    outline(snapped, palette, 'ramp');
    return { img: snapped, cell: 1, issues };
  }

  const bg = removeBackground(src, { tolerance: opts.tolerance });
  issues.push(...bg.issues);

  const cropped = cropToSubject(bg.img, opts.padding);
  issues.push(...cropped.issues);

  let cell = opts.cell ?? 0;
  if (!cell) {
    const det = detectCell(cropped.img);
    cell = det.size;
    if (det.confidence < 0.15) {
      // Edge-periodicity detection found no reliable grid (common once crop
      // fails or the source has none). Falling back to size 1 would then
      // pass the crop's full pixel dimensions straight to fitToTile, so a
      // large-but-undetected subject is estimated from its own bounding box
      // instead: scaled so its longer side lands near one vanilla tile (32px)
      // rather than being taken at face value.
      const bbox = Math.max(cropped.img.width, cropped.img.height);
      const estimated = Math.max(MIN_CELL, Math.round(bbox / tileSpan));
      if (estimated > cell) cell = estimated;
      issues.push({ rule: 'reduce-cell-unsure', severity: 'warn', message: `Grid size guessed (${cell}), low confidence` });
    }
  }

  const fitted = fitToTile(cropped.img, cell * tileSpan);
  const small = downscale(fitted, tileSpan, tileSpan);

  const footBaseline = opts.stats ? Math.round(proportionGuide(opts.stats, { token: opts.token }).footBaseline) : DEFAULT_FOOT_BASELINE;
  const aligned = bottomAlign(small, footBaseline);

  const snapped = snapToPalette(aligned, palette);
  outline(snapped, palette, 'ramp');

  return { img: snapped, cell, issues };
}
