import { mkdtemp, readFile, rm, stat, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { prepareEvidenceArtifact } from '@devrandom/protocol';
import { FileHarnessProposalRecords } from './file-harness-proposal-records.js';
it('preserves exact immutable attempt bytes across retries and refuses a linked evidence destination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-proposal-records-'));
  try {
    const bytes = Buffer.from(JSON.stringify({ kind: 'fixture-denial' }));
    const artifact = prepareEvidenceArtifact(bytes, 'application/json');
    if (artifact.kind !== 'Prepared') throw new Error('artifact');
    const input = {
      proposal: { artifact: artifact.artifact, bytes },
      receipt: { artifact: artifact.artifact, bytes },
    };
    const records = new FileHarnessProposalRecords(join(root, 'records'));
    expect(await records.record(input)).toEqual({ kind: 'Recorded' });
    expect(await records.record(input)).toEqual({ kind: 'Recorded' });
    const path = join(root, 'records', `${artifact.artifact.d}.json`);
    expect(await readFile(path)).toEqual(bytes);
    expect((await stat(path)).mode & 0o777).toBe(0o400);
    await mkdir(join(root, 'outside'), { mode: 0o700 });
    await symlink(join(root, 'outside'), join(root, 'linked'));
    expect(await new FileHarnessProposalRecords(join(root, 'linked')).record(input)).toEqual({
      kind: 'Unavailable',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
