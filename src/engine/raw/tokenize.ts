// Lossless tokenizer for Dwarf Fortress raw files.
//
// A raw file is text with [TOKEN:ARG:ARG] tokens; everything outside brackets
// is a comment. The node list keeps every byte: text nodes hold comments,
// whitespace and line breaks verbatim, token nodes hold the raw argument
// strings (untrimmed), so serialize(tokenize(s)) === s for any input.
//
// No Node or DOM imports: this runs in the browser and on the command line.

export type TextNode = { kind: 'text'; text: string };
export type TokenNode = { kind: 'token'; args: string[] };
export type RawNode = TextNode | TokenNode;

// DF raws are single-byte (CP437). Map each byte to the char with the same
// code (0-255) so decode/encode is exactly reversible. TextDecoder('latin1')
// is not usable: browsers treat it as windows-1252, which remaps 0x80-0x9F.
export function decodeBytes(bytes: Uint8Array): string {
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return out;
}

export function encodeString(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 0xff) throw new Error(`Character U+${c.toString(16)} at ${i} does not fit in a single-byte raw file`);
    out[i] = c;
  }
  return out;
}

// A character argument like '[' or ':' fills a whole argument: it starts
// right after '[' or ':' and is followed by ':' or ']'. The position check
// keeps apostrophes inside names (giant's) from being read as quotes.
function isQuotedChar(s: string, i: number): boolean {
  return s[i] === "'" && s[i + 2] === "'" && (s[i - 1] === '[' || s[i - 1] === ':')
    && (s[i + 3] === ':' || s[i + 3] === ']') && s[i + 1] !== '\n' && s[i + 1] !== '\r';
}

// Split a token's inner text on ':' except inside a quoted character.
function splitArgs(inner: string): string[] {
  const s = '[' + inner + ']';
  const args: string[] = [];
  let start = 1;
  for (let i = 1; i < s.length - 1; i++) {
    if (isQuotedChar(s, i)) { i += 2; continue; }
    if (s[i] === ':') { args.push(s.slice(start, i)); start = i + 1; }
  }
  args.push(s.slice(start, s.length - 1));
  return args;
}

// A token is '[' + chars other than '[', ']', CR, LF + ']', where a quoted
// character argument may be '[' or ']'. Anything else, including a stray or
// unclosed bracket, stays in a text node untouched.
export function tokenize(src: string): RawNode[] {
  const nodes: RawNode[] = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('[', i);
    if (open < 0) { text += src.slice(i); break; }
    let j = open + 1;
    while (j < src.length) {
      if (isQuotedChar(src, j)) { j += 3; continue; }
      const c = src.charCodeAt(j);
      if (c === 0x5d /* ] */ || c === 0x5b /* [ */ || c === 0x0a || c === 0x0d) break;
      j++;
    }
    if (j < src.length && src[j] === ']') {
      text += src.slice(i, open);
      if (text) { nodes.push({ kind: 'text', text }); text = ''; }
      nodes.push({ kind: 'token', args: splitArgs(src.slice(open + 1, j)) });
      i = j + 1;
    } else {
      text += src.slice(i, j); // not a token; keep scanning after it
      i = j;
    }
  }
  if (text) nodes.push({ kind: 'text', text });
  return nodes;
}

export function tokenString(t: TokenNode): string {
  return '[' + t.args.join(':') + ']';
}

export function serialize(nodes: readonly RawNode[]): string {
  let out = '';
  for (const n of nodes) out += n.kind === 'text' ? n.text : tokenString(n);
  return out;
}
