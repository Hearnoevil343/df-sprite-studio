// Resolves the Dwarf Fortress install: --df <path>, then DF_DIR, then the
// first line of .df-dir in the project root (not committed).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function dfDir(argv: string[]): string {
  const i = argv.indexOf('--df');
  const dir = (i >= 0 ? argv[i + 1] : undefined) ?? process.env.DF_DIR
    ?? (existsSync('.df-dir') ? readFileSync('.df-dir', 'utf8').split(/\r?\n/)[0].trim() : undefined);
  if (!dir || !existsSync(join(dir, 'data', 'vanilla'))) {
    console.error('Dwarf Fortress not found. Pass --df <path>, set DF_DIR, or write the path into .df-dir');
    process.exit(2);
  }
  return dir;
}
