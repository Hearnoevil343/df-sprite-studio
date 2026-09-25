// Mod info and info.txt. Field order follows vanilla's info.txt.
import { RawDocument } from '../raw/document.ts';

export type ModInfo = { id: string; name: string; version: string; author: string; description: string };

// DF mod ids: lower case letters, digits and underscores.
export function modId(id: string): string {
  const clean = id.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return clean || 'my_sprites';
}

// Token text can't hold brackets or colons (DF reads them as token syntax;
// a colon ends the argument) or characters outside one byte.
export function tokenText(s: string): string {
  return s.replace(/[\r\n\t]+/g, ' ').replace(/[[\]]/g, '').replace(/:/g, ' -').replace(/[^\x20-\xff]/g, '?').trim();
}

// "1.2.3" -> 10203, "7" -> 7; anything else -> 1.
export function numericVersion(v: string): number {
  const parts = v.trim().split('.');
  if (!parts.every(p => /^\d+$/.test(p))) return 1;
  return parts.slice(0, 3).reduce((n, p) => n * 100 + Number(p), 0) || 1;
}

export function infoTxt(mod: ModInfo, eol = '\r\n'): string {
  const version = tokenText(mod.version) || '1';
  const lines = [
    ['ID', modId(mod.id)],
    ['NUMERIC_VERSION', String(numericVersion(version))],
    ['DISPLAYED_VERSION', version],
    ['EARLIEST_COMPATIBLE_NUMERIC_VERSION', '1'],
    ['EARLIEST_COMPATIBLE_DISPLAYED_VERSION', '1'],
    ['AUTHOR', tokenText(mod.author) || 'Unknown'],
    ['NAME', tokenText(mod.name) || modId(mod.id)],
    ['DESCRIPTION', tokenText(mod.description) || 'Creature sprites made with DF Sprite Studio.'],
  ];
  return lines.map(([k, v]) => `[${k}:${v}]`).join(eol) + eol;
}

export function parseInfoTxt(src: string): ModInfo {
  const tokens = RawDocument.parse(src).tokens();
  const get = (name: string) => tokens.find(t => t.args[0] === name)?.args.slice(1).join(':') ?? '';
  return { id: get('ID'), name: get('NAME'), version: get('DISPLAYED_VERSION'), author: get('AUTHOR'), description: get('DESCRIPTION') };
}
