import { Saider } from 'signify-ts';
import { describe, expect, it } from 'vitest';

import { decodeEvaluationPolicy, prepareEvaluationPolicy } from './policy.js';

const said = (value: string): string => `E${value.repeat(43)}`;
const allowance = {
  providerRequests: 2,
  providerInputTokens: 2000,
  providerOutputTokens: 200,
  providerSpendMicroUsd: 200,
  runWallTimeSeconds: 20,
  toolProposals: 20,
  aggregateChildCommandTimeSeconds: 10,
  changedFiles: 2,
  changedWorktreeBytes: 2000,
  evidencePlusArtifactsPerRunBytes: 20000,
};

function input() {
  return {
    taskId: 'bbb13317-1c5e-4472-842e-692da01386cf',
    taskRevisionSaid: said('a'),
    originRunId: '91d7f67f-d2f9-4fae-87cc-ac827de6f0d1',
    expectedActiveRevisionSaid: said('b'),
    executionProfileSaid: said('c'),
    sourceInventorySaid: said('d'),
    comparisonLaw: 'ThreeRepetitionsTwoAttemptsPublicSearch',
    allocation: { diagnosis: allowance, perEntry: allowance, finalization: allowance },
  };
}

describe('closed E3 evaluation policy', () => {
  it('binds the retained Run, exact profile and source references and finite comparison law', () => {
    const prepared = prepareEvaluationPolicy(input());
    expect(prepared.kind).toBe('Prepared');
    if (prepared.kind !== 'Prepared') return;
    expect(decodeEvaluationPolicy(prepared.policy)).toEqual({
      kind: 'Accepted',
      policy: prepared.policy,
    });
    expect(prepared.policy.d).toMatch(/^E[A-Za-z0-9_-]{43}$/u);
  });

  it('rejects changed profile bytes, hidden instructions and a re-signed alternate comparison law', () => {
    const prepared = prepareEvaluationPolicy(input());
    if (prepared.kind !== 'Prepared') throw new Error('policy rejected');
    expect(decodeEvaluationPolicy({ ...prepared.policy, sourceInventorySaid: said('z') })).toEqual({
      kind: 'Rejected',
      reason: 'SaidMismatch',
    });
    expect(prepareEvaluationPolicy({ ...input(), hiddenAnswers: ['accept'] }).kind).toBe(
      'Rejected',
    );
    const different: unknown = Saider.saidify({
      ...prepared.policy,
      d: '',
      comparisonLaw: 'OneFavorableTrial',
    })[1];
    expect(decodeEvaluationPolicy(different).kind).toBe('Rejected');
  });

  it('rejects an allocation that starves either public search attempt', () => {
    const candidate = input();
    expect(
      prepareEvaluationPolicy({
        ...candidate,
        allocation: {
          ...candidate.allocation,
          perEntry: { ...candidate.allocation.perEntry, providerRequests: 1 },
        },
      }),
    ).toEqual({ kind: 'Rejected', reason: 'AllocationInvalid' });
  });
});
