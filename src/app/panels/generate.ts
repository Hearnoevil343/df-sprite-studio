// Generate / restyle / add-to-training-set panel. Talks to
// ComfyUI and Ollama through the /comfy and /ollama proxies in
// tools/studio-server.ts (ComfyUI rejects browser Origins), then runs each
// result through the same reducer and checker as `studio generate` and shows
// the four ranked candidates; clicking one writes it into the open entry.
import {
  DEFAULT_GENERATE, buildCaptionRequest, buildPrompt, buildWorkflow, cellFor, checkSprite, parseCaption, parseHistory,
  proportionGuide, rankCandidates, reduceImage, templateById, viewQuery,
} from '../../engine/index.ts';
import type { Issue, RgbaImage, VanillaStats, VanillaStyle } from '../../engine/index.ts';
import { decodeImageBlob, encodeImageBase64 } from '../io/browser-png.ts';
import { noEntryOpenMessage } from '../state/messages.ts';
import { applySprite, sameCreature } from '../state/selection.ts';
import type { Store } from '../state/store.ts';

const COUNT = 4;
const CAPTION_SCALE = 16;
const POLL_MS = 2000;
const TIMEOUT_MS = 900_000;
const CAND_ZOOM = 3;

type Cand = { seed: number; img: RgbaImage; issues: Issue[] };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props);
}

function drawCand(canvas: HTMLCanvasElement, img: RgbaImage): void {
  canvas.width = img.width * CAND_ZOOM;
  canvas.height = img.height * CAND_ZOOM;
  const ctx = canvas.getContext('2d')!;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      ctx.fillStyle = img.data[i + 3] === 0 ? ((x + y) % 2 === 0 ? '#3a3a3a' : '#2c2c2c') : `rgb(${img.data[i]}, ${img.data[i + 1]}, ${img.data[i + 2]})`;
      ctx.fillRect(x * CAND_ZOOM, y * CAND_ZOOM, CAND_ZOOM, CAND_ZOOM);
    }
  }
}

