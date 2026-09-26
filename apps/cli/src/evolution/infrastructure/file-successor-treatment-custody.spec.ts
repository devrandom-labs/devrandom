import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { prepareEvidenceArtifact, prepareSuccessorHarnessRevision } from '@devrandom/protocol';
import { FileSuccessorTreatmentCustody } from './file-successor-treatment-custody.js';
const said = (letter: string) => `E${letter.repeat(43)}`;
it('reopens exact immutable treatment bytes after restart and rejects substituted bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devrandom-successor-custody-'));
  const evaluationId = randomUUID();
  try {
    const bytes = Buffer.from(
      '{"version":1,"arm":"C1","instructionText":"Check group-local version scope."}',
    );
    const artifact = prepareEvidenceArtifact(bytes, 'application/json');
    if (artifact.kind !== 'Prepared') throw new Error('fixture');
    const prepared = prepareSuccessorHarnessRevision({
      parentRevisionSaid: said('h'),
      h0Said: said('o'),
      taskRevisionSaid: said('t'),
      sourceInventorySaid: said('i'),
      executionProfileSaid: said('p'),
      configurationArtifactSaid: artifact.artifact.d,
      arm: 'C1',
      treatment: { kind: 'Instruction' },
    });
    if (prepared.kind !== 'Prepared') throw new Error('fixture');
    const candidate = {
      revision: prepared.revision,
      configuration: { artifact: artifact.artifact, bytes },
      branch: {
        arm: 'C1' as const,
        branch: 'devrandom/c1',
        directory: root,
        parentCommit: '1'.repeat(40),
        commit: '2'.repeat(40),
        tree: '3'.repeat(40),
      },
    };
    const custody = new FileSuccessorTreatmentCustody(root);
    expect(await custody.retain(evaluationId, candidate)).toEqual({ kind: 'Retained' });
    const reopened = await new FileSuccessorTreatmentCustody(root).read(
      evaluationId,
      prepared.revision.d,
    );
    expect(reopened).toMatchObject({ kind: 'Read', candidate: { revision: prepared.revision } });
    expect(
      await custody.retain(evaluationId, {
        ...candidate,
        configuration: { ...candidate.configuration, bytes: Buffer.from('substituted') },
      }),
    ).toEqual({ kind: 'Rejected' });
    const path = join(
      root,
      'evaluations',
      evaluationId,
      'successors',
      `${prepared.revision.d}.json`,
    );
    const document = JSON.parse(await readFile(path, 'utf8')) as {
      configuration: { bytesBase64Url: string };
    };
    document.configuration.bytesBase64Url = Buffer.from('substituted').toString('base64url');
    await writeFile(path, JSON.stringify(document));
    expect(await custody.read(evaluationId, prepared.revision.d)).toEqual({ kind: 'Unavailable' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
