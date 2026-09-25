// Batch mode for the LoRA-output reducer: folds reduceImage over a folder's
// worth of loose PNGs into one ModCreature, matching each file to a template
// entry by filename ("<key>.png", the sheet slicer's own rect-naming
// convention). The result feeds straight into modFiles/writeModDir (Node
// side, tools/studio.ts) the same way draftPlan/draftVariant feed into a
// creature's sprites elsewhere - this module only builds the creature, it
// doesn't pack or write anything itself.
import type { RgbaImage } from '../image/index.ts';
import type { Palette } from '../palette/palette.ts';
import type { SpriteTemplate } from '../templates/template.ts';
import type { ModCreature } from '../mod/mod-files.ts';
import type { Issue } from '../check/issue.ts';
import { TILE } from '../sheet/pack.ts';
import { reduceImage } from './reduce.ts';
import type { ReduceOptions } from './reduce.ts';

export type BatchFile = { name: string; img: RgbaImage };
// tileSpan and token are computed per matched entry (from its own tile size
// and raw token), not taken from the caller.
export type BatchOptions = Omit<ReduceOptions, 'tileSpan' | 'token'> & { id: string; caste?: string };

// "creature_name.png" -> "creature_name": the key a file matches against a
// template entry, same convention sheet/sprite-rects.ts's rects use.
function keyOf(name: string): string {
  return name.replace(/\.png$/i, '');
}

export function reduceBatch(files: BatchFile[], palette: Palette, template: SpriteTemplate, opts: BatchOptions): { creature: ModCreature; issues: Issue[] } {
  const byKey = new Map(template.entries.map(e => [e.key, e]));
  const sprites: Record<string, RgbaImage> = {};
  const include: string[] = [];
  const issues: Issue[] = [];

  for (const file of files) {
    const key = keyOf(file.name);
    const entry = byKey.get(key);
    if (!entry) {
      issues.push({ rule: 'reduce-unmatched', severity: 'warn', message: `${file.name}: no "${key}" entry in template "${template.id}"` });
      continue;
    }
    const [w, h] = entry.size ?? [1, 1];
    if (w !== h) {
      issues.push({ rule: 'reduce-unmatched', severity: 'warn', key, message: `${file.name}: entry "${key}" is ${w}x${h} tiles, not square; skipped` });
      continue;
    }
    const { img, issues: stageIssues, cell } = reduceImage(file.img, palette, { ...opts, tileSpan: w * TILE, token: entry.token });
    sprites[key] = img;
    if (entry.default === false) include.push(key);
    for (const issue of stageIssues) issues.push({ ...issue, key });
    issues.push({ rule: 'reduce-cell', severity: 'info', key, message: `${file.name}: detected cell size ${cell}` });
  }

  const creature: ModCreature = {
    id: opts.id, ...(opts.caste ? { caste: opts.caste } : {}),
    templateId: template.id, include, omit: [], sprites,
  };
  return { creature, issues };
}
