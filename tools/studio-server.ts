// Local server for the editor app: serves app/, proxies /comfy/* to ComfyUI and
// /ollama/* to Ollama (ComfyUI answers 403 to any browser Origin, so the app
// can't call it directly), and POST /training-set writes one sprite into the
// df-ai-art dataset. Usage: node tools/studio-server.ts [--port 8000]
//   [--comfy url] [--ollama url] [--dataset <dir>]   (after `npm run build`)
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { trainingCaption, trainingImages } from '../src/engine/index.ts';
import { encodePng } from './png.ts';

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const port = Number(flag('--port') ?? 8000);
const comfy = (flag('--comfy') ?? process.env.COMFY_URL ?? 'http://127.0.0.1:8188').replace(/\/$/, '');
const ollama = (flag('--ollama') ?? process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
const dataset = flag('--dataset') ?? 'E:/df-ai-art-5080/dataset/studio';
const appDir = join(import.meta.dirname, '..', 'app');
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.map': 'application/json', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };

function uniqueName(dir: string, base: string): string {
  let name = base;
  for (let n = 2; existsSync(join(dir, 'train', `${name}.png`)); n++) name = `${base}_${n}`;
  return name;
}

// body: { name, caption (description), width, height, rgba (base64) }
export function writeTrainingSet(root: string, body: { name: string; caption: string; width: number; height: number; rgba: string }): string {
  const { tile, train } = trainingImages({ width: body.width, height: body.height, data: new Uint8ClampedArray(Buffer.from(body.rgba, 'base64')) });
  const caption = trainingCaption(body.caption);
  mkdirSync(join(root, 'tiles'), { recursive: true });
  mkdirSync(join(root, 'train'), { recursive: true });
  const name = uniqueName(root, `studio__${body.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '_') || 'sprite'}`);
  writeFileSync(join(root, 'tiles', `${name}.png`), encodePng(tile));
  writeFileSync(join(root, 'train', `${name}.png`), encodePng(train));
  writeFileSync(join(root, 'train', `${name}.txt`), caption);
  return name;
}

async function proxy(target: string, req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers: Record<string, string> = {};
  if (req.headers['content-type']) headers['Content-Type'] = String(req.headers['content-type']);
  const r = await fetch(target, { method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body });
  res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') ?? 'application/octet-stream' });
  res.end(Buffer.from(await r.arrayBuffer()));
}

if (import.meta.main) {
  createServer(async (req, res) => {
    try {
      const url = req.url ?? '/';
      if (url.startsWith('/comfy/')) return await proxy(comfy + url.slice(6), req, res);
      if (url.startsWith('/ollama/')) return await proxy(ollama + url.slice(7), req, res);
      if (url === '/training-set' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const name = writeTrainingSet(dataset, JSON.parse(Buffer.concat(chunks).toString()));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return void res.end(JSON.stringify({ name, dir: dataset }));
      }
      const path = normalize(decodeURIComponent(url.split('?')[0])).replace(/^([\\/])+/, '');
      const file = join(appDir, path === '' ? 'index.html' : path);
      if (!file.startsWith(appDir) || !existsSync(file)) { res.writeHead(404); return void res.end('not found'); }
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(readFileSync(file));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end((e as Error).message);
    }
  }).listen(port, () => console.log(`studio on http://localhost:${port}  comfy ${comfy}  ollama ${ollama}  dataset ${dataset}`));
}
