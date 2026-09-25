import { cloneImage, crop, drawLine, drawRectOutline, fitReference, floodFill, getPixel, inBounds, proportionGuide, setPixel, stamp } from '../../engine/index.ts';
import type { Rgba, RgbaImage, VanillaStats } from '../../engine/index.ts';
import type { HistoryEntry } from '../state/history.ts';
import type { AppState, Marquee, Store } from '../state/store.ts';

const CHECKER_LIGHT = '#3a3a3a';
const CHECKER_DARK = '#2c2c2c';
const GRID_LINE = 'rgba(255, 255, 255, 0.15)';
const GUIDE_BAND = 'rgba(80, 200, 255, 0.18)';
const GUIDE_LINE = 'rgba(80, 200, 255, 0.9)';
const GUIDE_HEAD = 'rgba(255, 200, 60, 0.85)';
const GUIDE_FOOT = 'rgba(255, 90, 90, 0.9)';
const HOVER_LINE = 'rgba(255, 255, 255, 0.6)';
const STYLE_OVERLAY = 'rgba(255, 60, 60, 0.55)';
const TILE_LINE = 'rgba(255, 255, 255, 0.25)';
const TILE_PX = 32;
const CLEAR: Rgba = [0, 0, 0, 0];

export type CanvasView = {
  render: () => void;
  // Move-tool lifecycle, driven by main.ts's keyboard shortcuts and tool
  // switches -- kept here since only canvas.ts holds moveBefore, the
  // pre-lift snapshot a commit/delete needs for its undo entry.
  commitFloating: () => void;
  cancelFloating: () => void;
  pasteFloating: (image: RgbaImage, x: number, y: number) => void;
  deleteSelection: () => void;
};

