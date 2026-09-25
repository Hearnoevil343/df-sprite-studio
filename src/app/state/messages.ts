// Shared "nothing to work on" message for panels that need a single-tile
// template entry open (AI, Checker). Opening a layered creature clears
// ui.selection with no visible cause, so a bare "Open a single-tile entry
// first." left a modder guessing; naming the layered creature and what to
// do about it replaces that guess.
import type { Ui } from './store.ts';

export function noEntryOpenMessage(ui: Ui, fallback = 'Open a single-tile entry first.'): string {
  if (ui.layered) {
    const name = ui.lastTemplateSelection?.id ?? ui.layered.creatureId;
    return `A layered creature is open; close it (Sprites panel) to return to ${name}.`;
  }
  return fallback;
}
