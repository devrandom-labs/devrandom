import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { prepareEvidenceArtifact } from '@devrandom/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { FileSuccessorReplayCustody } from './file-successor-replay-custody.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('private successor replay custody', () => {
  it('retains exact parent raw bytes across process loss and denies a changed same-SAID file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devrandom-successor-replay-'));
    roots.push(root);
    const custody = new FileSuccessorReplayCustody(join(root, 'private'));
    const bytes = Buffer.from('{"kind":"NativePublicObservation"}');
    const stored = await custody.record({ bytes, mediaType: 'application/json' });
    expect(stored.kind).toBe('Stored');
    if (stored.kind !== 'Stored') return;
    const reopened = new FileSuccessorReplayCustody(join(root, 'private'));
    expect(await reopened.read(stored.artifact.d)).toEqual({
      kind: 'Read',
      artifact: stored.artifact,
      bytes,
    });
    expect(await reopened.retain({ artifact: stored.artifact, bytes })).toEqual({
      kind: 'Retained',
      artifactSaid: stored.artifact.d,
    });
    const other = Buffer.from('{"kind":"Forged"}');
    expect(await reopened.retain({ artifact: stored.artifact, bytes: other })).toEqual({
      kind: 'Unavailable',
    });
    const found = await readFile(join(root, 'private', stored.artifact.d));
    expect(found).toEqual(bytes);
    await chmod(join(root, 'private', stored.artifact.d), 0o600);
    await writeFile(join(root, 'private', stored.artifact.d), other);
    expect(await reopened.read(stored.artifact.d)).toEqual({ kind: 'Unavailable' });
  });

  it('rejects an artifact descriptor whose SAID does not match the retained bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devrandom-successor-replay-'));
    roots.push(root);
    const custody = new FileSuccessorReplayCustody(join(root, 'private'));
    const bytes = Buffer.from('actual');
    const other = prepareEvidenceArtifact(Buffer.from('other'), 'application/json');
    if (other.kind !== 'Prepared') throw new Error('fixture');
    expect(await custody.retain({ artifact: other.artifact, bytes })).toEqual({
      kind: 'Unavailable',
    });
  });
});
