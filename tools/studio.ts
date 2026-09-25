// Command line for the studio checks.
// Usage: node tools/studio.ts <command> [args] [--json] [--df <path>]
//   find-missing <folder...>
//   validate <folder...>
//   check <folder|png...>
//   draft <mod folder> --creature <id> [--caste <c>] [--kinds k1,k2,...] [--write]
//   generate "<description>" | --from <image> --out <folder> [--count n=4] [--seed n] [--size px] [--lora file] [--comfy url] [--ollama url]
//   reduce <folder of PNGs> --creature <id> [--caste <c>] [--template <id>] [--write]
//   compare <png...> --out <path> [--cell n] [--zoom n=12]
//   df-look <png> --out <path> [--cell n=8] [--crop] [--finish] [--snap-grid] [--decast]
//     [--contrast [--lightness n=1.3] [--chroma n=1.8]] [--levels] [--quantize [--k n=24]]
//     [--palette-align] [--despeckle] [--outline-repair] [--seed n=1]
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import {
  type Issue, type ModFile, type ModInfo, type ModProject, type Palette, type VanillaIndex,
  checkSprite, contrastLift, cropToSubject, deCast, despeckle, draftPlan, draftVariant, findMissingArt, isBlank, levels, modFiles, modId, paletteAlign, proportionGuide, quantize, readMod, removeBackground,
  createImage, getPixel, setPixel, reduceBatch, reduceImage, repairOutline, snapToGrid, trueGridSample, edgeDarken, buildCaptionRequest, buildPrompt, buildWorkflow, cellFor, parseCaption, parseHistory, rankCandidates, viewQuery, DEFAULT_GENERATE, templateById, validateMod, validateMods,
} from '../src/engine/index.ts';
import type { MissingArt, ModSource } from '../src/engine/index.ts';
import type { DraftKind } from '../src/engine/index.ts';
import type { VanillaStats } from '../src/engine/index.ts';
import type { VanillaStyle } from '../src/engine/index.ts';
import { dfDir } from './df-dir.ts';
import { findModRoots, readModDir, writeModDir } from './mod-fs.ts';
import { decodePng, encodePng } from './png.ts';

const argv = process.argv.slice(2);
const command = argv[0];
const json = argv.includes('--json');
const write = argv.includes('--write');

function usageError(message: string): never {
  console.error(message);
  process.exit(2);
}

// Positional args: everything not a known flag or a known flag's value.
const VALUE_FLAGS = new Set(['--df', '--creature', '--caste', '--kinds', '--template', '--out', '--seed', '--count', '--comfy', '--lora', '--size', '--from', '--ollama', '--cell', '--k', '--lightness', '--chroma', '--zoom']);
const FLAG_FLAGS = new Set(['--json', '--write', '--snap-grid', '--palette-align', '--contrast', '--despeckle', '--outline-repair', '--crop', '--finish', '--decast', '--levels', '--quantize', '--own-colours', '--snap-to-vanilla']);
function positionals(a: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < a.length; i++) {
    const tok = a[i];
    if (VALUE_FLAGS.has(tok)) { i++; continue; }
    if (FLAG_FLAGS.has(tok)) continue;
    out.push(tok);
  }
  return out;
}
function flagValue(a: string[], name: string): string | undefined {
  const i = a.indexOf(name);
  return i >= 0 ? a[i + 1] : undefined;
}

function printIssue(source: string, issue: Issue): void {
  const loc = [issue.file ?? source, issue.creature ? `${issue.creature}${issue.caste ? `:${issue.caste}` : ''}${issue.key ? `:${issue.key}` : ''}` : undefined]
    .filter(Boolean).join(' ');
  console.log(`${issue.severity} ${loc || source} ${issue.rule} ${issue.message}`);
}

// Raw (.txt) files only, no images: enough for findMissingArt/validateMods,
// and much cheaper than decoding every vanilla PNG.
function readRawFiles(root: string): ModFile[] {
  const out: ModFile[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.txt$/i.test(entry.name)) continue;
      out.push({ path: relative(root, full).split(/[\\/]/).join('/'), bytes: new Uint8Array(readFileSync(full)) });
    }
  };
  walk(root);
  return out;
}

