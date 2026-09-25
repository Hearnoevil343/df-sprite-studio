// Editable raw file. Wraps the lossless node list with block views and edit
// operations that touch only the lines they change, so opening and saving a
// hand-written file changes nothing the user did not change.

import { decodeBytes, encodeString, serialize, tokenize } from './tokenize.ts';
import type { RawNode, TextNode, TokenNode } from './tokenize.ts';

// Tokens that start a top-level block in graphics raws (surveyed from every
// vanilla graphics file). Any of them ends the previous block. Only TILE_PAGE
// and the creature headers get typed views; the rest just bound blocks.
export const CREATURE_HEADERS = new Set([
  'CREATURE_GRAPHICS', 'CREATURE_CASTE_GRAPHICS',
  'STATUE_CREATURE_GRAPHICS', 'STATUE_CREATURE_CASTE_GRAPHICS',
]);
export const BLOCK_HEADERS = new Set([
  'OBJECT', 'TILE_PAGE', 'LAYER_SET_TEMPLATE', ...CREATURE_HEADERS,
  'TILE_GRAPHICS', 'TILE_GRAPHICS_RECTANGLE', 'ASCII_GRAPHICS', 'ASCII_RECTANGLE',
  'PLANT_GRAPHICS', 'PROCEDURAL_ITEM_GRAPHICS', 'INTERACTION_GRAPHICS', 'CUSTOM_WORKSHOP_GRAPHICS',
  'SHAPE_GRAPHICS_SMALL_GEM', 'SHAPE_GRAPHICS_LARGE_GEM', 'ADD_TOOL_GRAPHICS',
  'TOOL_GRAPHICS', 'TOY_GRAPHICS', 'WEAPON_GRAPHICS', 'ARMOR_GRAPHICS', 'PANTS_GRAPHICS',
  'HELM_GRAPHICS', 'SHOES_GRAPHICS', 'GLOVES_GRAPHICS', 'SHIELD_GRAPHICS', 'AMMO_GRAPHICS',
  'SIEGEAMMO_GRAPHICS', 'TRAPCOMP_GRAPHICS', 'FOOD_GRAPHICS',
]);

export type Block = { header: TokenNode; children: TokenNode[] };

export class RawDocument {
  nodes: RawNode[];
  readonly eol: string;

  constructor(nodes: RawNode[], eol = '\n') {
    this.nodes = nodes;
    this.eol = eol;
  }

  static parse(src: string): RawDocument {
    const lf = src.indexOf('\n');
    return new RawDocument(tokenize(src), lf > 0 && src[lf - 1] === '\r' ? '\r\n' : '\n');
  }

  static fromBytes(bytes: Uint8Array): RawDocument {
    return RawDocument.parse(decodeBytes(bytes));
  }

  toString(): string { return serialize(this.nodes); }
  toBytes(): Uint8Array { return encodeString(this.toString()); }

  // First line of the file. DF expects it to match the file name.
  get header(): string {
    const first = this.nodes[0];
    return first?.kind === 'text' ? first.text.split(/\r?\n/, 1)[0] : '';
  }

  tokens(): TokenNode[] {
    return this.nodes.filter((n): n is TokenNode => n.kind === 'token');
  }

  objectType(): string | undefined {
    return this.tokens().find(t => t.args[0] === 'OBJECT')?.args[1];
  }

  // Recomputed on each call, so views never go stale after edits.
  blocks(): Block[] {
    const out: Block[] = [];
    let cur: Block | undefined;
    for (const t of this.tokens()) {
      if (BLOCK_HEADERS.has(t.args[0])) {
        cur = t.args[0] === 'OBJECT' ? undefined : { header: t, children: [] };
        if (cur) out.push(cur);
      } else if (cur) {
        cur.children.push(t);
      }
    }
    return out;
  }

  tilePages(): TilePage[] {
    return this.blocks().filter(b => b.header.args[0] === 'TILE_PAGE').map(b => new TilePage(this, b));
  }

  creatureGraphics(): CreatureGraphics[] {
    return this.blocks().filter(b => CREATURE_HEADERS.has(b.header.args[0])).map(b => new CreatureGraphics(this, b));
  }

  // ---- editing ----

  // Leading whitespace of the line a token starts, or undefined if the token
  // is not first on its line.
  indentOf(t: TokenNode): string | undefined {
    const i = this.nodes.indexOf(t);
    const prev = this.nodes[i - 1];
    if (!prev) return '';
    if (prev.kind !== 'text') return undefined;
    const nl = prev.text.lastIndexOf('\n');
    const tail = prev.text.slice(nl + 1);
    if (nl < 0 && i - 1 !== 0) return undefined;
    return /^[ \t]*$/.test(tail) ? tail : undefined;
  }

  // Insert a token on a new line after ref's line, with ref's indent unless
  // one is given. A comment trailing ref on its line stays with ref.
  insertAfter(ref: TokenNode, args: string[], indent?: string): TokenNode {
    let i = this.nodes.indexOf(ref);
    if (i < 0) throw new Error('insertAfter: token not in document');
    const token: TokenNode = { kind: 'token', args: [...args] };
    const ind = indent ?? this.indentOf(ref) ?? '';
    const next = this.nodes[i + 1];
    if (next?.kind === 'text') {
      const m = /\r?\n/.exec(next.text);
      if (m && m.index > 0) {
        // split "comment\nrest" so the new line goes after the comment
        this.nodes.splice(i + 1, 1, { kind: 'text', text: next.text.slice(0, m.index) }, { kind: 'text', text: next.text.slice(m.index) });
        i++;
      }
    }
    this.nodes.splice(i + 1, 0, { kind: 'text', text: this.eol + ind }, token);
    this.mergeText();
    return token;
  }

