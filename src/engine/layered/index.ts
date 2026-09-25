export { defaultFigure, pickSet } from './figure.ts';
export type { Figure, TissueState, WornItem } from './figure.ts';
export { composite, evaluateGroup, evaluateLayer, evaluateSet } from './evaluate.ts';
export type { Composite, Draw, GroupResult, Verdict } from './evaluate.ts';
export { addPaletteRow, buildPageImages, paletteRow, readTile, renderComposite, swapPalette, tileRect, writeTile } from './pixels.ts';
export type { PageImage, PageImages, Rendered } from './pixels.ts';
