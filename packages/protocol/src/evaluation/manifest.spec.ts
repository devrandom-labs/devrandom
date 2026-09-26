import { Saider } from 'signify-ts';
import { describe, expect, it } from 'vitest';

import { decodeEvaluationManifest, prepareEvaluationManifest } from './manifest.js';
import {
  decodeHarnessEvaluationBinding,
  prepareHarnessEvaluationBinding,
} from '../harness/evaluation-binding.js';

const said = (value: string): string => `E${value.repeat(43)}`;

function input() {
  return {
    evaluationId: '81d7f67f-d2f9-4fae-87cc-ac827de6f0d1',
    taskId: 'bbb13317-1c5e-4472-842e-692da01386cf',
    taskRevisionSaid: said('a'),
    originRunId: '91d7f67f-d2f9-4fae-87cc-ac827de6f0d1',
    ownerAid: said('b'),
    personalAgentAid: said('c'),
    taskMandateSaid: said('d'),
    retainedCheckpointSaid: said('e'),
    retainedSealSaid: said('f'),
    policySaid: said('g'),
    revisions: { H1: said('h'), C1: said('i'), C2: said('j'), C3: said('k') },
    executionProfileSaid: said('l'),
    sourceInventorySaid: said('m'),
    hypothesisSaid: said('q'),
    verifierSaid: said('n'),
    protectedCaseArtifactSaid: said('o'),
    finalCaseArtifactSaid: said('p'),
    publicConditionIds: ['cesr-current', 'cesr-tamper', 'cesr-legacy'],
    heldOutCaseCount: 1,
    allocation: {
      diagnosis: {
        providerRequests: 1,
        providerInputTokens: 1000,
        providerOutputTokens: 100,
        providerSpendMicroUsd: 100,
        runWallTimeSeconds: 10,
        toolProposals: 10,
        aggregateChildCommandTimeSeconds: 10,
        changedFiles: 2,
        changedWorktreeBytes: 2000,
        evidencePlusArtifactsPerRunBytes: 20000,
      },
      perEntry: {
        providerRequests: 2,
        providerInputTokens: 2000,
        providerOutputTokens: 200,
        providerSpendMicroUsd: 200,
        runWallTimeSeconds: 20,
        toolProposals: 20,
        aggregateChildCommandTimeSeconds: 20,
        changedFiles: 2,
        changedWorktreeBytes: 2000,
        evidencePlusArtifactsPerRunBytes: 20000,
      },
      finalization: {
        providerRequests: 1,
        providerInputTokens: 1000,
        providerOutputTokens: 100,
        providerSpendMicroUsd: 100,
        runWallTimeSeconds: 10,
        toolProposals: 10,
        aggregateChildCommandTimeSeconds: 10,
        changedFiles: 2,
        changedWorktreeBytes: 2000,
        evidencePlusArtifactsPerRunBytes: 20000,
      },
    },
  };
}

describe('frozen evaluation manifest and acyclic Harness association', () => {
  it('binds the actual required schedule and all immutable inputs before attaching revisions', () => {
    const prepared = prepareEvaluationManifest(input());
    if (prepared.kind !== 'Prepared') throw new Error('manifest rejected');
    expect(prepared.manifest.slots).toHaveLength(18);
    expect(decodeEvaluationManifest(prepared.manifest)).toEqual({
      kind: 'Accepted',
      manifest: prepared.manifest,
    });
    const binding = prepareHarnessEvaluationBinding(input().revisions.C2, prepared.manifest);
    if (binding.kind !== 'Prepared') throw new Error('association rejected');
    expect(decodeHarnessEvaluationBinding(binding.binding, prepared.manifest)).toEqual({
      kind: 'Accepted',
      binding: binding.binding,
    });
    expect(binding.binding.evaluationManifestSaid).toBe(prepared.manifest.d);
    expect(binding.binding.harnessRevisionSaid).toBe(input().revisions.C2);
    expect(prepared.manifest.revisions.C2).toBe(input().revisions.C2);
    expect(prepared.manifest.hypothesisSaid).toBe(input().hypothesisSaid);
  });

  it('rejects substituted artifacts and a re-signed incomplete schedule', () => {
    const prepared = prepareEvaluationManifest(input());
    if (prepared.kind !== 'Prepared') throw new Error('manifest rejected');
    expect(
      decodeEvaluationManifest({ ...prepared.manifest, executionProfileSaid: said('z') }),
    ).toEqual({ kind: 'Rejected', reason: 'SaidMismatch' });
    expect(decodeEvaluationManifest({ ...prepared.manifest, hypothesisSaid: said('z') })).toEqual({
      kind: 'Rejected',
      reason: 'SaidMismatch',
    });
    const changed: unknown = Saider.saidify({
      ...prepared.manifest,
      d: '',
      slots: prepared.manifest.slots.slice(1),
    })[1];
    expect(decodeEvaluationManifest(changed).kind).toBe('Rejected');
  });

  it('rejects candidate identity reuse, reused final holdout and hidden plaintext fields', () => {
    const original = input();
    for (const changed of [
      { ...original, revisions: { ...original.revisions, C1: original.revisions.H1 } },
      { ...original, finalCaseArtifactSaid: original.protectedCaseArtifactSaid },
      { ...original, hypothesisSaid: undefined },
      { ...original, hiddenAnswers: ['accept'] },
      { ...original, publicConditionIds: ['cesr-current', 'cesr-current'] },
    ])
      expect(prepareEvaluationManifest(changed).kind).toBe('Rejected');
  });

  it('cannot associate a revision outside the frozen candidate set or change the manifest link', () => {
    const prepared = prepareEvaluationManifest(input());
    if (prepared.kind !== 'Prepared') throw new Error('manifest rejected');
    expect(prepareHarnessEvaluationBinding(said('z'), prepared.manifest)).toEqual({
      kind: 'Rejected',
      reason: 'RevisionNotInManifest',
    });
    const binding = prepareHarnessEvaluationBinding(input().revisions.C1, prepared.manifest);
    if (binding.kind !== 'Prepared') throw new Error('association rejected');
    expect(
      decodeHarnessEvaluationBinding(
        { ...binding.binding, evaluationManifestSaid: said('z') },
        prepared.manifest,
      ).kind,
    ).toBe('Rejected');
  });
});
