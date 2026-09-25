// Pure helpers for the ComfyUI bridge: prompt text, workflow JSON, history
// parsing. No fetch here; HTTP lives in tools/.
export type GenerateConfig = {
  checkpoint: string;
  lora: string;
  strength: number;
  size: number;     // generation size in pixels (square); size / FAKE_PIXELS is the reducer cell
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  negative: string;
};

export const DEFAULT_GENERATE: GenerateConfig = {
  checkpoint: 'sd_xl_base_1.0.safetensors',
  lora: 'dfsprite_clean_v1.safetensors',
  strength: 1.0,
  size: 1024,
  steps: 30,
  cfg: 6.0,
  sampler: 'euler',
  scheduler: 'normal',
  negative: 'blurry, smooth shading, gradient, photo, 3d render, text, watermark, frame, border',
};

export type ComfyWorkflow = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

// Node id of the SaveImage node, where parseHistory looks for output.
export const SAVE_NODE = '8';

// df-ai-art's caption convention: trigger word first, then the description.
export function buildPrompt(description: string): string {
  const d = description.trim().replace(/\s+/g, ' ');
  if (!d) throw new Error('empty description');
  return `dfsprite, 32x32 pixel art sprite, full character, ${d}, default, flat green background`;
}

export function buildWorkflow(prompt: string, seed: number, cfg: Partial<GenerateConfig> = {}): ComfyWorkflow {
  const c = { ...DEFAULT_GENERATE, ...cfg };
  return {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: c.checkpoint } },
    '2': { class_type: 'LoraLoader', inputs: { model: ['1', 0], clip: ['1', 1], lora_name: c.lora, strength_model: c.strength, strength_clip: c.strength } },
    '3': { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 1], text: prompt } },
    '4': { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 1], text: c.negative } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: c.size, height: c.size, batch_size: 1 } },
    '6': { class_type: 'KSampler', inputs: { model: ['2', 0], positive: ['3', 0], negative: ['4', 0], latent_image: ['5', 0], seed, steps: c.steps, cfg: c.cfg, sampler_name: c.sampler, scheduler: c.scheduler, denoise: 1.0 } },
    '7': { class_type: 'VAEDecode', inputs: { samples: ['6', 0], vae: ['1', 2] } },
    [SAVE_NODE]: { class_type: 'SaveImage', inputs: { images: ['7', 0], filename_prefix: 'dfstudio' } },
  };
}

export type ImageRef = { filename: string; subfolder: string; type: string };
export type HistoryResult =
  | { state: 'pending' }
  | { state: 'error'; message: string }
  | { state: 'done'; image: ImageRef };

// `hist` is the parsed body of GET /history/<id>.
export function parseHistory(hist: unknown, promptId: string): HistoryResult {
  const entry = (hist as Record<string, any> | null)?.[promptId];
  if (!entry) return { state: 'pending' };
  const status = entry.status ?? {};
  if (status.status_str !== 'success') {
    const msgs: unknown[] = Array.isArray(status.messages) ? status.messages : [];
    const err = msgs.find(m => Array.isArray(m) && (m[0] === 'execution_error' || m[0] === 'execution_interrupted')) as [string, any] | undefined;
    const detail = err ? String(err[1]?.exception_message ?? err[0]) : String(status.status_str ?? 'unknown');
    return { state: 'error', message: detail };
  }
  const image = entry.outputs?.[SAVE_NODE]?.images?.[0];
  if (!image) return { state: 'error', message: 'no image in output' };
  return { state: 'done', image: { filename: image.filename, subfolder: image.subfolder ?? '', type: image.type ?? 'output' } };
}

export function viewQuery(img: ImageRef): string {
  return `filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder)}&type=${encodeURIComponent(img.type)}`;
}

// The LoRA draws on a ~16 px fake-pixel grid at 1024 px, i.e. 64 fake pixels across
// the canvas (found in 5b-2: detectCell reads 8 or 16, fixed 32 shrinks the subject
// to half a tile). Size must be a whole multiple so the cell is exact.
export const FAKE_PIXELS = 64;
export function cellFor(size: number, across = FAKE_PIXELS): number {
  if (size % across !== 0) throw new Error(`size ${size} is not a multiple of ${across}`);
  return size / across;
}
