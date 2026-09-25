// Round-trip check: every vanilla graphics raw must parse and write back
// byte-identical, and the typed views must read every block.
// Usage: node tools/roundtrip.ts [--df <path>] [--all]   (--all: every vanilla raw, not just graphics)
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { RawDocument, CREATURE_HEADERS } from '../src/engine/index.ts';
import { dfDir } from './df-dir.ts';

const argv = process.argv.slice(2);
const vanilla = join(dfDir(argv), 'data', 'vanilla');
const all = argv.includes('--all');

const files = (readdirSync(vanilla, { recursive: true }) as string[])
  .filter(f => f.endsWith('.txt') && (all || /[\\/]graphics[\\/]/.test(f)))
  .map(f => join(vanilla, f)).sort();

let failed = 0, tokens = 0, pages = 0, creatures = 0;
for (const path of files) {
  const name = relative(vanilla, path);
  const bytes = new Uint8Array(readFileSync(path));
  const problems: string[] = [];
  const doc = RawDocument.fromBytes(bytes);
  const out = doc.toBytes();
  if (out.length !== bytes.length || out.some((b, i) => b !== bytes[i])) {
    const at = out.findIndex((b, i) => b !== bytes[i]);
    problems.push(`not byte-identical (first difference at byte ${at < 0 ? Math.min(out.length, bytes.length) : at})`);
  }
  // A lone ']' or a token missing its '[' is a comment to DF too. A '[' left
  // in a comment means a token the tokenizer could not close: flag it.
  const stray = doc.nodes.filter(n => n.kind === 'text' && n.text.includes('[')).length;
  if (stray) problems.push(`${stray} comment span(s) contain an unclosed '['`);
  tokens += doc.tokens().length;
  for (const p of doc.tilePages()) {
    pages++;
    if (!p.file || !p.tileDim?.every(Number.isFinite) || !p.sizePixels?.every(Number.isFinite))
      problems.push(`tile page ${p.id} is missing FILE, TILE_DIM or a page size`);
  }
  const cg = doc.creatureGraphics();
  creatures += cg.length;
  const headers = doc.tokens().filter(t => CREATURE_HEADERS.has(t.args[0])).length;
  if (cg.length !== headers) problems.push(`read ${cg.length} of ${headers} creature blocks`);
  if (problems.length) { failed++; console.log(`FAIL ${name}\n  ${problems.join('\n  ')}`); }
}
console.log(`${files.length - failed}/${files.length} files OK · ${tokens} tokens · ${pages} tile pages · ${creatures} creature blocks`);
process.exit(failed ? 1 : 0);
