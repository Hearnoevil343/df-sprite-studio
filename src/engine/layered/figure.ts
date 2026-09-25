// The figure a layered creature is drawn for: the choices the preview panel
// makes (caste, age, profession, worn items, hair...) that layer conditions are
// tested against. Plain data, no raws inside.
import type { LayerSet, LayeredGraphics } from '../raw/layers.ts';

// One worn or held item. `mode` is BY_CATEGORY or BY_TOKEN; `part` is the body
// part category or token (HEAD, RH); `type` the item type (HELM, WEAPON).
export type WornItem = {
  mode: string;
  part: string;
  type: string;
  item: string;                 // item token, e.g. ITEM_HELM_HELM
  materialFlags?: string[];     // e.g. WOVEN_ITEM, ANY_WOOD_MATERIAL, IS_CRAFTED_ARTIFACT
  materialType?: string;        // e.g. INORGANIC
};

// One tissue layer the figure has. `part` is a category or token (HEAD) and
// `tissue` the layer (HAIR, SKIN, CHIN_WHISKERS).
export type TissueState = { part: string; tissue: string; color?: string; length?: number; shaping?: string };

export type Figure = {
  state: string;                            // layer set state: DEFAULT, PORTRAIT, ...
  age: 'adult' | 'child' | 'baby';
  caste?: string;
  ghost: boolean;
  synClasses: string[];
  professionCategory?: string;
  worn: WornItem[];
  tissues: TissueState[];
  randomPartIndex: Record<string, number>;  // 1-based, by id: { HEAD: 2 }
};

export function defaultFigure(over: Partial<Figure> = {}): Figure {
  return { state: 'DEFAULT', age: 'adult', ghost: false, synClasses: [], worn: [], tissues: [], randomPartIndex: { HEAD: 1 }, ...over };
}

// The layer set that draws this figure: the one for its age stage and state,
// else the unstaged one. PORTRAIT sets are chosen only when asked for by state.
export function pickSet(lg: LayeredGraphics, fig: Figure): LayerSet | undefined {
  const stage = fig.age === 'adult' ? undefined : (fig.age.toUpperCase() as 'BABY' | 'CHILD');
  return lg.sets.find(s => s.stage === stage && s.state === fig.state)
    ?? lg.sets.find(s => !s.stage && s.state === fig.state);
}
