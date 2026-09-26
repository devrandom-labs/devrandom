import {
  decodeEvaluationClosureEvidenceIndex,
  prepareEvaluationManifest,
  type EvaluationEvidenceEvent,
} from '@devrandom/protocol';
import { describe, expect, it, vi } from 'vitest';

import { fixture, said } from '../../../test/promotion-evidence-fixture.js';
import { openPromotionCustody } from './open-promotion-custody.js';

const evaluationId = '11111111-1111-4111-8111-111111111111';
const taskId = '55555555-5555-4555-8555-555555555555';
const originRunId = '44444444-4444-4444-8444-444444444444';
const leaseId = '22222222-2222-4222-8222-222222222222';
const streamId = '33333333-3333-4333-8333-333333333333';

function manifest() {
  const allowance = {
    providerRequests: 1,
    providerInputTokens: 100,
    providerOutputTokens: 100,
    providerSpendMicroUsd: 100,
    runWallTimeSeconds: 10,
    toolProposals: 10,
    aggregateChildCommandTimeSeconds: 10,
    changedFiles: 1,
    changedWorktreeBytes: 100,
    evidencePlusArtifactsPerRunBytes: 10_000,
  };
  const prepared = prepareEvaluationManifest({
    evaluationId,
    taskId,
    taskRevisionSaid: said('T'),
    originRunId,
    ownerAid: said('O'),
    personalAgentAid: said('A'),
    taskMandateSaid: said('D'),
    retainedCheckpointSaid: said('K'),
    retainedSealSaid: said('L'),
    policySaid: said('P'),
    revisions: { H1: said('R'), C1: said('1'), C2: said('2'), C3: said('3') },
    executionProfileSaid: said('E'),
    sourceInventorySaid: said('S'),
    hypothesisSaid: said('H'),
    verifierSaid: said('V'),
    protectedCaseArtifactSaid: said('X'),
    finalCaseArtifactSaid: said('Y'),
    publicConditionIds: ['cesr-current', 'cesr-tamper', 'cesr-legacy'],
    heldOutCaseCount: 1,
    allocation: { diagnosis: allowance, perEntry: allowance, finalization: allowance },
  });
  if (prepared.kind !== 'Prepared') throw new Error(`manifest fixture: ${prepared.reason}`);
  return prepared.manifest;
}

describe('promotion custody hosted reconciliation', () => {
  const bindingFor = (M: ReturnType<typeof manifest>) => ({
    kind: 'Evaluation' as const,
    evaluationId,
    evaluationLeaseId: leaseId,
    evidenceStreamId: streamId,
    originRunId,
    taskId,
    taskRevisionSaid: M.taskRevisionSaid,
    personalAgentAid: M.personalAgentAid,
    taskMandateSaid: M.taskMandateSaid,
    harnessRevisionSaid: M.revisions.H1,
    phase: {
      kind: 'Trial' as const,
      manifestSaid: M.d,
      arm: 'H1TaskSearch' as const,
      repetition: 3 as const,
      attempt: 2 as const,
    },
  });

  it('does not promote locally staged bytes into accepted evidence when the host has no closure', async () => {
    const M = manifest();
    const { command } = fixture(M.d);
    const closeEvidence = vi.fn(() => Promise.resolve({ kind: 'Incomplete' as const }));
    const openPrefix = vi.fn(() => Promise.resolve({ kind: 'Missing' as const }));
    const openPublic = vi.fn(() => Promise.resolve({ kind: 'Missing' as const }));
    const staged = {
      kind: 'Staged' as const,
      closureCommand: command,
      index: fixtureIndex(command),
    };
    expect(
      await openPromotionCustody(
        { closureSaid: command.closure.d, manifest: M, terminalBinding: bindingFor(M) },
        { inspect: () => Promise.resolve(staged) },
        { closeEvidence },
        { openPrefix, openPublic },
      ),
    ).toEqual({ kind: 'Missing' });
    expect(closeEvidence).toHaveBeenCalledOnce();
    expect(openPrefix).not.toHaveBeenCalled();
    expect(openPublic).not.toHaveBeenCalled();
  });

  it('refuses a hosted closure whose captured prefix has no exact public raw artifact', async () => {
    const M = manifest();
    const { command } = fixture(M.d);
    const index = fixtureIndex(command);
    const captured = [
      ...index.observations.map((entry) => entry.artifactSaid),
      ...index.measurements.map((entry) => entry.artifactSaid),
      ...index.audits.map((entry) => entry.assessmentArtifactSaid),
    ];
    const events = [
      ...captured.map((artifactSaid) => ({
        detail: { kind: 'ArtifactCaptured', artifactSaid, custody: 'Public' },
      })),
      { detail: { kind: 'TrialStopped' } },
      { detail: { kind: 'TrialStopped' } },
      {
        d: command.closure.acceptedHeadSaid,
        detail: { kind: 'EvaluationBudgetCovered' },
      },
    ] as unknown as EvaluationEvidenceEvent[];
    const openPublic = vi.fn(() => Promise.resolve({ kind: 'Missing' as const }));
    expect(
      await openPromotionCustody(
        { closureSaid: command.closure.d, manifest: M, terminalBinding: bindingFor(M) },
        {
          inspect: () => Promise.resolve({ kind: 'Staged', closureCommand: command, index }),
        },
        {
          closeEvidence: () =>
            Promise.resolve({ kind: 'AlreadyClosed', closureSaid: command.closure.d }),
        },
        { openPrefix: () => Promise.resolve({ kind: 'Acknowledged', events }), openPublic },
      ),
    ).toEqual({ kind: 'Missing' });
    expect(openPublic).toHaveBeenCalledWith({
      evaluationId,
      artifactSaid: index.observations[0]?.artifactSaid,
    });
  });
});

function fixtureIndex(command: ReturnType<typeof fixture>['command']) {
  const bytes = Buffer.from(command.evidenceIndex.bytesBase64Url, 'base64url');
  const decoded = decodeEvaluationClosureEvidenceIndex(command.evidenceIndex.artifact, bytes);
  if (decoded.kind !== 'Accepted') throw new Error('index fixture invalid');
  return decoded.index;
}