  // Remove a token. If it was alone on its line, the line goes too.
  remove(t: TokenNode): void {
    const i = this.nodes.indexOf(t);
    if (i < 0) throw new Error('remove: token not in document');
    const prev = this.nodes[i - 1];
    const next = this.nodes[i + 1];
    const nextStartsLine = !next || (next.kind === 'text' && /^[ \t]*(\r?\n|$)/.test(next.text));
    if (prev?.kind === 'text' && this.indentOf(t) !== undefined && nextStartsLine) {
      const m = /\r?\n[ \t]*$/.exec(prev.text);
      if (m) prev.text = prev.text.slice(0, m.index);
      if (next?.kind === 'text') next.text = next.text.replace(/^[ \t]*/, '');
    }
    this.nodes.splice(i, 1);
    this.mergeText();
  }

  // Set a block's child token by name, or add it after the last child.
  setChild(block: Block, name: string, values: string[]): TokenNode {
    const found = block.children.find(c => c.args[0] === name);
    if (found) { found.args = [name, ...values]; return found; }
    return this.appendChild(block, [name, ...values]);
  }

  // Add a child token after the block's last child, matching its indent.
  appendChild(block: Block, args: string[]): TokenNode {
    const last = block.children[block.children.length - 1];
    const t = last ? this.insertAfter(last, args) : this.insertAfter(block.header, args, '\t');
    block.children.push(t);
    return t;
  }

  // Append a new block at the end of the file, separated by a blank line.
  appendBlock(header: string[], children: string[][], indent = '\t'): Block {
    const src = this.toString();
    let lead = src.endsWith('\n') ? '' : this.eol;
    if (src.length && !/(\r?\n){2}$/.test(src)) lead += this.eol;
    const h: TokenNode = { kind: 'token', args: [...header] };
    const add: RawNode[] = [{ kind: 'text', text: lead }, h];
    const kids = children.map(args => ({ kind: 'token', args: [...args] }) as TokenNode);
    for (const k of kids) add.push({ kind: 'text', text: this.eol + indent }, k);
    add.push({ kind: 'text', text: this.eol });
    this.nodes.push(...add);
    this.mergeText();
    return { header: h, children: kids };
  }

  private mergeText(): void {
    const out: RawNode[] = [];
    for (const n of this.nodes) {
      const last = out[out.length - 1];
      if (n.kind === 'text' && last?.kind === 'text') (last as TextNode).text += n.text;
      else if (n.kind !== 'text' || n.text) out.push(n);
    }
    this.nodes = out;
  }
}

function num(t: TokenNode | undefined, i: number): number | undefined {
  const v = t?.args[i];
  return v === undefined || v.trim() === '' ? undefined : Number(v);
}

// [TILE_PAGE:ID] [FILE:path] [TILE_DIM:w:h] [PAGE_DIM_PIXELS:w:h]
export class TilePage {
  readonly doc: RawDocument;
  readonly block: Block;
  constructor(doc: RawDocument, block: Block) { this.doc = doc; this.block = block; }
  private child(name: string) { return this.block.children.find(c => c.args[0] === name); }

  get id(): string { return this.block.header.args[1] ?? ''; }
  set id(v: string) { this.block.header.args = ['TILE_PAGE', v]; }

  get file(): string | undefined { return this.child('FILE')?.args.slice(1).join(':'); }
  set file(v: string) { this.doc.setChild(this.block, 'FILE', [v]); }

  get tileDim(): [number, number] | undefined {
    const t = this.child('TILE_DIM');
    return t ? [num(t, 1)!, num(t, 2)!] : undefined;
  }
  set tileDim(v: [number, number]) { this.doc.setChild(this.block, 'TILE_DIM', v.map(String)); }

  get pageDimPixels(): [number, number] | undefined {
    const t = this.child('PAGE_DIM_PIXELS');
    return t ? [num(t, 1)!, num(t, 2)!] : undefined;
  }
  set pageDimPixels(v: [number, number]) { this.doc.setChild(this.block, 'PAGE_DIM_PIXELS', v.map(String)); }

  // Older form: page size in tiles instead of pixels.
  get pageDim(): [number, number] | undefined {
    const t = this.child('PAGE_DIM');
    return t ? [num(t, 1)!, num(t, 2)!] : undefined;
  }

  // Page size in pixels from whichever form the page uses.
  get sizePixels(): [number, number] | undefined {
    if (this.pageDimPixels) return this.pageDimPixels;
    const d = this.pageDim, t = this.tileDim;
    return d && t ? [d[0] * t[0], d[1] * t[1]] : undefined;
  }
}

// [CREATURE_GRAPHICS:ID], [CREATURE_CASTE_GRAPHICS:ID:CASTE] and the statue
// forms. Entries are the child tokens as written; their meaning (sprite
// references, layers, conditions) is decoded by the template layer.
export class CreatureGraphics {
  readonly doc: RawDocument;
  readonly block: Block;
  constructor(doc: RawDocument, block: Block) { this.doc = doc; this.block = block; }

  get kind(): string { return this.block.header.args[0]; }
  get creatureId(): string { return this.block.header.args[1] ?? ''; }
  get caste(): string | undefined { return this.kind.includes('CASTE') ? this.block.header.args[2] : undefined; }
  get isStatue(): boolean { return this.kind.startsWith('STATUE_'); }
  get entries(): TokenNode[] { return this.block.children; }

  add(args: string[]): TokenNode { return this.doc.appendChild(this.block, args); }
}
