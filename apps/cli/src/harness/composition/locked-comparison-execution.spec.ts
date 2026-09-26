import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareEvidenceArtifact } from '@devrandom/protocol';
import { expect, it, vi } from 'vitest';
import { fixture, said } from '../../../test/promotion-evidence-fixture.js';
import {
  retryRetainedComparisonClosure,
  withinFinalizationWall,
} from './locked-comparison-execution.js';

it('retries the identical sealed closure after a lost acknowledgement without rerunning trials', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'comparison-closure-'));
  try {
    const { command } = fixture();
    const bytes = Buffer.from(JSON.stringify(command));
    const artifact = prepareEvidenceArtifact(bytes, 'application/json');
    if (artifact.kind !== 'Prepared') throw new Error('fixture');
    const closeEvidence = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'Unavailable' })
      .mockResolvedValueOnce({ kind: 'AlreadyClosed', closureSaid: command.closure.d });
    const input = {
      stateRoot: root,
      evaluationId: command.closure.evaluationId,
      manifestSaid: command.closure.manifestSaid,
      artifacts: [{ artifact: artifact.artifact, bytes }],
      hosted: { closeEvidence },
      signal: new AbortController().signal,
    };
    expect(await retryRetainedComparisonClosure(input)).toEqual({
      kind: 'Incomplete',
      frontier: 'Closure:Unavailable',
    });
    expect(await retryRetainedComparisonClosure(input)).toEqual({
      kind: 'Closed',
      closureSaid: command.closure.d,
    });
    expect(closeEvidence.mock.calls[0]?.[0]).toEqual(command);
    expect(closeEvidence.mock.calls[1]?.[0]).toEqual(command);
    expect(await retryRetainedComparisonClosure({ ...input, manifestSaid: said('z') })).toEqual({
      kind: 'Incomplete',
      frontier: 'ClosureManifest',
    });
    expect(closeEvidence).toHaveBeenCalledTimes(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('does not release a late signing or upload outcome after F expires', async () => {
  for (const kind of ['Signed', 'Closed'] as const) {
    let now = 0;
    const effect = vi.fn().mockImplementation(() => {
      now = 11;
      return Promise.resolve({ kind });
    });
    await expect(withinFinalizationWall(10, effect, () => now)).rejects.toThrow(
      'FinalizationBudget',
    );
    expect(effect).toHaveBeenCalledTimes(1);
    await expect(withinFinalizationWall(10, effect, () => now)).rejects.toThrow(
      'FinalizationBudget',
    );
    expect(effect).toHaveBeenCalledTimes(1);
  }
});
