// One undo stack: undo lives in the app, not the engine.
// The Store keeps one instance per open document, so
// switching documents never touches another document's stack. An entry
// stores its own inverse rather than a diff, so undo/redo never has to
// recompute one.

export type HistoryEntry = { label: string; undo: () => void; redo: () => void };

const MAX_ENTRIES = 256;

export class History {
  #undoStack: HistoryEntry[] = [];
  #redoStack: HistoryEntry[] = [];

  push(entry: HistoryEntry): void {
    this.#undoStack.push(entry);
    if (this.#undoStack.length > MAX_ENTRIES) this.#undoStack.shift();
    this.#redoStack = [];
  }

  undo(): boolean {
    const entry = this.#undoStack.pop();
    if (!entry) return false;
    entry.undo();
    this.#redoStack.push(entry);
    return true;
  }

  redo(): boolean {
    const entry = this.#redoStack.pop();
    if (!entry) return false;
    entry.redo();
    this.#undoStack.push(entry);
    return true;
  }

  get canUndo(): boolean { return this.#undoStack.length > 0; }
  get canRedo(): boolean { return this.#redoStack.length > 0; }
}
