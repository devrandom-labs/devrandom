import { prepareEvidenceArtifact } from '@devrandom/protocol';
import { describe, expect, it, vi } from 'vitest';

import { selectVersionedFormatHistory } from './select-versioned-format-history.js';

const said = (character: string): string => `E${character.repeat(43)}`;

function source(kind: 'Contract' | 'Failure' | 'Edit', version: string, text: string) {
  const bytes = Buffer.from(text);
  const prepared = prepareEvidenceArtifact(bytes, 'text/plain; charset=utf-8');
  if (prepared.kind !== 'Prepared') throw new Error('Fixture artifact invalid.');
  return {
    sourceId: prepared.artifact.d,
    artifact: prepared.artifact,
    bytes,
    kind,
    version,
    custody: 'Public' as const,
  };
}

const policy = {
  version: 1 as const,
  arm: 'C3' as const,
  formatMarker: 'CESR-v1',
  triggerPaths: ['src/lib.rs'],
  priority: ['Failure', 'Contract', 'Edit'] as const,
  maximumItems: 2,
  maximumContextBytes: 4096,
};

describe('versioned-format ContextSelection', () => {
  it('selects ordered current public history with exact included/excluded identities', async () => {
    const contract = source('Contract', 'CESR-v1', 'Public CESR format contract');
    const failure = source('Failure', 'CESR-v1', 'Previous public verifier failure');
    const edit = source('Edit', 'CESR-v1', 'Prior edit note');
    const stale = source('Failure', 'CESR-v0', 'Legacy-only note');
    const project = vi.fn().mockImplementation((input: { sourceId: string }) =>
      Promise.resolve({
        kind: 'Projected',
        sourceId: input.sourceId,
        text: `Reviewed ${input.sourceId}`,
      }),
    );
    const selected = await selectVersionedFormatHistory(
      {
        policy,
        taskId: 'task',
        taskRevisionSaid: said('t'),
        sourceInventorySaid: said('i'),
        edit: { path: 'src/lib.rs', content: '// CESR-v1 formatting edit' },
        sources: [contract, edit, stale, failure],
      },
      { project },
    );
    expect(selected).toMatchObject({
      kind: 'Selected',
      includedSourceIds: [failure.sourceId, contract.sourceId],
      excludedSourceIds: [stale.sourceId, edit.sourceId],
    });
    expect(project).toHaveBeenCalledTimes(2);
    if (selected.kind !== 'Selected') return;
    expect(selected.contextText.indexOf(failure.sourceId)).toBeLessThan(
      selected.contextText.indexOf(contract.sourceId),
    );
    expect(selected.contextBytes).toBe(Buffer.byteLength(selected.contextText));
  });

  it('blocks nontrigger edits, missing raw custody, private bytes and substituted projections', async () => {
    const publicSource = source('Failure', 'CESR-v1', 'Public failure');
    const project = vi.fn().mockResolvedValue({
      kind: 'Projected',
      sourceId: publicSource.sourceId,
      text: 'Reviewed public failure',
    });
    const input = {
      policy,
      taskId: 'task',
      taskRevisionSaid: said('t'),
      sourceInventorySaid: said('i'),
      edit: { path: 'src/lib.rs', content: '// CESR-v1 formatting edit' },
      sources: [publicSource],
    };
    expect(
      await selectVersionedFormatHistory(
        { ...input, edit: { path: 'src/other.rs', content: input.edit.content } },
        { project },
      ),
    ).toEqual({ kind: 'Blocked' });
    expect(
      await selectVersionedFormatHistory(
        { ...input, sources: [{ ...publicSource, bytes: Buffer.from('tampered') }] },
        { project },
      ),
    ).toEqual({ kind: 'Blocked' });
    expect(
      await selectVersionedFormatHistory(
        { ...input, sources: [{ ...publicSource, custody: 'Protected' as const }] },
        { project },
      ),
    ).toEqual({ kind: 'Blocked' });
    project.mockResolvedValue({ kind: 'Projected', sourceId: said('x'), text: 'wrong source' });
    expect(await selectVersionedFormatHistory(input, { project })).toEqual({ kind: 'Blocked' });
  });
});
