import { createHash } from 'node:crypto';

import { prepareEvaluationManifest } from '@devrandom/protocol';
import { describe, expect, it, vi } from 'vitest';

import { ProvisionalSubmissionAuthorization } from './provisional-submission-authorization.js';

const said = (character: string): string => `E${character.repeat(43)}`;
const id = (digit: string): string =>
  `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const budget = {
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
    allocation: { diagnosis: budget, perEntry: budget, finalization: budget },
  });
  if (prepared.kind !== 'Prepared') throw new Error('Fixture manifest invalid.');
  const manifest = prepared.manifest;
  const binding = {
    kind: 'Evaluation' as const,
    taskId: manifest.taskId,
    taskRevisionSaid: manifest.taskRevisionSaid,
    originRunId: manifest.originRunId,
    personalAgentAid: manifest.personalAgentAid,
    taskMandateSaid: manifest.taskMandateSaid,
    harnessRevisionSaid: manifest.revisions.C2,
    evaluationId: manifest.evaluationId,
    evaluationLeaseId: id('4'),
    evidenceStreamId: id('5'),
    phase: {
      kind: 'Trial' as const,
      manifestSaid: manifest.d,
      arm: 'C2' as const,
      repetition: 1 as const,
      attempt: 1 as const,
    },
  };
  const proposal = {
    piSessionId: 'session',
    modelTurnId: 'session:1',
    toolCallId: 'submit-1',
    proposalIndex: 0,
    input: { kind: 'SubmitResult' as const, artifactSaids: [said('z')] },
  };
  const resource = `submission://sha256:${createHash('sha256')
    .update(proposal.input.artifactSaids.join('\u0000'))
    .digest('hex')}`;
  const resolve = vi.fn().mockReturnValue({ kind: 'Resolved', resource });
  const inspectMandate = vi.fn().mockResolvedValue({
    kind: 'Current',
    mandateSaid: manifest.taskMandateSaid,
    allowedCapabilities: ['SubmitResult'],
  });
  const inspectLease = vi
    .fn()
    .mockResolvedValue({ kind: 'Held', expiresAt: '2026-09-26T12:00:00.000Z' });
  const inspectCapacity = vi.fn().mockResolvedValue({ kind: 'Available' });
  const authority = new ProvisionalSubmissionAuthorization({
    manifest,
    activeTools: [{ name: 'submit_result', requiredCapability: 'SubmitResult' }],
    resources: { resolve },
    mandate: { inspect: inspectMandate },
    lease: { inspect: inspectLease },
    capacity: { inspect: inspectCapacity },
  });
  return {
    authority,
    binding,
    proposal,
    manifest,
    resource,
    resolve,
    inspectMandate,
    inspectLease,
    inspectCapacity,
  };
}

describe('C2 provisional SubmitResult authorization', () => {
  it('checks the exact Evaluation authority without enacting or writing a Run effect', async () => {
    const given = fixture();
    expect(
      await given.authority.authorize({
        binding: given.binding,
        proposal: given.proposal,
        signal: new AbortController().signal,
      }),
    ).toEqual({ kind: 'Authorized' });
    expect(given.inspectMandate).toHaveBeenCalledWith({
      taskRevisionSaid: given.manifest.taskRevisionSaid,
      taskMandateSaid: given.manifest.taskMandateSaid,
      tool: 'submit_result',
      requiredCapability: 'SubmitResult',
      resource: given.resource,
    });
    expect(given.inspectLease).toHaveBeenCalledWith(given.binding);
    expect(given.inspectCapacity).toHaveBeenCalledWith(given.binding);
    expect(
      await given.authority.authorize({
        binding: given.binding,
        proposal: given.proposal,
        signal: new AbortController().signal,
      }),
    ).toEqual({ kind: 'Denied' });
    expect(given.inspectCapacity).toHaveBeenCalledTimes(1);
  });

  it('denies predecessor rights, wrong resource, revoked mandate, lost lease and exhausted budget', async () => {
    const predecessor = fixture();
    expect(
      await predecessor.authority.authorize({
        binding: { ...predecessor.binding, evaluationLeaseId: predecessor.binding.originRunId },
        proposal: predecessor.proposal,
        signal: new AbortController().signal,
      }),
    ).toEqual({ kind: 'Denied' });
    expect(predecessor.inspectMandate).not.toHaveBeenCalled();

    const resource = fixture();
    resource.resolve.mockReturnValue({ kind: 'Denied', reason: 'ArgumentsInvalid' });
    expect(
      await resource.authority.authorize({
        binding: resource.binding,
        proposal: resource.proposal,
        signal: new AbortController().signal,
      }),
    ).toEqual({ kind: 'Denied' });
    expect(resource.inspectMandate).not.toHaveBeenCalled();

    const substitutedResource = fixture();
    substitutedResource.resolve.mockReturnValue({
      kind: 'Resolved',
      resource: `submission://sha256:${'a'.repeat(64)}`,
    });
    expect(
      await substitutedResource.authority.authorize({
        binding: substitutedResource.binding,
        proposal: substitutedResource.proposal,
        signal: new AbortController().signal,
      }),
    ).toEqual({ kind: 'Denied' });

    const mandate = fixture();
    mandate.inspectMandate.mockResolvedValue({ kind: 'Revoked' });
    expect(
      await mandate.authority.authorize({
        binding: mandate.binding,
        proposal: mandate.proposal,
        signal: new AbortController().signal,
      }),
    ).toEqual({ kind: 'Denied' });
    expect(mandate.inspectLease).not.toHaveBeenCalled();

    const substitutedMandate = fixture();
    substitutedMandate.inspectMandate.mockResolvedValue({
      kind: 'Current',
      mandateSaid: said('x'),
      allowedCapabilities: ['SubmitResult'],
    });
    expect(
      await substitutedMandate.authority.authorize({
        binding: substitutedMandate.binding,
        proposal: substitutedMandate.proposal,
        signal: new AbortController().signal,
      }),
    ).toEqual({ kind: 'Denied' });

    const lease = fixture();
    lease.inspectLease.mockResolvedValue({ kind: 'Lost' });
    expect(
      await lease.authority.authorize({
        binding: lease.binding,
        proposal: lease.proposal,
        signal: new AbortController().signal,
      }),
    ).toEqual({ kind: 'Denied' });
    expect(lease.inspectCapacity).not.toHaveBeenCalled();

    const capacity = fixture();
    capacity.inspectCapacity.mockResolvedValue({ kind: 'Exhausted' });
    expect(
      await capacity.authority.authorize({
        binding: capacity.binding,
        proposal: capacity.proposal,
        signal: new AbortController().signal,
      }),
    ).toEqual({ kind: 'Denied' });
  });
});
