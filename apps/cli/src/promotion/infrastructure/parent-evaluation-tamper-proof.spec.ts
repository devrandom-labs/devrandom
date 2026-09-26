import { comparisonSlots, tamperLifecycleRoles } from '@devrandom/domain';
import {
  prepareEvaluationEvidenceEvent,
  prepareEvaluationManifest,
  prepareEvidenceArtifact,
  type EvaluationEvidenceEvent,
} from '@devrandom/protocol';
import { expect, it } from 'vitest';

import { said } from '../../../test/promotion-evidence-fixture.js';
import {
  ParentEvaluationTamperProof,
  decodeTamperAttemptWindow,
  prepareProceduralIntegrityProof,
} from './parent-evaluation-tamper-proof.js';

const evaluationId = '11111111-1111-4111-8111-111111111111';
const taskId = '55555555-5555-4555-8555-555555555555';
const originRunId = '44444444-4444-4444-8444-444444444444';
const streamId = '33333333-3333-4333-8333-333333333333';

function fixture(interrupt: boolean) {
  const allowance = {
    providerRequests: 0,
    providerInputTokens: 0,
    providerOutputTokens: 0,
    providerSpendMicroUsd: 0,
    runWallTimeSeconds: 0,
    toolProposals: 0,
    aggregateChildCommandTimeSeconds: 0,
    changedFiles: 0,
    changedWorktreeBytes: 0,
    evidencePlusArtifactsPerRunBytes: 0,
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
  if (prepared.kind !== 'Prepared') throw new Error('manifest rejected');
  const manifest = prepared.manifest;
  const events: EvaluationEvidenceEvent[] = [];
  for (const slot of comparisonSlots()) {
    const previous = events.at(-1);
    const stopped = prepareEvaluationEvidenceEvent({
      evaluationId,
      streamId,
      originRunId,
      taskId,
      taskRevisionSaid: manifest.taskRevisionSaid,
      personalAgentAid: manifest.personalAgentAid,
      taskMandateSaid: manifest.taskMandateSaid,
      harnessRevisionSaid:
        slot.arm === 'H1TaskSearch' ? manifest.revisions.H1 : manifest.revisions[slot.arm],
      phase: { kind: 'Trial', manifestSaid: manifest.d, ...slot },
      sequence: events.length,
      previous:
        previous === undefined ? { kind: 'Genesis' } : { kind: 'Previous', eventSaid: previous.d },
      occurredAt: '2026-09-26T05:00:00.000Z',
      detail: {
        kind: 'TrialStopped',
        reason: interrupt && events.length === 0 ? 'Interrupted' : 'Completed',
      },
    });
    if (stopped.kind !== 'Prepared') throw new Error('stop rejected');
    events.push(stopped.event);
  }
  const prior = events.at(-1);
  if (prior === undefined) throw new Error('missing stopped event');
  const covered = prepareEvaluationEvidenceEvent({
    evaluationId,
    streamId,
    originRunId,
    taskId,
    taskRevisionSaid: manifest.taskRevisionSaid,
    personalAgentAid: manifest.personalAgentAid,
    taskMandateSaid: manifest.taskMandateSaid,
    harnessRevisionSaid: manifest.revisions.H1,
    phase: { kind: 'Trial', manifestSaid: manifest.d, ...comparisonSlots()[17] },
    sequence: events.length,
    previous: { kind: 'Previous', eventSaid: prior.d },
    occurredAt: '2026-09-26T05:00:00.000Z',
    detail: {
      kind: 'EvaluationBudgetCovered',
      throughSequence: prior.sequence,
      throughHeadSaid: prior.d,
      totals: {
        providerRequests: 0,
        providerInputTokens: 0,
        providerOutputTokens: 0,
        providerSpendMicroUsd: 0,
        runWallTimeSeconds: 0,
        toolProposals: 0,
        aggregateChildCommandTimeSeconds: 0,
        changedFiles: 0,
        changedWorktreeBytes: 0,
      },
      providerUsageEventSaids: [],
    },
  });
  if (covered.kind !== 'Prepared') throw new Error('coverage rejected');
  events.push(covered.event);
  return { manifest, events };
}

it('emits an independently replayable TrialStopped proof, not an opaque Pass claim', async () => {
  const { manifest, events } = fixture(false);
  const prepared = prepareProceduralIntegrityProof({
    manifest,
    acceptedEvents: events,
    scope: 'H1',
  });
  expect(prepared).toMatchObject({ kind: 'Prepared', proof: { observation: 'AllCompleted' } });
  if (prepared.kind !== 'Prepared') throw new Error(prepared.kind);
  expect(prepared.proof.trialStoppedEventSaids).toHaveLength(3);
  const inspector = new ParentEvaluationTamperProof(manifest, events);
  const claim = {
    scope: 'H1' as const,
    obligation: 'proceduralIntegrity' as const,
    proofSaid: prepared.artifact.d,
    artifact: prepared.artifact,
    bytes: prepared.bytes,
  };
  expect(await inspector.obligation(claim)).toEqual({ kind: 'Unavailable' });
  expect(await inspector.obligation({ ...claim, bytes: Buffer.from('{}') })).toEqual({
    kind: 'Unavailable',
  });
  const incomplete = new ParentEvaluationTamperProof(manifest, events.slice(0, -2));
  expect(await incomplete.obligation(claim)).toEqual({ kind: 'Unavailable' });
  const interrupted = fixture(true);
  const failed = prepareProceduralIntegrityProof({
    manifest: interrupted.manifest,
    acceptedEvents: interrupted.events,
    scope: 'H1',
  });
  expect(failed).toMatchObject({ kind: 'Prepared', proof: { observation: 'NotCompleted' } });
  if (failed.kind !== 'Prepared') throw new Error(failed.kind);
  expect(
    await new ParentEvaluationTamperProof(interrupted.manifest, interrupted.events).obligation({
      ...claim,
      proofSaid: failed.artifact.d,
      artifact: failed.artifact,
      bytes: failed.bytes,
    }),
  ).toEqual({
    kind: 'Verified',
    scope: 'H1',
    obligation: 'proceduralIntegrity',
    proofSaid: failed.artifact.d,
    finding: 'Fail',
  });
});

it('parses a five-role attempt-window artifact but never mistakes empty claimed attempts for verified coverage', async () => {
  const { manifest, events } = fixture(false);
  const window = {
    version: 1,
    kind: 'TamperAttemptWindow',
    evaluationId,
    manifestSaid: manifest.d,
    scope: 'H1',
    throughHeadSaid: events.at(-1)?.d,
    roles: tamperLifecycleRoles.map((role, index) => ({
      role,
      openedEventSaid: `E${String(index + 1).padStart(43, '0')}`,
      closedEventSaid: `E${String(index + 11).padStart(43, '0')}`,
      attempts: [],
    })),
  };
  const bytes = Buffer.from(JSON.stringify(window));
  const prepared = prepareEvidenceArtifact(bytes, 'application/json');
  if (prepared.kind !== 'Prepared') throw new Error('window artifact rejected');
  expect(decodeTamperAttemptWindow(prepared.artifact, bytes)).toMatchObject({
    kind: 'ParsedUnverified',
  });
  const inspector = new ParentEvaluationTamperProof(manifest, events);
  expect(
    await inspector.coverage({
      scope: 'H1',
      proofSaid: prepared.artifact.d,
      artifact: prepared.artifact,
      bytes,
      attempts: [],
    }),
  ).toEqual({ kind: 'Unavailable' });
  expect(decodeTamperAttemptWindow(prepared.artifact, Buffer.from('{}'))).toEqual({
    kind: 'Rejected',
  });
});
