import { prepareEvaluationManifest } from '@devrandom/protocol';
import { describe, expect, it } from 'vitest';

import { runProtectedTrial } from './run-protected-trial.js';

const said = (character: string): string => `E${character.repeat(43)}`;
const id = (digit: string): string =>
  `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const allowance = {
  providerRequests: 2,
  providerInputTokens: 2000,
  providerOutputTokens: 200,
  providerSpendMicroUsd: 100,
  runWallTimeSeconds: 30,
  toolProposals: 20,
  aggregateChildCommandTimeSeconds: 30,
  changedFiles: 2,
  changedWorktreeBytes: 2000,
  evidencePlusArtifactsPerRunBytes: 10000,
};
function fixture() {
  const prepared = prepareEvaluationManifest({
    evaluationId: id('1'),
    taskId: id('2'),
    taskRevisionSaid: said('t'),
    originRunId: id('3'),
    ownerAid: said('o'),
    personalAgentAid: said('a'),
    taskMandateSaid: said('m'),
    retainedCheckpointSaid: said('c'),
    retainedSealSaid: said('s'),
    policySaid: said('p'),
    revisions: { H1: said('h'), C1: said('j'), C2: said('k'), C3: said('l') },
    executionProfileSaid: said('e'),
    sourceInventorySaid: said('i'),
    hypothesisSaid: said('H'),
    verifierSaid: said('v'),
    protectedCaseArtifactSaid: said('q'),
    finalCaseArtifactSaid: said('f'),
    publicConditionIds: ['cesr-current'],
    heldOutCaseCount: 1,
    allocation: { diagnosis: allowance, perEntry: allowance, finalization: allowance },
  });
  if (prepared.kind !== 'Prepared') throw new Error('manifest rejected');
  const binding = {
    kind: 'Evaluation' as const,
    taskId: id('2'),
    taskRevisionSaid: said('t'),
    originRunId: id('3'),
    personalAgentAid: said('a'),
    taskMandateSaid: said('m'),
    harnessRevisionSaid: said('k'),
    evaluationId: id('1'),
    evaluationLeaseId: id('4'),
    evidenceStreamId: id('5'),
    phase: {
      kind: 'Trial' as const,
      manifestSaid: prepared.manifest.d,
      arm: 'C2' as const,
      repetition: 1 as const,
      attempt: 1 as const,
    },
  };
  const lease = {
    evaluationId: id('1'),
    leaseId: id('4'),
    version: 1,
    serverTime: '2026-09-26T03:00:00.000Z',
    expiresAt: '2026-09-26T03:00:45.000Z',
  };
  return { manifest: prepared.manifest, binding, lease };
}

describe('protected trial admission before worker construction', () => {
  it('runs only an exact candidate, manifest slot and live evaluation lease', async () => {
    const { manifest, binding, lease } = fixture();
    let called = 0;
    const result = await runProtectedTrial(
      {
        manifest,
        binding,
        lease,
        leaseRequestStartedAt: 1000,
        now: 2000,
        cleanSourceSaid: said('r'),
        reviewedBehaviorSaid: said('b'),
        modelProfileSaid: said('d'),
        containerProfileSaid: said('e'),
        signal: new AbortController().signal,
      },
      {
        run: () => {
          called += 1;
          return Promise.resolve({
            kind: 'Stopped',
            capturedSourceSaid: said('x'),
            evidenceHeadSaid: said('y'),
            providerUsageEventSaids: [said('z')],
            cleanupReceiptSaid: said('u'),
          });
        },
      },
    );
    expect(result.kind).toBe('Executed');
    expect(called).toBe(1);
  });

  it('does not construct a worker for revision substitution or stale rights', async () => {
    const { manifest, binding, lease } = fixture();
    let called = 0;
    const execution = {
      run: () => {
        called += 1;
        return Promise.reject(new Error('unreachable'));
      },
    };
    const base = {
      manifest,
      binding,
      lease,
      leaseRequestStartedAt: 1000,
      now: 2000,
      cleanSourceSaid: said('r'),
      reviewedBehaviorSaid: said('b'),
      modelProfileSaid: said('d'),
      containerProfileSaid: said('e'),
      signal: new AbortController().signal,
    };
    expect(
      (
        await runProtectedTrial(
          { ...base, binding: { ...binding, harnessRevisionSaid: said('h') } },
          execution,
        )
      ).kind,
    ).toBe('Rejected');
    expect((await runProtectedTrial({ ...base, now: 41000 }, execution)).kind).toBe('Rejected');
    expect(called).toBe(0);
  });
});
