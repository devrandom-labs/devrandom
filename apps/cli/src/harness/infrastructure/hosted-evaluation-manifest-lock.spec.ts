import { describe, expect, it, vi } from 'vitest';

import { prepareEvaluationManifest, prepareEvidenceArtifact } from '@devrandom/protocol';

import { HostedEvaluationManifestLock } from './hosted-evaluation-manifest-lock.js';

const said = (letter: string): string => `E${letter.repeat(43)}`;
const id = (letter: string): string =>
  `${letter.repeat(8)}-${letter.repeat(4)}-4${letter.repeat(3)}-8${letter.repeat(3)}-${letter.repeat(12)}`;
const allowance = {
  providerRequests: 2,
  providerInputTokens: 2_000,
  providerOutputTokens: 200,
  providerSpendMicroUsd: 200,
  runWallTimeSeconds: 20,
  toolProposals: 20,
  aggregateChildCommandTimeSeconds: 10,
  changedFiles: 2,
  changedWorktreeBytes: 2_000,
  evidencePlusArtifactsPerRunBytes: 20_000,
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
    revisions: { H1: said('h'), C1: said('i'), C2: said('j'), C3: said('k') },
    executionProfileSaid: said('e'),
    sourceInventorySaid: said('v'),
    verifierSaid: said('z'),
    protectedCaseArtifactSaid: said('q'),
    finalCaseArtifactSaid: said('f'),
    publicConditionIds: ['legacy'],
    heldOutCaseCount: 1,
    allocation: { diagnosis: allowance, perEntry: allowance, finalization: allowance },
  });
  if (prepared.kind !== 'Prepared') throw new Error(prepared.reason);
  const manifest = prepared.manifest;
  const lease = {
    evaluationId: manifest.evaluationId,
    leaseId: id('4'),
    version: 3,
    serverTime: '2026-09-26T09:20:00.000Z',
    expiresAt: '2026-09-26T09:20:45.000Z',
  };
  const receipt = {
    kind: 'Locked' as const,
    evaluationId: manifest.evaluationId,
    manifestSaid: manifest.d,
    ownerAid: manifest.ownerAid,
    policySaid: manifest.policySaid,
    leaseId: lease.leaseId,
    lockedAtLeaseVersion: 1,
    lockedAtEvaluationVersion: 2,
    currentLeaseVersion: 3,
    currentEvaluationVersion: 4,
  };
  return { manifest, lease, receipt };
}

describe('hosted Evaluation manifest lock', () => {
  it('returns current exact M and lease identity only after locally durable receipt custody', async () => {
    const { manifest, lease, receipt } = fixture();
    const bytes = new TextEncoder().encode(JSON.stringify(receipt));
    const prepared = prepareEvidenceArtifact(bytes, 'application/json');
    if (prepared.kind !== 'Prepared') throw new Error(prepared.reason);
    const inspectManifestLock = vi.fn().mockResolvedValue({ kind: 'Locked', receipt });
    const record = vi.fn().mockResolvedValue({ kind: 'Stored', artifact: prepared.artifact });
    const lock = new HostedEvaluationManifestLock({ inspectManifestLock }, { record });
    expect(await lock.inspect({ manifest, lease })).toEqual({
      kind: 'Acknowledged',
      evaluationId: manifest.evaluationId,
      manifestSaid: manifest.d,
      ownerAid: manifest.ownerAid,
      policySaid: manifest.policySaid,
      leaseId: lease.leaseId,
      leaseVersion: lease.version,
      acknowledgementSaid: prepared.artifact.d,
    });
    expect(record).toHaveBeenCalledWith({ bytes, mediaType: 'application/json' });
  });

  it('refuses a stale lease, changed owner, or unavailable receipt custody', async () => {
    const { manifest, lease, receipt } = fixture();
    const inspectManifestLock = vi.fn().mockResolvedValue({ kind: 'Locked', receipt });
    const record = vi.fn().mockResolvedValue({ kind: 'Unavailable' });
    const lock = new HostedEvaluationManifestLock({ inspectManifestLock }, { record });
    expect(await lock.inspect({ manifest, lease: { ...lease, version: 4 } })).toEqual({
      kind: 'Unlocked',
    });
    expect(record).not.toHaveBeenCalled();
    inspectManifestLock.mockResolvedValue({
      kind: 'Locked',
      receipt: { ...receipt, ownerAid: said('x') },
    });
    expect(await lock.inspect({ manifest, lease })).toEqual({ kind: 'Unlocked' });
    inspectManifestLock.mockResolvedValue({ kind: 'Locked', receipt });
    expect(await lock.inspect({ manifest, lease })).toEqual({ kind: 'Unavailable' });
  });
});
