// Engine entry point. No Node or DOM imports anywhere under src/engine.
export { decodeBytes, encodeString, serialize, tokenize, tokenString } from './raw/tokenize.ts';
export type { RawNode, TextNode, TokenNode } from './raw/tokenize.ts';
export { BLOCK_HEADERS, CREATURE_HEADERS, CreatureGraphics, RawDocument, TilePage } from './raw/document.ts';
export type { Block } from './raw/document.ts';
export { addLayer, layeredTokens, readLayered, setPaletteDefaultRow } from './raw/layers.ts';
// Layer is also the image compositing type, so the layered one is exported as LayeredLayer.
export type { Condition, Layer as LayeredLayer, LayerGroup, LayerRef, LayerSet, LayeredGraphics, LsPalette, TemplateUse } from './raw/layers.ts';
export { readCreatures } from './raw/creatures.ts';
export type { CreatureDef } from './raw/creatures.ts';
export { TEMPLATES, activeEntries, applyTemplate, buildTemplate, resolveEntries, templateById } from './templates/template.ts';
export type { EntrySizes, ResolvedEntry, SpriteTemplate, TemplateEntry, TemplateParams } from './templates/template.ts';
export { paletteCounts, spriteProportions } from './stats/sheet-stats.ts';
export type { Box, SpriteProportions } from './stats/sheet-stats.ts';
export { MIN_GROUP_SPRITES, proportionGuide } from './stats/guide.ts';
export type { ProportionGuide, StatBand, StatGroup, VanillaStats } from './stats/guide.ts';
export { bottomAlign, cloneImage, compose, createImage, crop, downscale, drawLine, drawRectOutline, fitReference, flip, floodFill, getPixel, inBounds, lightHints, mirror, outline, resizeAnchored, rotate90, samePixel, setPixel, stamp } from './image/index.ts';
export type { Layer, LightDir, Rgba, RgbaImage } from './image/index.ts';
export { buildRamps, kmeansOklab, mulberry32, nearest, offPalette, oklabDistSq, oklabToOklch, oklabToRgb, oklchToOklab, rampStep, rgbToOklab, snapToPalette, weightedPick } from './palette/index.ts';
export type { Oklab, Oklch, Palette } from './palette/index.ts';
export { DEFAULT_CHILD_RATIO, DEFAULT_FOOT_BASELINE, draftPlan, draftVariant } from './draft/index.ts';
export type { DraftKind, DraftOptions, DraftStep } from './draft/index.ts';
export { TILE, isBlank, packSheet, sliceSheet, spriteRects, templateFootprint, tileGraphicsRects, tileSpan } from './sheet/index.ts';
export type { PackedSheet, SheetCreature, SpriteRect, TileGraphicsRect } from './sheet/index.ts';
export { STUDIO_FILE, changedPageFiles, creaturesRaw, infoTxt, layeredPageFilePaths, layeredRawFiles, modFiles, modId, modPaths, modTilePages, numericVersion, parseInfoTxt, previewImage, readMod, tokenText } from './mod/index.ts';
export type { LayeredCreature, ModCreature, ModFile, ModInfo, ModProject, ReadModResult } from './mod/index.ts';
export type { Issue, Severity } from './check/issue.ts';
export { findMissingArt, suggestTemplate } from './find/missing.ts';
export type { MissingArt, ModSource } from './find/missing.ts';
export { validateMod, validateMods } from './check/validate.ts';
export type { VanillaIndex } from './check/validate.ts';
export {
  LIGHT_L, MIN_STYLE_SPRITES, STRAY_MAX_ISLAND, checkSprite, edgePixels, floorCloseness, lightEdges, strayPixels, styleMetrics,
} from './check/style.ts';
export type { EdgePixel, FloorBand, StyleBand, StyleContext, StyleMetrics, StyleTokenBands, VanillaStyle } from './check/style.ts';
export {
  DEFAULT_CAST_HUE, DEFAULT_TOLERANCE, MAX_CELL, MIN_CELL, contrastLift, cropToSubject, deCast, despeckle, detectCell, levels, paletteAlign, quantize,
  reduceBatch, reduceImage, removeBackground, repairOutline, snapToGrid, trueGridSample, edgeDarken,
} from './reduce/index.ts';
export type { BatchFile, BatchOptions, ContrastLiftOptions, DeCastOptions, LevelsOptions, PaletteAlignOptions, QuantizeOptions, ReduceOptions } from './reduce/index.ts';
export * from './ai/index.ts';
export { addPaletteRow, buildPageImages, composite, defaultFigure, paletteRow, readTile, renderComposite, swapPalette, tileRect, writeTile, evaluateGroup, evaluateLayer, evaluateSet, pickSet } from './layered/index.ts';
export type { Composite, Draw, Figure, PageImage, PageImages, Rendered, GroupResult, TissueState, Verdict, WornItem } from './layered/index.ts';
