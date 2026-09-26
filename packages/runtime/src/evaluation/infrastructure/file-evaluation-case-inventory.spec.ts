import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EvaluationManifest } from '@devrandom/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { FileEvaluationCaseInventory } from './file-evaluation-case-inventory.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'devrandom-case-inventory-'));
  roots.push(root);
  const directory = join(root, 'private');
  await mkdir(directory, { mode: 0o700 });
  const verifierSaid = `E${'a'.repeat(43)}`;
  const manifest = { verifierSaid } as EvaluationManifest;
  return { directory, manifest, path: join(directory, verifierSaid) };
}

describe('private file verifier inventory', () => {
  it('reads exact private bytes, then refuses public mode and symlink substitution', async () => {
    const given = await fixture();
    await writeFile(given.path, 'exact bytes', { mode: 0o600 });
    const inventory = new FileEvaluationCaseInventory(given.directory);
    expect(await inventory.open(given.manifest)).toMatchObject({
      kind: 'Opened',
      bytes: Buffer.from('exact bytes'),
    });
    await chmod(given.path, 0o644);
    expect(await inventory.open(given.manifest)).toEqual({ kind: 'Unavailable' });
    await rm(given.path);
    await symlink('/etc/hosts', given.path);
    expect(await inventory.open(given.manifest)).toEqual({ kind: 'Unavailable' });
  });

  it('does not resolve missing or traversal-like verifier names', async () => {
    const given = await fixture();
    const inventory = new FileEvaluationCaseInventory(given.directory);
    expect(await inventory.open(given.manifest)).toEqual({ kind: 'Missing' });
    expect(await inventory.open({ verifierSaid: '../escape' } as EvaluationManifest)).toEqual({
      kind: 'Missing',
    });
  });
});
