// Pure helpers for the Ollama caption step: request body and response parsing.
// No fetch here; HTTP lives in tools/.
export type CaptionConfig = {
  model: string;
  instruction: string;
};

export const DEFAULT_CAPTION: CaptionConfig = {
  model: 'qwen2.5vl:7b',
  instruction: 'Describe the main creature or character in this image in one short line of comma-separated phrases: '
    + 'what it is, its colours, and its notable features. Under 25 words. Ignore the background. No full sentences.',
};

// `imageBase64` is the raw PNG bytes as base64, no data: prefix.
export function buildCaptionRequest(imageBase64: string, cfg: Partial<CaptionConfig> = {}): { model: string; stream: false; keep_alive: 0; messages: unknown[] } {
  const c = { ...DEFAULT_CAPTION, ...cfg };
  // keep_alive 0 unloads the caption model at once so SDXL gets the VRAM back.
  return { model: c.model, stream: false, keep_alive: 0, messages: [{ role: 'user', content: c.instruction, images: [imageBase64] }] };
}

// `body` is the parsed JSON of POST /api/chat.
export function parseCaption(body: unknown): string {
  const raw = (body as { message?: { content?: unknown } } | null)?.message?.content;
  if (typeof raw !== 'string') throw new Error('caption: no message content in Ollama response');
  const text = raw.replace(/\s+/g, ' ').replace(/^["'\s]+|["'.\s]+$/g, '');
  if (!text) throw new Error('caption: empty caption');
  return text;
}
