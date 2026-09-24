import { readdir } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

const handwrittenStyleExtensions = new Set(['.css', '.less', '.sass', '.scss', '.styl']);

export function isHandwrittenStyleSheet(path: string): boolean {
  return handwrittenStyleExtensions.has(extname(path));
}

export async function findHandwrittenStyleSheets(root: string): Promise<readonly string[]> {
  const source = resolve(root, 'apps/site/src');
  const entries = await readdir(source, { recursive: true, withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && isHandwrittenStyleSheet(entry.name))
    .map((entry) => resolve(entry.parentPath, entry.name))
    .sort();
}
