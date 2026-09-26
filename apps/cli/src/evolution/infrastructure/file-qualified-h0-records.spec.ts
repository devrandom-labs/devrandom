import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { prepareEvidenceArtifact } from '@devrandom/protocol';
import { describe, expect, it } from 'vitest';

import { FileQualifiedH0Records } from './file-qualified-h0-records.js';

function record() {
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      kind: 'QualifiedH0Progress',
      evaluationId: '11111111-1111-4111-8111-111111111111',
    }),
  );
  const prepared = prepareEvidenceArtifact(bytes, 'application/json');
  if (prepared.kind !== 'Prepared') throw new Error('record fixture');
  return { artifact: prepared.artifact, bytes };
}

describe('parent H0 exact record custody', () => {
  it('durably commits exact bytes once and reopens the same record', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'devrandom-h0-'));
    try {
      const custody = new FileQualifiedH0Records(directory);
      const expected = record();
      const evaluationId = '11111111-1111-4111-8111-111111111111';
      expect(await custody.commit({ ...expected, evaluationId })).toEqual({
        kind: 'Committed',
        artifactSaid: expected.artifact.d,
      });
      expect(await custody.commit({ ...expected, evaluationId })).toEqual({
        kind: 'AlreadyCommitted',
        artifactSaid: expected.artifact.d,
      });
      expect(await custody.inspect(expected.artifact.d)).toEqual({
        kind: 'Read',
        artifact: expected.artifact,
        bytes: expected.bytes,
      });
      expect(await custody.inspectEvaluation(evaluationId)).toEqual({
        kind: 'Read',
        artifact: expected.artifact,
        bytes: expected.bytes,
      });
      expect(await readFile(join(directory, `${expected.artifact.d}.json`))).toEqual(
        Buffer.from(expected.bytes),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects a forged descriptor, corrupt retry and symlink path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'devrandom-h0-'));
    try {
      const custody = new FileQualifiedH0Records(directory);
      const expected = record();
      const evaluationId = '11111111-1111-4111-8111-111111111111';
      expect(
        await custody.commit({
          evaluationId,
          artifact: { ...expected.artifact, d: `E${'x'.repeat(43)}` },
          bytes: expected.bytes,
        }),
      ).toEqual({ kind: 'Conflict' });
      await custody.commit({ ...expected, evaluationId });
      await writeFile(join(directory, `${expected.artifact.d}.json`), 'corrupt');
      expect(await custody.commit({ ...expected, evaluationId })).toEqual({ kind: 'Conflict' });
      expect(await custody.inspect(expected.artifact.d)).toEqual({ kind: 'Unavailable' });
      expect(await custody.inspectEvaluation(evaluationId)).toEqual({ kind: 'Unavailable' });
      const other = record();
      const target = join(directory, 'target');
      await writeFile(target, 'target');
      await rm(join(directory, `${other.artifact.d}.json`));
      await symlink(target, join(directory, `${other.artifact.d}.json`));
      expect(await custody.commit({ ...other, evaluationId })).toEqual({ kind: 'Conflict' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