function vanillaSource(df: string): ModSource {
  const root = join(df, 'data', 'vanilla');
  return { id: 'vanilla', root, files: readRawFiles(root), vanilla: true };
}

// Full read (with images): validateMod needs the actual page images to check
// sizes and rect bounds, so unlike vanilla (raws only, see readRawFiles) a
// user mod is read completely.
function modSourcesFrom(folders: string[]): ModSource[] {
  const out: ModSource[] = [];
  for (const folder of folders) {
    const roots = findModRoots(folder);
    if (!roots.length) usageError(`${folder}: not a mod folder (no info.txt) or folder of mod folders`);
    for (const root of roots) out.push({ id: basename(root), root, files: readModDir(root) });
  }
  return out;
}

function loadVanillaIndex(): VanillaIndex {
  const path = join('data', 'vanilla-index.json');
  if (!existsSync(path)) usageError(`${path} missing; run: node tools/vanilla-index.ts`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function loadVanillaStyle(): VanillaStyle {
  const path = join('data', 'vanilla-style.json');
  if (!existsSync(path)) usageError(`${path} missing; run: node tools/vanilla-stats.ts --style`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function loadVanillaStats(): VanillaStats | undefined {
  const path = join('data', 'vanilla-stats.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
}

function loadVanillaPalette(): Palette {
  const path = join('data', 'vanilla-palette.json');
  if (!existsSync(path)) usageError(`${path} missing; run: node tools/vanilla-stats.ts`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function runFindMissing(): void {
  const folders = positionals(argv.slice(1));
  if (!folders.length) usageError('find-missing <folder...> [--df <path>] [--json]');
  const sources = [vanillaSource(dfDir(argv)), ...modSourcesFrom(folders)];
  const missing: MissingArt[] = findMissingArt(sources);
  if (json) { console.log(JSON.stringify(missing, null, 1)); process.exit(missing.length ? 1 : 0); }
  for (const m of missing) {
    const who = m.caste ? `${m.id}:${m.caste}` : m.id;
    console.log(`${m.status === 'none' ? 'warn' : 'info'} ${m.graphicsIn[0] ?? m.definedIn} ${who} missing template=${m.template} keys=${m.missing.join(',')}`);
  }
  console.log(`${missing.length} creature(s) with missing art`);
  process.exit(missing.length ? 1 : 0);
}

function runValidate(): void {
  const folders = positionals(argv.slice(1));
  if (!folders.length) usageError('validate <folder...> [--df <path>] [--json]');
  dfDir(argv); // vanilla install still required, even though the index is precomputed
  const known = loadVanillaIndex();
  const modSources = modSourcesFrom(folders);
  const issues: Issue[] = [...validateMods(modSources, known)];
  for (const src of modSources) issues.push(...validateMod(src.files, known));
  if (json) { console.log(JSON.stringify(issues, null, 1)); process.exit(issues.some(i => i.severity === 'error') ? 1 : 0); }
  for (const i of issues) printIssue(i.mod ?? '', i);
  const errors = issues.filter(i => i.severity === 'error').length;
  console.log(`${issues.length} issue(s), ${errors} error(s)`);
  process.exit(errors ? 1 : 0);
}

function runCheck(): void {
  const targets = positionals(argv.slice(1));
  if (!targets.length) usageError('check <folder|png...> [--json]');
  const style = loadVanillaStyle();
  const stats = loadVanillaStats();
  const issues: (Issue & { source: string })[] = [];

  for (const target of targets) {
    if (!existsSync(target)) usageError(`${target}: not found`);
    if (statSync(target).isDirectory()) {
      const files = readModDir(target);
      const { mod, palette, paletteLocked, creatures } = readMod(files);
      for (const c of creatures) {
        const template = templateById(c.templateId);
        for (const [key, img] of Object.entries(c.sprites)) {
          if (isBlank(img)) continue;
          const entry = template?.entries.find(e => e.key === key);
          const singleTile = !entry?.size || (entry.size[0] === 1 && entry.size[1] === 1);
          const guide = singleTile && stats ? proportionGuide(stats, { token: entry?.token }) : undefined;
          const found = checkSprite(img, {
            token: entry?.token ?? key, palette, locked: paletteLocked, style, floors: style.floors, guide,
          }).filter(i => singleTile || i.rule !== 'baseline');
          const who = c.caste ? `${c.id}:${c.caste}` : c.id;
          for (const i of found) issues.push({ ...i, source: mod.id || target, creature: c.id, caste: c.caste, key: i.key ?? key });
        }
      }
    } else if (/\.png$/i.test(target)) {
      const img = decodePng(new Uint8Array(readFileSync(target)));
      const found = checkSprite(img, { token: 'DEFAULT', style, floors: style.floors });
      for (const i of found) issues.push({ ...i, source: target, file: target });
    } else usageError(`${target}: expected a mod folder or a .png file`);
  }

  if (json) { console.log(JSON.stringify(issues, null, 1)); process.exit(issues.some(i => i.severity === 'error') ? 1 : 0); }
  for (const i of issues) printIssue(i.source, i);
  const errors = issues.filter(i => i.severity === 'error').length;
  console.log(`${issues.length} issue(s), ${errors} error(s)`);
  process.exit(errors ? 1 : 0);
}

function runDraft(): void {
  const [root] = positionals(argv.slice(1));
  if (!root) usageError('draft <mod folder> --creature <id> [--caste <c>] [--kinds k1,k2,...] [--write] [--json]');
  const creatureId = flagValue(argv, '--creature');
  if (!creatureId) usageError('draft: --creature <id> is required');
  const caste = flagValue(argv, '--caste');
  const kindsFilter = flagValue(argv, '--kinds')?.split(',').map(s => s.trim()) as DraftKind[] | undefined;

  if (!existsSync(root) || !statSync(root).isDirectory()) usageError(`${root}: not a folder`);
  const files = readModDir(root);
  const { mod, palette, paletteLocked, creatures } = readMod(files);
  if (!palette) usageError(`${root}: no locked palette (studio.json missing or not from this app); can't draft`);

  const creature = creatures.find(c => c.id === creatureId && (caste === undefined || c.caste === caste));
  if (!creature) usageError(`${creatureId}${caste ? `:${caste}` : ''}: not found in ${root}`);
  const template = templateById(creature.templateId);
  if (!template) usageError(`${creatureId}: unknown template ${creature.templateId}`);

  const drawnKeys = new Set(Object.entries(creature.sprites).filter(([, img]) => !isBlank(img)).map(([k]) => k));
  let plan = draftPlan(template, drawnKeys);
  if (kindsFilter?.length) plan = plan.filter(step => step.kinds.some(k => kindsFilter.includes(k)));

  const results = plan.map(step => {
    let img = creature.sprites[step.from];
    for (const kind of step.kinds) img = draftVariant(img, kind, palette);
    return { ...step, img };
  });

  if (write) for (const r of results) creature.sprites[r.key] = r.img;

  if (json) {
    console.log(JSON.stringify(results.map(({ key, from, kinds }) => ({ key, from, kinds, applied: write })), null, 1));
  } else {
    for (const r of results) console.log(`${write ? 'drafted' : 'would draft'} ${r.key} from ${r.from} via ${r.kinds.join('+')}`);
    console.log(`${results.length} step(s)${write ? ', written' : ' (dry run, pass --write to apply)'}`);
  }

  if (write) {
    const project: ModProject = { mod, palette, paletteLocked: paletteLocked ?? false, customColours: [], creatures };
    writeModDir(root, modFiles(project));
  }
  process.exit(0);
}

function runReduce(): void {
  const [root] = positionals(argv.slice(1));
  if (!root) usageError('reduce <folder of PNGs> --creature <id> [--caste <c>] [--template <id>] [--write] [--json]');
  const creatureId = flagValue(argv, '--creature');
  if (!creatureId) usageError('reduce: --creature <id> is required');
  const caste = flagValue(argv, '--caste');
  const templateId = flagValue(argv, '--template') ?? 'simple-creature';
  const template = templateById(templateId);
  if (!template) usageError(`reduce: unknown template ${templateId}`);

  if (!existsSync(root) || !statSync(root).isDirectory()) usageError(`${root}: not a folder`);
  const names = readdirSync(root).filter(n => /\.png$/i.test(n));
  if (!names.length) usageError(`${root}: no .png files found`);
  const files = names.map(name => ({ name, img: decodePng(new Uint8Array(readFileSync(join(root, name)))) }));

  const palette = loadVanillaPalette();
  const stats = loadVanillaStats();

  const { creature, issues } = reduceBatch(files, palette, template, { id: creatureId, caste, stats, skipIfAlreadySpriteScale: true });

  if (json) {
    console.log(JSON.stringify({ creature: { id: creature.id, caste: creature.caste, templateId: creature.templateId, sprites: Object.keys(creature.sprites) }, issues }, null, 1));
  } else {
    for (const i of issues) printIssue(root, i);
    console.log(`${Object.keys(creature.sprites).length} sprite(s) reduced${write ? ', written' : ' (dry run, pass --write to apply)'}`);
  }

  if (write) {
    const mod: ModInfo = { id: modId(basename(root)), name: basename(root), version: '1', author: '', description: '' };
    const project: ModProject = { mod, palette, paletteLocked: true, customColours: [], creatures: [creature] };
    writeModDir(root, modFiles(project));
  }
  const errors = issues.filter(i => i.severity === 'error').length;
  process.exit(errors ? 1 : 0);
}

// The DF-look finishing passes (src/engine/reduce/df-look.ts), each behind
// its own flag so a person picks whichever subset looks right by eye rather
// than a fixed pipeline. Applied in a fixed order regardless of flag order on
// the command line. That order is load-bearing and was settled by eye against
// vanilla (see logs/): contrast and de-cast run BEFORE any colour reduction,
// because reducing first snaps muted colours to muted entries and there is
// nothing left for a later lift to recover.
//
// --crop is normally what you want on a raw generated PNG: it removes the
// canvas and crops to the subject with the crop snapped to the generator's
// own fake-pixel grid. Without that snap the subject's bounding box starts at
// an arbitrary phase and every block straddles two of the generator's pixels,
// which smears the whole sprite.
//
// --finish is the whole recommended stack in one flag, tuned on v2 output.
function runDfLook(): void {
  const [file] = positionals(argv.slice(1));
  const usage = 'df-look <png> --out <path> [--cell n=8] [--crop] [--tolerance n] [--finish] [--snap-grid] [--decast] [--contrast [--lightness n=1.3] [--chroma n=1.8]] [--levels] [--quantize [--k n=24]] [--palette-align [--k n=16]] [--despeckle] [--outline-repair] [--seed n=1] [--json]';
  if (!file) usageError(usage);
  const outPath = flagValue(argv, '--out');
  if (!outPath) usageError('df-look: --out <path> is required');
  if (!existsSync(file)) usageError(`${file}: not found`);

  const explicitCell = flagValue(argv, '--cell');
  const explicitTolerance = flagValue(argv, '--tolerance');
  const bgOpts = explicitTolerance !== undefined ? { tolerance: Number(explicitTolerance) } : {};
  const seed = Number(flagValue(argv, '--seed') ?? 1);
  const finish = argv.includes('--finish');
  const lightness = Number(flagValue(argv, '--lightness') ?? (finish ? 1.15 : 1.3));
  const chroma = Number(flagValue(argv, '--chroma') ?? (finish ? 1.5 : 1.8));
  const on = (flag: string) => finish || argv.includes(flag);
  // --finish aligns to the vanilla palette (k=16) rather than quantizing
  // to the image's own colours: paletteAlign reads as flatter, more DF-like
  // colour blocks; quantize at k=24 keeps more of the generator's own muted
  // blends and reads muddier by eye. See df-look.ts.
  const k = Number(flagValue(argv, '--k') ?? (finish ? 24 : argv.includes('--palette-align') && !argv.includes('--quantize') ? 16 : 24));

  const palette = loadVanillaPalette();
  const applied: string[] = [];
  const issues: Issue[] = [];
  let img = decodePng(new Uint8Array(readFileSync(file)));

  // Cell size: an explicit --cell is respected exactly. Otherwise the
  // fixed default of 8 (tuned by eye against several correctly-scaled
  // samples) is kept UNLESS the subject's own bounding box (removeBackground
  // + cropToSubject at cell=1) is big enough that cell=8 would still leave
  // an oversized sprite -- some sample sets come out 2-3x too big at cell=8
  // (a vanilla creature tops out around one tile, ~32px). In that
  // case scale cell up so the bbox's longer side lands near one tile
  // instead. `detectCell`'s own fake-pixel-grid period is a different
  // quantity from this finishing-chain downsample factor (dwarf_miner's own
  // grid period is 4, not the cell=8 that actually looks right on it) and
  // using it directly here regressed the already-good cases, so it is not
  // used for this default.
  const TARGET_SPAN = 32;
  const OVERSIZE_AT_DEFAULT = 48; // projected span above this at cell=8 counts as oversized
  let cell = explicitCell !== undefined ? Number(explicitCell) : 8;
  if (explicitCell === undefined && (on('--crop') || on('--snap-grid'))) {
    const preBg = removeBackground(img, bgOpts);
    const preCrop = cropToSubject(preBg.img, 0, 1);
    const bbox = Math.max(preCrop.img.width, preCrop.img.height);
    if (bbox / cell > OVERSIZE_AT_DEFAULT) cell = Math.max(cell, Math.round(bbox / TARGET_SPAN));
  }
  if (!Number.isInteger(cell) || cell < 1) usageError(`df-look: --cell must be a positive integer, got ${explicitCell}`);

  // A source whose longer side is already at or under this many pixels is
  // already near finished-sprite scale (see reduceImage's own
  // ALREADY_SPRITE_SCALE for the same convention) rather than a raw
  // 1024-class generator canvas: running crop/snap-grid on one of these, at
  // any cell, assumes a big canvas with a fake-pixel grid that isn't there.
  // Running it on an already-small source can crush it down to a few
  // pixels a side. Skip straight to whatever colour/despeckle passes were asked for.
  const ALREADY_SPRITE_SCALE = 64;
  if (Math.max(img.width, img.height) <= ALREADY_SPRITE_SCALE) {
    issues.push({ rule: 'reduce-already-sprite-scale', severity: 'info', message: `source is ${img.width}x${img.height}, already at or under sprite scale; skipping crop and snap-grid` });
  } else {

  // --finish: true-grid sample replaces crop + snap-grid. The
  // subject stays at native size (big ones become multi-tile); see true-grid.ts.
  let trueGridDone = false;
  if (finish) {
    const tg = trueGridSample(img);
    if (tg) {
      img = tg.img; trueGridDone = true;
      applied.push(`true-grid(p=${tg.period.toFixed(2)})`);
    } else issues.push({ rule: 'reduce-no-subject', severity: 'info', message: 'true-grid found no subject; falling back to crop' });
  }
  if (!trueGridDone && on('--crop')) {
    const bg = removeBackground(img, bgOpts);
    issues.push(...bg.issues);
    const cropped = cropToSubject(bg.img, 0, cell);
    issues.push(...cropped.issues);
    img = cropped.img;
    applied.push('crop');
  }
  if (!trueGridDone && on('--snap-grid')) { img = snapToGrid(img, cell); applied.push('snap-grid'); }
  }
  // --decast is not part of --finish: it, plus the old snap-to-vanilla
  // palette, was most of what muted colour relative to the input. Still
  // available standalone via --decast.
  if (argv.includes('--decast')) { img = deCast(img); applied.push('decast'); }
  if (on('--contrast')) { img = contrastLift(img, { lightness, chroma }); applied.push('contrast'); }
  if (argv.includes('--levels')) { img = levels(img); applied.push('levels'); }
  if (argv.includes('--quantize')) { img = quantize(img, { k, seed }); applied.push(`quantize(k=${k})`); }
  // --own-colours is the --finish default: keep
  // paletteAlign's clustering/denoise but skip the snap to vanilla's
  // palette, which is what muted colour on generated input (see
  // paletteAlign's own comment). Pass --snap-to-vanilla to restore the old
  // behaviour standalone.
  const ownColours = finish ? !argv.includes('--snap-to-vanilla') : argv.includes('--own-colours');
  if (finish || argv.includes('--palette-align')) { img = paletteAlign(img, palette, { k, seed, snapToVanilla: !ownColours }); applied.push(ownColours ? 'palette-align(own-colours)' : 'palette-align'); }
  if (argv.includes('--despeckle')) { img = despeckle(img); applied.push('despeckle'); }
  // Note: outline-repair walks the palette ramps, so it is a no-op on an
  // image whose colours are off-palette (anything after --quantize). Pair it
  // with --palette-align, not --quantize.
  if (finish) { img = edgeDarken(img); applied.push('edge-darken'); }
  else if (argv.includes('--outline-repair')) { img = repairOutline(img, palette); applied.push('outline-repair'); }

  writeFileSync(outPath, encodePng(img));
  let colours = new Set<string>();
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const c = getPixelAt(img, x, y);
    if (c) colours.add(c);
  }
  if (json) console.log(JSON.stringify({ applied, width: img.width, height: img.height, colours: colours.size, issues, out: outPath }, null, 1));
  else {
    for (const i of issues) printIssue(file, i);
    console.log(`${applied.length ? applied.join(', ') : 'no passes selected'} -> ${outPath} (${img.width}x${img.height}, ${colours.size} colours)`);
  }
  process.exit(0);
}

function getPixelAt(img: { width: number; height: number; data: Uint8Array | Uint8ClampedArray }, x: number, y: number): string | null {
  const i = (y * img.width + x) * 4;
  return img.data[i + 3] === 0 ? null : `${img.data[i]},${img.data[i + 1]},${img.data[i + 2]}`;
}

// Side-by-side contact sheet at a shared logical scale, zoomed with nearest
// neighbour onto a neutral backing. A sprite at 18x32 cannot be judged at
// 18x32, and "studio check exits 0" says nothing about whether a sprite looks
// like DF art — the only test that matters here is a person looking at the
// result next to vanilla. Vanilla reference sprites still on the generator's
// 8x canvas are reduced the same way (--cell) so both sides are compared at
// the same logical size.
const RAW_CANVAS_MIN = 64;
function runCompare(): void {
  const files = positionals(argv.slice(1));
  if (files.length < 1) usageError('compare <png...> --out <path> [--cell n] [--zoom n=12]');
  const outPath = flagValue(argv, '--out');
  if (!outPath) usageError('compare: --out <path> is required');
  const zoom = Number(flagValue(argv, '--zoom') ?? 12);
  const cellFlag = flagValue(argv, '--cell');
  const cell = cellFlag === undefined ? 0 : Number(cellFlag);

  const panels = files.map(f => {
    if (!existsSync(f)) usageError(`${f}: not found`);
    let img = decodePng(new Uint8Array(readFileSync(f)));
    // --cell reduces raw generator canvases so they sit beside an
    // already-finished sprite at the same logical size. Only images bigger
    // than RAW_CANVAS_MIN are treated as raw: a finished sprite is at most a
    // tile or two across, so without this guard passing --cell would reduce
    // the finished sprites a second time and shrink them to a few pixels.
    if (cell > 1 && Math.min(img.width, img.height) > RAW_CANVAS_MIN) {
      img = snapToGrid(cropToSubject(removeBackground(img).img, 0, cell).img, cell);
    }
    return { name: basename(f), img };
  });

  const GAP = 6;
  const height = Math.max(...panels.map(p => p.img.height));
  const width = panels.reduce((s, p) => s + p.img.width, 0);
  const sheet = createImage(width * zoom + GAP * (panels.length + 1), height * zoom + GAP * 2);
  for (let y = 0; y < sheet.height; y++) for (let x = 0; x < sheet.width; x++) setPixel(sheet, x, y, [30, 30, 34, 255]);

  let ox = GAP;
  for (const { name, img } of panels) {
    const oy = GAP + (height - img.height) * zoom;   // bottom-aligned, as sprites stand on a floor
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const c = getPixel(img, x, y);
        if (c[3] === 0) continue;
        for (let dy = 0; dy < zoom; dy++) for (let dx = 0; dx < zoom; dx++) setPixel(sheet, ox + x * zoom + dx, oy + y * zoom + dy, c);
      }
    }
    console.log(`${name}  ${img.width}x${img.height}`);
    ox += img.width * zoom + GAP;
  }
  writeFileSync(outPath, encodePng(sheet));
  console.log(`-> ${outPath} (${sheet.width}x${sheet.height})`);
  process.exit(0);
}

async function runGenerate(): Promise<void> {
  const [given] = positionals(argv.slice(1));
  const fromImage = flagValue(argv, '--from');
  const outDir = flagValue(argv, '--out');
  if ((!given && !fromImage) || !outDir) usageError('generate "<description>" | --from <image> --out <folder> [--count n=4] [--seed n] [--size px] [--lora file] [--comfy url] [--ollama url] [--json]');
  const count = Number(flagValue(argv, '--count') ?? 4);
  const seed0 = Number(flagValue(argv, '--seed') ?? Math.floor(Math.random() * 2 ** 31));
  const size = Number(flagValue(argv, '--size') ?? DEFAULT_GENERATE.size);
  const lora = flagValue(argv, '--lora') ?? DEFAULT_GENERATE.lora;
  const ollama = (flagValue(argv, '--ollama') ?? process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
  const comfy = (flagValue(argv, '--comfy') ?? process.env.COMFY_URL ?? 'http://127.0.0.1:8188').replace(/\/$/, '');
  let cell: number;
  try { cell = cellFor(size); } catch (e) { usageError(`generate: ${(e as Error).message}`); }
  if (!Number.isInteger(count) || count < 1) usageError('generate: --count must be a positive integer');
  mkdirSync(outDir, { recursive: true });

  let description = given ?? '';
  if (fromImage) {
    if (!existsSync(fromImage)) usageError(`${fromImage}: not found`);
    const b64 = Buffer.from(readFileSync(fromImage)).toString('base64');
    const res = await fetch(`${ollama}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildCaptionRequest(b64)) });
    if (!res.ok) usageError(`generate: Ollama failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    try { description = [parseCaption(await res.json()), given].filter(Boolean).join(', '); } catch (e) { usageError((e as Error).message); }
    console.log(`caption: ${description}`);
  }
  const prompt = buildPrompt(description);
  const palette = loadVanillaPalette();
  const stats = loadVanillaStats();
  const style = loadVanillaStyle();
  const results: { seed: number; raw: string; reduced: string; issues: Issue[] }[] = [];

  for (let i = 0; i < count; i++) {
    const seed = seed0 + i;
    const res = await fetch(`${comfy}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: buildWorkflow(prompt, seed, { size, lora }) }) });
    if (!res.ok) usageError(`generate: ComfyUI rejected the prompt (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const promptId = ((await res.json()) as { prompt_id: string }).prompt_id;
    const t0 = Date.now();
    let done;
    for (;;) {
      const hist = await (await fetch(`${comfy}/history/${promptId}`)).json();
      const r = parseHistory(hist, promptId);
      if (r.state === 'error') usageError(`generate: ${r.message}`);
      if (r.state === 'done') { done = r.image; break; }
      if (Date.now() - t0 > 900_000) usageError('generate: timed out');
      await new Promise(r => setTimeout(r, 2000));
    }
    const bytes = new Uint8Array(await (await fetch(`${comfy}/view?${viewQuery(done)}`)).arrayBuffer());
    const raw = join(outDir, `seed${seed}-raw.png`);
    writeFileSync(raw, bytes);
    const red = reduceImage(decodePng(bytes), palette, { cell, stats });
    const reduced = join(outDir, `seed${seed}.png`);
    writeFileSync(reduced, encodePng(red.img));
    const issues = [...red.issues, ...checkSprite(red.img, { token: 'DEFAULT', palette, locked: true, style, floors: style.floors, guide: stats ? proportionGuide(stats, { token: 'DEFAULT' }) : undefined })];
    results.push({ seed, raw, reduced, issues });
  }

  const ranked = rankCandidates(results).map(r => ({ ...r, ...results.find(x => x.seed === r.seed)! }));
  if (json) console.log(JSON.stringify({ prompt, ranked }, null, 1));
  else ranked.forEach((r, n) => {
    console.log(`#${n + 1} seed ${r.seed} score ${r.score}${r.rejected ? ` REJECTED (${r.reason})` : ''}: ${r.reduced}`);
    for (const i of r.issues) printIssue(r.reduced, i);
  });
  process.exit(ranked.every(r => r.rejected) ? 1 : 0);
}

switch (command) {
  case 'find-missing': runFindMissing(); break;
  case 'validate': runValidate(); break;
  case 'check': runCheck(); break;
  case 'draft': runDraft(); break;
  case 'reduce': runReduce(); break;
  case 'df-look': runDfLook(); break;
  case 'compare': runCompare(); break;
  case 'generate': await runGenerate(); break;
  default: usageError('Usage: node tools/studio.ts <find-missing|validate|check|draft|reduce|df-look|compare|generate> ... [--json] [--df <path>]');
}
