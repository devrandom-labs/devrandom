import { comparisonSlots } from '@devrandom/domain';
import {
  decodeEvaluationClosureEvidenceIndex,
  prepareEvaluationEvidenceEvent,
  prepareEvaluationManifest,
  prepareTrialObservationEvidence,
  type EvaluationEvidenceEvent,
} from '@devrandom/protocol';
import { expect, it, vi } from 'vitest';

import { fixture, said } from '../../../test/promotion-evidence-fixture.js';
import { reviewPromotionProtectedSchedule } from './review-promotion-protected-schedule.js';

const evaluationId = '11111111-1111-4111-8111-111111111111';
const taskId = '55555555-5555-4555-8555-555555555555';
const originRunId = '44444444-4444-4444-8444-444444444444';
const streamId = '33333333-3333-4333-8333-333333333333';

function manifest() {
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
  return prepared.manifest;
}

function preparedFixture() {
  const M = manifest();
  const { command } = fixture(M.d);
  const indexBytes = Buffer.from(command.evidenceIndex.bytesBase64Url, 'base64url');
  const decodedIndex = decodeEvaluationClosureEvidenceIndex(
    command.evidenceIndex.artifact,
    indexBytes,
  );
  if (decodedIndex.kind !== 'Accepted') throw new Error('index rejected');
  const raw = new Map<
    string,
    { artifact: (typeof command.evidenceIndex)['artifact']; bytes: Uint8Array }
  >();
  const events: EvaluationEvidenceEvent[] = [];
  const observations = comparisonSlots().map((slot, position) => {
    const protectedObservationSaid = `E${String(500 + position).padStart(43, '0')}`;
    const prepared = prepareTrialObservationEvidence({
      version: 1,
      kind: 'TrialObservationEvidence',
      evaluationId,
      manifestSaid: M.d,
      harnessRevisionSaid: slot.arm === 'H1TaskSearch' ? M.revisions.H1 : M.revisions[slot.arm],
      observation: {
        slot,
        disposition: {
          kind: 'Measured',
          artifactSaid: said('Z'),
          publicConditionIds: [...M.publicConditionIds],
          heldOutConditionIds: [said('x')],
          usage: {
            providerRequests: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            spendMicroUsd: 0,
            elapsedMilliseconds: 0,
            repeatedFailures: 0,
            unsafeProposals: 0,
            unsafePrevented: 0,
            unsafeEffects: 0,
          },
        },
      },
      capturedSourceSaid: said('s'),
      trialEvidenceHeadSaid: said('e'),
      trialCleanupReceiptSaid: said('u'),
      publicObservations: M.publicConditionIds.map((conditionId, index) => ({
        conditionId,
        rawObservationSaid: `E${String(1000 + position * 3 + index).padStart(43, '0')}`,
        verdict: 'Pass',
      })),
      protectedObservationSaid,
      protectedVerdict: 'Pass',
      protectedCleanupReceiptSaid: said('c'),
      providerUsageEventSaids: [],
    });
    if (prepared.kind !== 'Prepared') throw new Error('trial rejected');
    raw.set(prepared.artifact.d, { artifact: prepared.artifact, bytes: prepared.bytes });
    for (const [artifactSaid, custody] of [
      [prepared.artifact.d, 'Public'],
      [protectedObservationSaid, 'ProtectedCiphertext'],
    ] as const) {
      const previous = events.at(-1);
      const captured = prepareEvaluationEvidenceEvent({
        evaluationId,
        streamId,
        originRunId,
        taskId,
        taskRevisionSaid: M.taskRevisionSaid,
        personalAgentAid: M.personalAgentAid,
        taskMandateSaid: M.taskMandateSaid,
        harnessRevisionSaid: prepared.evidence.harnessRevisionSaid,
        phase: { kind: 'Trial', manifestSaid: M.d, ...slot },
        sequence: events.length,
        previous:
          previous === undefined
            ? { kind: 'Genesis' }
            : { kind: 'Previous', eventSaid: previous.d },
        occurredAt: '2026-09-26T05:00:00.000Z',
        detail: { kind: 'ArtifactCaptured', artifactSaid, custody },
      });
      if (captured.kind !== 'Prepared') throw new Error('capture rejected');
      events.push(captured.event);
    }
    return { slot, artifactSaid: prepared.artifact.d };
  });
  return {
    manifest: M,
    index: { ...decodedIndex.index, observations },
    events,
    raw,
  };
}

it('requires the entire M-bound 18-slot protected schedule and exact captured evidence before audit review', async () => {
  const evidence = preparedFixture();
  const regrade = vi.fn(() =>
    Promise.resolve({ kind: 'Verified' as const, verdict: 'Pass' as const }),
  );
  const reading = {
    openPublic: ({ artifactSaid }: { evaluationId: string; artifactSaid: string }) => {
      const found = evidence.raw.get(artifactSaid);
      return Promise.resolve(
        found === undefined ? { kind: 'Missing' as const } : { kind: 'Opened' as const, ...found },
      );
    },
  };
  expect(
    await reviewPromotionProtectedSchedule(
      { manifest: evidence.manifest, index: evidence.index, acceptedEvents: evidence.events },
      { reading, regrading: { regrade } },
    ),
  ).toEqual({
    kind: 'Regraded',
    slots: comparisonSlots().map((slot) => ({ slot, verdict: 'Pass' })),
  });
  expect(regrade).toHaveBeenCalledTimes(18);
  expect(
    await reviewPromotionProtectedSchedule(
      {
        manifest: evidence.manifest,
        index: evidence.index,
        acceptedEvents: evidence.events.slice(0, -1),
      },
      { reading, regrading: { regrade } },
    ),
  ).toEqual({ kind: 'Incomplete' });
  expect(
    await reviewPromotionProtectedSchedule(
      {
        manifest: evidence.manifest,
        index: { ...evidence.index, observations: evidence.index.observations.slice(1) },
        acceptedEvents: evidence.events,
      },
      { reading, regrading: { regrade } },
    ),
  ).toEqual({ kind: 'Incomplete' });
});
