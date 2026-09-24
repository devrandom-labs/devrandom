import { readdir, readFile, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

import { staticSiteContentSecurityPolicy } from './csp-policy.js';

const exportDirectory = resolve(import.meta.dirname, 'out');
const generatedInclude = resolve(import.meta.dirname, '.next', 'site-csp.inc');

async function exportedHtml(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const documents: string[] = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      documents.push(...(await exportedHtml(path)));
    } else if (entry.isFile() && extname(entry.name) === '.html') {
      documents.push(await readFile(path, 'utf8'));
    }
  }
  return documents;
}

const documents = await exportedHtml(exportDirectory);
if (documents.length === 0) {
  throw new Error('Static site export contains no HTML documents');
}
const policy = staticSiteContentSecurityPolicy(documents);
await writeFile(generatedInclude, `add_header Content-Security-Policy "${policy}" always;\n`);