async function json(res: Response, what: string): Promise<any> {
  if (!res.ok) throw new Error(`${what} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// studio-server.ts's /comfy proxy returns a 500 with Node's own fetch error
// text (e.g. "fetch failed") when ComfyUI itself isn't reachable, and a
// browser fetch to a route that doesn't exist at all (running under plain
// static file server, which has no /comfy proxy) throws its own "Failed to fetch"
// TypeError. Neither tells a modder what's actually wrong, so both get
// rewritten to name the thing that needs to be running.
async function comfyFetch(input: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch {
    throw new Error('ComfyUI unreachable at 127.0.0.1:8188 (start tools/studio-server.ts with ComfyUI running)');
  }
}

async function comfyJson(res: Response): Promise<any> {
  if (res.status >= 500) {
    const body = await res.text();
    if (/fetch failed|ECONNREFUSED|ETIMEDOUT/i.test(body)) {
      throw new Error('ComfyUI unreachable at 127.0.0.1:8188 (start tools/studio-server.ts with ComfyUI running)');
    }
    throw new Error(`ComfyUI failed (${res.status}): ${body.slice(0, 200)}`);
  }
  return json(res, 'ComfyUI');
}

export function createGeneratePanel(store: Store, container: HTMLElement, stats: VanillaStats, style: VanillaStyle): void {
  const desc = el('input', { type: 'text', placeholder: 'description / caption', className: 'gen-desc' });
  const generate = el('button', { type: 'button', textContent: 'Generate' });
  const restyle = el('button', { type: 'button', textContent: 'Restyle' });
  const addBtn = el('button', { type: 'button', textContent: 'Add to training set' });
  const row = el('div', { className: 'gen-row' });
  row.append(generate, restyle, addBtn);
  const status = el('div', { className: 'gen-status' });
  const grid = el('div', { className: 'gen-grid' });
  const wrap = el('div', { className: 'gen-panel' });
  wrap.append(el('div', { textContent: 'AI sprite (open entry)' }), desc, row, grid, status);
  container.append(wrap);

  let busy = false;

  function target() {
    const { project, ui } = store.get();
    const sel = ui.selection;
    const creature = sel && project.creatures.find(c => sameCreature(c, sel));
    const template = creature && templateById(creature.templateId);
    const entry = template?.entries.find(e => e.key === sel?.entryKey);
    if (!sel || !creature || !entry) return null;
    const [w, h] = entry.size ?? [1, 1];
    return w === 1 && h === 1 ? { creature, entry, ref: { id: creature.id, caste: creature.caste, templateId: creature.templateId } } : null;
  }

  async function run(fromSprite: boolean): Promise<void> {
    const t = target();
    if (!t || busy) { status.textContent = t ? 'Busy.' : noEntryOpenMessage(store.get().ui); return; }
    busy = true;
    generate.disabled = restyle.disabled = true;
    grid.innerHTML = '';
    try {
      let description = desc.value.trim();
      if (fromSprite) {
        status.textContent = 'Captioning...';
        const b64 = encodeImageBase64(store.get().project.sprite, CAPTION_SCALE);
        const res = await fetch('/ollama/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildCaptionRequest(b64)) });
        description = [parseCaption(await json(res, 'Ollama')), description].filter(Boolean).join(', ');
        desc.value = description;
      }
      const prompt = buildPrompt(description);
      const cell = cellFor(DEFAULT_GENERATE.size);
      const seed0 = Math.floor(Math.random() * 2 ** 31);
      const palette = store.get().project.palette;
      const cands: Cand[] = [];
      for (let i = 0; i < COUNT; i++) {
        status.textContent = `Generating ${i + 1}/${COUNT}...`;
        const seed = seed0 + i;
        const res = await comfyFetch('/comfy/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: buildWorkflow(prompt, seed) }) });
        const promptId = (await comfyJson(res)).prompt_id as string;
        const t0 = Date.now();
        let image;
        for (;;) {
          const r = parseHistory(await comfyJson(await comfyFetch(`/comfy/history/${promptId}`)), promptId);
          if (r.state === 'error') throw new Error(r.message);
          if (r.state === 'done') { image = r.image; break; }
          if (Date.now() - t0 > TIMEOUT_MS) throw new Error('timed out');
          await new Promise(resolve => setTimeout(resolve, POLL_MS));
        }
        const raw = await decodeImageBlob(await (await comfyFetch(`/comfy/view?${viewQuery(image)}`)).blob());
        const red = reduceImage(raw, palette, { cell, stats, token: t.entry.token });
        const issues = [...red.issues, ...checkSprite(red.img, { token: t.entry.token, palette, locked: true, style, floors: style.floors, guide: proportionGuide(stats, { token: t.entry.token }) })];
        cands.push({ seed, img: red.img, issues });
      }
      status.textContent = 'Click a candidate to use it.';
      rankCandidates(cands).forEach((r, n) => {
        const c = cands.find(x => x.seed === r.seed)!;
        const cv = el('canvas', { className: 'gen-cand', title: `#${n + 1} seed ${r.seed} score ${r.score}${r.rejected ? ` REJECTED (${r.reason})` : ''}\n${c.issues.map(i => `${i.severity} ${i.rule}`).join('\n')}` });
        drawCand(cv, c.img);
        cv.classList.toggle('rejected', r.rejected);
        if (!r.rejected) cv.addEventListener('click', () => applySprite(store, t.ref, t.entry.key, c.img, `generate ${t.entry.key}`));
        const item = el('div', { className: 'gen-item' });
        item.append(cv, el('div', { textContent: r.rejected ? `x ${r.reason}` : `#${n + 1} (${r.score})` }));
        grid.append(item);
      });
    } catch (e) {
      status.textContent = `Error: ${(e as Error).message}`;
    } finally {
      busy = false;
      generate.disabled = restyle.disabled = false;
    }
  }

  generate.addEventListener('click', () => { if (desc.value.trim()) void run(false); else status.textContent = 'Type a description first.'; });
  restyle.addEventListener('click', () => void run(true));
  addBtn.addEventListener('click', async () => {
    const t = target();
    const caption = desc.value.trim();
    if (!t || !caption) { status.textContent = t ? 'Type a caption in the box first.' : noEntryOpenMessage(store.get().ui); return; }
    const sprite = store.get().project.sprite;
    try {
      const rgba = btoa(Array.from(sprite.data, b => String.fromCharCode(b)).join(''));
      const res = await fetch('/training-set', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: `${t.creature.id}_${t.entry.key}`, caption, width: sprite.width, height: sprite.height, rgba }) });
      const out = await json(res, 'Training set');
      status.textContent = `Added ${out.name} to ${out.dir}`;
    } catch (e) {
      status.textContent = `Error: ${(e as Error).message}`;
    }
  });
}