function inRect(r: Marquee, x: number, y: number): boolean {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

export function createCanvasView(store: Store, canvas: HTMLCanvasElement, stats?: VanillaStats): CanvasView {
  const context2d = canvas.getContext('2d');
  if (!context2d) throw new Error('2D context unavailable');
  const ctx: CanvasRenderingContext2D = context2d;
  ctx.imageSmoothingEnabled = false;

  let strokeBefore: Uint8ClampedArray | null = null;
  let strokeDirty = false;
  let pointerDown = false;

  // Move-tool state. moveBefore is the sprite snapshot from just
  // before the lift, kept until commit/cancel/delete so undo has an inverse;
  // liftedFrom is the marquee rect the pixels were lifted from, restored as
  // the selection on cancel. antsPhase drives the marching-ants dash offset.
  let moveBefore: Uint8ClampedArray | null = null;
  let liftedFrom: Marquee | null = null;
  let marqueeStart: { x: number; y: number } | null = null;
  let moveDragOffset: { x: number; y: number } | null = null;
  let antsPhase = 0;

  // fitReference is nearest-neighbour work over the whole reference image, so
  // it's memoized against the exact (image, target size) it was last run
  // for, rather than redone on every render.
  let fitCache: { src: RgbaImage; w: number; h: number; out: RgbaImage } | null = null;
  function fittedRef(ref: RgbaImage, w: number, h: number): RgbaImage {
    if (fitCache && fitCache.src === ref && fitCache.w === w && fitCache.h === h) return fitCache.out;
    const out = fitReference(ref, w, h);
    fitCache = { src: ref, w, h, out };
    return out;
  }

  // Scale-to-fit: canvas.width/height stay the sprite's
  // true pixel size at the chosen zoom (so drawing math is exact), but the
  // element's CSS size is clamped to whatever room its container actually
  // has, so a narrow dock panel shrinks the display instead of the canvas
  // vanishing past the edge of the window. pixelAt() below already maps
  // through getBoundingClientRect(), which reflects the CSS size, so no
  // click-mapping change is needed for the scaled-down case.
  function fitToContainer(): void {
    const parent = canvas.parentElement;
    if (!parent) return;
    const availW = parent.clientWidth;
    const availH = parent.clientHeight;
    if (!availW || !availH || !canvas.width || !canvas.height) return;
    const scale = Math.min(1, availW / canvas.width, availH / canvas.height);
    canvas.style.width = `${Math.max(1, Math.round(canvas.width * scale))}px`;
    canvas.style.height = `${Math.max(1, Math.round(canvas.height * scale))}px`;
  }
  if (canvas.parentElement && 'ResizeObserver' in window) {
    new ResizeObserver(fitToContainer).observe(canvas.parentElement);
  }

  function render(): void {
    const { project, ui } = store.get();
    const { sprite } = project;
    const zoom = ui.zoom;
    canvas.width = sprite.width * zoom;
    canvas.height = sprite.height * zoom;

    const ref = ui.reference?.onionSkin ? fittedRef(ui.reference.image, sprite.width, sprite.height) : null;

    for (let y = 0; y < sprite.height; y++) {
      for (let x = 0; x < sprite.width; x++) {
        const [r, g, b, a] = getPixel(sprite, x, y);
        if (a < 255) {
          ctx.fillStyle = (x + y) % 2 === 0 ? CHECKER_LIGHT : CHECKER_DARK;
          ctx.fillRect(x * zoom, y * zoom, zoom, zoom);
        }
        if (a < 255 && ref && inBounds(ref, x, y)) {
          const [rr, rg, rb, ra] = getPixel(ref, x, y);
          if (ra > 0) {
            ctx.fillStyle = `rgba(${rr}, ${rg}, ${rb}, ${(ra / 255) * ui.reference!.onionOpacity})`;
            ctx.fillRect(x * zoom, y * zoom, zoom, zoom);
          }
        }
        if (a > 0) {
          ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a / 255})`;
          ctx.fillRect(x * zoom, y * zoom, zoom, zoom);
        }
      }
    }

    if (ui.showGrid && zoom >= 4) {
      ctx.strokeStyle = GRID_LINE;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= sprite.width; x++) {
        ctx.moveTo(x * zoom + 0.5, 0);
        ctx.lineTo(x * zoom + 0.5, sprite.height * zoom);
      }
      for (let y = 0; y <= sprite.height; y++) {
        ctx.moveTo(0, y * zoom + 0.5);
        ctx.lineTo(sprite.width * zoom, y * zoom + 0.5);
      }
      ctx.stroke();
    }

    // A faint boundary every 32px on multi-tile entries, so a resized entry
    // shows where DF's own tile grid falls. Separate
    // from the pixel grid above, and shown regardless of showGrid/zoom since
    // it doesn't get busy at any zoom level.
    if (sprite.width > TILE_PX || sprite.height > TILE_PX) {
      ctx.strokeStyle = TILE_LINE;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = TILE_PX; x < sprite.width; x += TILE_PX) {
        ctx.moveTo(x * zoom + 0.5, 0);
        ctx.lineTo(x * zoom + 0.5, sprite.height * zoom);
      }
      for (let y = TILE_PX; y < sprite.height; y += TILE_PX) {
        ctx.moveTo(0, y * zoom + 0.5);
        ctx.lineTo(sprite.width * zoom, y * zoom + 0.5);
      }
      ctx.stroke();
    }

    if (ui.guide.show && stats) drawGuide(ui.guide.page, ui.guide.token, zoom);
    if (ui.styleOverlay) {
      ctx.fillStyle = STYLE_OVERLAY;
      for (const p of ui.styleOverlay) ctx.fillRect(p.x * zoom, p.y * zoom, zoom, zoom);
    }

    // Floating (Move-tool) layer drawn over the sprite it was lifted from
    // (whose hole is already transparent underneath), then the marching-ants
    // selection outline follows the floating rect while one is active, or
    // the plain marquee otherwise.
    if (ui.floating) {
      const { image, x: fx, y: fy } = ui.floating;
      for (let y = 0; y < image.height; y++) {
        const dy = fy + y;
        if (dy < 0 || dy >= sprite.height) continue;
        for (let x = 0; x < image.width; x++) {
          const dx = fx + x;
          if (dx < 0 || dx >= sprite.width) continue;
          const [r, g, b, a] = getPixel(image, x, y);
          if (a === 0) continue;
          ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a / 255})`;
          ctx.fillRect(dx * zoom, dy * zoom, zoom, zoom);
        }
      }
    }
    const selRect = ui.floating
      ? { x: ui.floating.x, y: ui.floating.y, w: ui.floating.image.width, h: ui.floating.image.height }
      : ui.marquee;
    if (selRect) drawSelectionOutline(selRect, zoom);

    if (ui.hover) {
      ctx.strokeStyle = HOVER_LINE;
      ctx.lineWidth = 1;
      ctx.strokeRect(ui.hover.x * zoom + 0.5, ui.hover.y * zoom + 0.5, zoom - 1, zoom - 1);
    }
    fitToContainer();
  }

  function drawSelectionOutline(rect: { x: number; y: number; w: number; h: number }, zoom: number): void {
    ctx.save();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.lineDashOffset = -antsPhase;
    ctx.strokeRect(rect.x * zoom + 0.5, rect.y * zoom + 0.5, rect.w * zoom - 1, rect.h * zoom - 1);
    ctx.restore();
  }

  function drawGuide(page: string | undefined, token: string | undefined, zoom: number): void {
    const g = proportionGuide(stats!, { page, token });
    const rect = (x0: number, y0: number, x1: number, y1: number) =>
      [x0 * zoom, y0 * zoom, (x1 - x0) * zoom, (y1 - y0) * zoom] as const;

    ctx.fillStyle = GUIDE_BAND;
    ctx.fillRect(...rect(g.band.x0[0], g.band.y0[0], g.band.x1[1], g.band.y1[1]));

    ctx.strokeStyle = GUIDE_LINE;
    ctx.lineWidth = 1;
    ctx.strokeRect(...rect(g.bbox.x, g.bbox.y, g.bbox.x + g.bbox.w, g.bbox.y + g.bbox.h));

    if (g.head) {
      ctx.strokeStyle = GUIDE_HEAD;
      ctx.strokeRect(...rect(g.head.x, g.head.y, g.head.x + g.head.w, g.head.y + g.head.h));
    }

    ctx.strokeStyle = GUIDE_FOOT;
    ctx.beginPath();
    ctx.moveTo(0, (g.footBaseline + 1) * zoom);
    ctx.lineTo(canvas.width, (g.footBaseline + 1) * zoom);
    ctx.stroke();
  }

  function pixelAt(ev: PointerEvent): { x: number; y: number } | null {
    const { project, ui } = store.get();
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(((ev.clientX - rect.left) / rect.width) * project.sprite.width);
    const y = Math.floor(((ev.clientY - rect.top) / rect.height) * project.sprite.height);
    return inBounds(project.sprite, x, y) ? { x, y } : null;
  }

  // Unclamped pixel coordinates, for marquee/move drags -- unlike pixelAt,
  // these stay usable once the pointer strays past the sprite's edge, so a
  // selection can be dragged (and later clipped) past the canvas boundary.
  function rawPixelAt(ev: PointerEvent): { x: number; y: number } {
    const { project } = store.get();
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(((ev.clientX - rect.left) / rect.width) * project.sprite.width);
    const y = Math.floor(((ev.clientY - rect.top) / rect.height) * project.sprite.height);
    return { x, y };
  }

  function clampToSprite(p: { x: number; y: number }, sprite: RgbaImage): { x: number; y: number } {
    return { x: Math.max(0, Math.min(sprite.width - 1, p.x)), y: Math.max(0, Math.min(sprite.height - 1, p.y)) };
  }

  function rectFromPoints(a: { x: number; y: number }, b: { x: number; y: number }): Marquee {
    const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
    const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
    return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  // Square brush, 1-4px, shared by Pencil and the
  // eraser -- the eraser is the same square stamp with a transparent colour.
  // Clipped to the marquee selection when one exists.
  function paint(state: AppState, x: number, y: number): void {
    const { sprite } = state.project;
    const sel = state.ui.marquee;
    const colour = state.ui.tool === 'eraser' ? CLEAR : state.ui.colour;
    const size = Math.max(1, Math.min(4, state.ui.brushSize));
    const half = Math.floor((size - 1) / 2);
    for (let oy = 0; oy < size; oy++) {
      for (let ox = 0; ox < size; ox++) {
        const px = x - half + ox, py = y - half + oy;
        if (!inBounds(sprite, px, py)) continue;
        if (sel && !inRect(sel, px, py)) continue;
        setPixel(sprite, px, py, colour);
        if (state.ui.mirrorX) {
          const mx = sprite.width - 1 - px;
          if (!sel || inRect(sel, mx, py)) setPixel(sprite, mx, py, colour);
        }
      }
    }
    strokeDirty = true;
  }

  // Line/rectangle drag preview: restores the pointer-down snapshot each move
  // and redraws the shape from dragStart to the current point, so it behaves
  // like a live rubber band without needing its own undo bookkeeping --
  // pointerup's endStroke() captures the final before/after exactly like a
  // pencil stroke does.
  let dragStart: { x: number; y: number } | null = null;

  function shapeEndpoint(state: AppState, p: { x: number; y: number }, shiftKey: boolean): { x: number; y: number } {
    if (!dragStart || !shiftKey) return p;
    const dx = p.x - dragStart.x, dy = p.y - dragStart.y;
    if (state.ui.tool === 'rect') {
      const s = Math.max(Math.abs(dx), Math.abs(dy));
      return { x: dragStart.x + Math.sign(dx || 1) * s, y: dragStart.y + Math.sign(dy || 1) * s };
    }
    const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    const dist = Math.hypot(dx, dy);
    return { x: Math.round(dragStart.x + Math.cos(angle) * dist), y: Math.round(dragStart.y + Math.sin(angle) * dist) };
  }

  function drawShapePreview(ev: PointerEvent): void {
    const p = pixelAt(ev);
    if (!p || !dragStart || !strokeBefore) return;
    const state = store.get();
    const { sprite } = state.project;
    sprite.data.set(strokeBefore);
    const end = shapeEndpoint(state, p, ev.shiftKey);
    const changed = state.ui.tool === 'rect'
      ? drawRectOutline(sprite, dragStart.x, dragStart.y, end.x, end.y, state.ui.colour)
      : drawLine(sprite, dragStart.x, dragStart.y, end.x, end.y, state.ui.colour);
    if (state.ui.mirrorX) {
      for (const px of changed) {
        const mx = sprite.width - 1 - px.x;
        if (mx !== px.x) setPixel(sprite, mx, px.y, state.ui.colour);
      }
    }
    strokeDirty = true;
    store.notify();
  }

  function applyTool(ev: PointerEvent): void {
    const p = pixelAt(ev);
    if (!p) return;
    const state = store.get();
    const { sprite } = state.project;
    switch (state.ui.tool) {
      case 'pencil':
      case 'eraser':
        paint(state, p.x, p.y);
        break;
      case 'fill': {
        const sel = state.ui.marquee;
        const changed = floodFill(sprite, p.x, p.y, state.ui.colour);
        if (sel && strokeBefore) restoreOutsideSelection(sprite, changed, sel, strokeBefore);
        if (state.ui.mirrorX) {
          for (const px of changed) {
            const mx = sprite.width - 1 - px.x;
            if (mx !== px.x) {
              const mirrored = floodFill(sprite, mx, px.y, state.ui.colour);
              if (sel && strokeBefore) restoreOutsideSelection(sprite, mirrored, sel, strokeBefore);
            }
          }
        }
        if (changed.length) strokeDirty = true;
        break;
      }
      case 'picker': {
        const c = getPixel(sprite, p.x, p.y) as Rgba;
        store.update(s => { s.ui.colour = c; });
        return;
      }
    }
    store.notify();
  }

  function pushHistory(label: string, before: Uint8ClampedArray, after: Uint8ClampedArray): void {
    const entry: HistoryEntry = {
      label,
      undo: () => { store.get().project.sprite.data.set(before); store.notify(); },
      redo: () => { store.get().project.sprite.data.set(after); store.notify(); },
    };
    store.update(() => {}, entry);
  }

  function endStroke(): void {
    if (!pointerDown) return;
    pointerDown = false;
    const before = strokeBefore;
    strokeBefore = null;
    if (!before || !strokeDirty) return;
    strokeDirty = false;
    const after = store.get().project.sprite.data.slice() as Uint8ClampedArray;
    pushHistory(store.get().ui.tool, before, after);
  }

  // Flood fill has no notion of a selection boundary, so let it run and then
  // put back whatever it changed outside the marquee, using the snapshot
  // taken at the start of the stroke.
  function restoreOutsideSelection(sprite: RgbaImage, changed: { x: number; y: number }[], sel: Marquee, before: Uint8ClampedArray): void {
    for (const p of changed) {
      if (inRect(sel, p.x, p.y)) continue;
      const i = (p.y * sprite.width + p.x) * 4;
      sprite.data[i] = before[i]; sprite.data[i + 1] = before[i + 1]; sprite.data[i + 2] = before[i + 2]; sprite.data[i + 3] = before[i + 3];
    }
  }

  function clearRect(sprite: RgbaImage, r: Marquee): void {
    for (let y = 0; y < r.h; y++) {
      for (let x = 0; x < r.w; x++) {
        if (inBounds(sprite, r.x + x, r.y + y)) setPixel(sprite, r.x + x, r.y + y, CLEAR);
      }
    }
  }

  // Move tool. First drag with a marquee active lifts its
  // pixels into ui.floating (and clears the hole they leave behind);
  // further drags just reposition the already-lifted floating layer.
  function beginOrDragMove(ev: PointerEvent, state: AppState): void {
    const p = rawPixelAt(ev);
    canvas.setPointerCapture(ev.pointerId);
    if (!state.ui.floating) {
      const sel = state.ui.marquee;
      if (!sel) return;
      moveBefore = state.project.sprite.data.slice() as Uint8ClampedArray;
      liftedFrom = sel;
      const lifted = crop(state.project.sprite, sel);
      clearRect(state.project.sprite, sel);
      store.update(s => { s.ui.floating = { x: sel.x, y: sel.y, image: lifted }; });
    }
    pointerDown = true;
    const floating = store.get().ui.floating!;
    moveDragOffset = { x: p.x - floating.x, y: p.y - floating.y };
  }

  function commitFloating(): void {
    const state = store.get();
    const { floating } = state.ui;
    if (!floating) return;
    stamp(state.project.sprite, floating.x, floating.y, floating.image);
    const before = moveBefore;
    moveBefore = null;
    liftedFrom = null;
    const newSel: Marquee = { x: floating.x, y: floating.y, w: floating.image.width, h: floating.image.height };
    store.update(s => { s.ui.floating = null; s.ui.marquee = newSel; });
    if (before) pushHistory('move', before, store.get().project.sprite.data.slice() as Uint8ClampedArray);
  }

  function cancelFloating(): void {
    const state = store.get();
    if (!state.ui.floating) return;
    if (moveBefore) state.project.sprite.data.set(moveBefore);
    const restoredSel = liftedFrom;
    moveBefore = null;
    liftedFrom = null;
    store.update(s => { s.ui.floating = null; s.ui.marquee = restoredSel; });
  }

  function pasteFloating(image: RgbaImage, x: number, y: number): void {
    commitFloating();
    moveBefore = store.get().project.sprite.data.slice() as Uint8ClampedArray;
    liftedFrom = null;
    const pasted = cloneImage(image);
    store.update(s => { s.ui.tool = 'move'; s.ui.floating = { x, y, image: pasted }; s.ui.marquee = { x, y, w: pasted.width, h: pasted.height }; });
  }

  function deleteSelection(): void {
    const state = store.get();
    if (state.ui.floating) {
      const before = moveBefore;
      moveBefore = null;
      liftedFrom = null;
      store.update(s => { s.ui.floating = null; });
      if (before) pushHistory('delete', before, store.get().project.sprite.data.slice() as Uint8ClampedArray);
      return;
    }
    const sel = state.ui.marquee;
    if (!sel) return;
    const before = state.project.sprite.data.slice() as Uint8ClampedArray;
    clearRect(state.project.sprite, sel);
    const after = state.project.sprite.data.slice() as Uint8ClampedArray;
    store.notify();
    pushHistory('delete', before, after);
  }

  canvas.addEventListener('pointerdown', ev => {
    const state = store.get();
    if (state.ui.tool === 'picker') { applyTool(ev); return; }
    if (state.ui.tool === 'marquee') {
      const p0 = pixelAt(ev);
      if (!p0) return;
      commitFloating();
      pointerDown = true;
      canvas.setPointerCapture(ev.pointerId);
      marqueeStart = p0;
      store.update(s => { s.ui.marquee = { x: p0.x, y: p0.y, w: 1, h: 1 }; });
      return;
    }
    if (state.ui.tool === 'move') {
      beginOrDragMove(ev, state);
      return;
    }
    pointerDown = true;
    strokeDirty = false;
    strokeBefore = state.project.sprite.data.slice() as Uint8ClampedArray;
    canvas.setPointerCapture(ev.pointerId);
    if (state.ui.tool === 'line' || state.ui.tool === 'rect') {
      dragStart = pixelAt(ev);
    } else {
      applyTool(ev);
    }
  });
  canvas.addEventListener('pointermove', ev => {
    if (pointerDown) {
      const state = store.get();
      const tool = state.ui.tool;
      if (tool === 'marquee' && marqueeStart) {
        const r = rectFromPoints(marqueeStart, clampToSprite(rawPixelAt(ev), state.project.sprite));
        store.update(s => { s.ui.marquee = r; });
      } else if (tool === 'move' && moveDragOffset) {
        const p = rawPixelAt(ev);
        const nx = p.x - moveDragOffset.x, ny = p.y - moveDragOffset.y;
        store.update(s => { if (s.ui.floating) { s.ui.floating.x = nx; s.ui.floating.y = ny; } });
      } else if ((tool === 'line' || tool === 'rect') && dragStart) {
        drawShapePreview(ev);
      } else if (tool !== 'marquee' && tool !== 'move') {
        applyTool(ev);
      }
    }
    store.update(s => { s.ui.hover = pixelAt(ev); });
  });
  function endDrag(): void {
    dragStart = null;
    marqueeStart = null;
    moveDragOffset = null;
    endStroke();
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', () => {
    if (pointerDown) endStroke();
    dragStart = null;
    marqueeStart = null;
    moveDragOffset = null;
    store.update(s => { s.ui.hover = null; });
  });

  // Marching ants: only redraws while a selection or floating layer exists.
  setInterval(() => {
    const { ui } = store.get();
    if (ui.marquee || ui.floating) { antsPhase = (antsPhase + 4) % 16; render(); }
  }, 120);

  store.subscribe(render);
  render();

  return { render, commitFloating, cancelFloating, pasteFloating, deleteSelection };
}
