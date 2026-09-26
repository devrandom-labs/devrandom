import { Buffer } from 'node:buffer';

import { comparisonSlots } from '@devrandom/domain';
import {
  prepareEvaluationManifest,
  prepareEvaluationVerifierBundle,
  prepareProtectedEvaluationArtifact,
  prepareTrialObservationEvidence,
} from '@devrandom/protocol';
import { describe, expect, it, vi } from 'vitest';

import { prepareComparisonMeasurements } from './prepare-comparison-measurements.js';
import { prepareMeasuredTrialObservation } from './prepare-measured-trial-observation.js';

const said = (character: string): string => `E${character.repeat(43)}`;
const evaluationId = '81d7f67f-d2f9-4fae-87cc-ac827de6f0d1';
const taskId = 'bbb13317-1c5e-4472-842e-692da01386cf';
const sourceRunId = '91d7f67f-d2f9-4fae-87cc-ac827de6f0d1';
const revisions = { H1: said('h'), C1: said('i'), C2: said('j'), C3: said('k') };
const usage = {
  providerRequests: 1,
  inputTokens: 100,
  outputTokens: 10,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  spendMicroUsd: 100,
  elapsedMilliseconds: 1000,
  repeatedFailures: 0,
  unsafeProposals: 0,
  unsafePrevented: 0,
  unsafeEffects: 0,
};

function encrypted(
  purpose: 'TrialHoldout' | 'OracleObservation' | 'TerminalCase',
  objectSaid: string,
  seed: number,
  segment: 0 | 1,
) {
  const prepared = prepareProtectedEvaluationArtifact({
    evaluationId,
    objectSaid,
    purpose,
    segment,
    nonce: Buffer.alloc(12, seed).toString('base64url'),
    tag: Buffer.alloc(16, seed).toString('base64url'),
    ciphertext: Buffer.from([seed]).toString('base64url'),
    plaintextByteCount: 1,
  });
  if (prepared.kind !== 'Prepared') throw new Error(prepared.reason);
  return prepared.artifact;
}

function fixture() {
  const protectedId = said('p');
  const terminalId = said('t');
  const verifier = prepareEvaluationVerifierBundle({
    evaluationId,
    taskId,
    taskRevisionSaid: said('a'),
    ownerAid: said('b'),
    personalAgentAid: said('c'),
    policySaid: said('g'),
    executionProfileSaid: said('l'),
    oracleAdapterDigest: `sha256:${'d'.repeat(64)}`,
    reviewedRecipeSaid: said('r'),
    toolchainSaid: said('u'),
    publicConditions: [
      {
        id: 'cesr-current',
        stimulusBase64Url: Buffer.from(`-AAL${said('x')}`).toString('base64url'),
        expected: { kind: 'Parsed', receipts: [{ version: 'Current', payload: said('x') }] },
      },
    ],
    protectedCase: {
      objectSaid: protectedId,
      stimulus: encrypted('TrialHoldout', protectedId, 1, 0),
      expected: encrypted('OracleObservation', protectedId, 2, 0),
    },
    terminalCase: {
      objectSaid: terminalId,
      stimulus: encrypted('TerminalCase', terminalId, 3, 1),
      expected: encrypted('OracleObservation', terminalId, 4, 1),
    },
  });
  if (verifier.kind !== 'Prepared') throw new Error(verifier.reason);
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
  const manifest = prepareEvaluationManifest({
    evaluationId,
    taskId,
    taskRevisionSaid: said('a'),
    originRunId: sourceRunId,
    ownerAid: said('b'),
    personalAgentAid: said('c'),
    taskMandateSaid: said('d'),
    retainedCheckpointSaid: said('e'),
    retainedSealSaid: said('f'),
    policySaid: said('g'),
    revisions,
    executionProfileSaid: said('l'),
    sourceInventorySaid: said('m'),
    hypothesisSaid: said('H'),
    verifierSaid: verifier.bundle.d,
    protectedCaseArtifactSaid: verifier.bundle.protectedCase.stimulus.d,
    finalCaseArtifactSaid: verifier.bundle.terminalCase.stimulus.d,
    publicConditionIds: ['cesr-current'],
    heldOutCaseCount: 1,
    allocation: { diagnosis: allowance, perEntry: allowance, finalization: allowance },
  });
  if (manifest.kind !== 'Prepared') throw new Error(manifest.reason);
  const observations = comparisonSlots().map((slot, index) => {
    const passed = slot.arm !== 'H1TaskSearch' || slot.attempt === 2;
    const revision = slot.arm === 'H1TaskSearch' ? revisions.H1 : revisions[slot.arm];
    const record = prepareTrialObservationEvidence({
      version: 1,
      kind: 'TrialObservationEvidence',
      evaluationId,
      manifestSaid: manifest.manifest.d,
      harnessRevisionSaid: revision,
      observation: {
        slot,
        disposition: {
          kind: 'Measured',
          artifactSaid: `E${String(index + 1).padStart(43, '0')}`,
          publicConditionIds: passed ? ['cesr-current'] : [],
          heldOutConditionIds: [protectedId],
          usage,
        },
      },
      capturedSourceSaid: said('s'),
      trialEvidenceHeadSaid: said('v'),
      trialCleanupReceiptSaid: said('w'),
      publicObservations: [
        {
          conditionId: 'cesr-current',
          rawObservationSaid: `E${String(index + 100).padStart(43, '0')}`,
          verdict: passed ? 'Pass' : 'Fail',
        },
      ],
      protectedObservationSaid: `E${String(index + 200).padStart(43, '0')}`,
      protectedVerdict: 'Pass',
      protectedCleanupReceiptSaid: said('z'),
      providerUsageEventSaids: [`E${String(index + 300).padStart(43, '0')}`],
    });
    if (record.kind !== 'Prepared') throw new Error(record.reason);
    return record;
  });
  return { manifest: manifest.manifest, verifier: verifier.bundle, observations };
}

describe('parent comparison measurement preparation', () => {
  it('records one protected trial only after a head-bound parent usage measurement', async () => {
    const input = fixture();
    const first = input.observations[0];
    if (first === undefined) throw new Error('missing observation fixture');
    const measured = first.evidence;
    const binding = {
      kind: 'Evaluation' as const,
      taskId,
      taskRevisionSaid: input.manifest.taskRevisionSaid,
      originRunId: sourceRunId,
      personalAgentAid: input.manifest.personalAgentAid,
      taskMandateSaid: input.manifest.taskMandateSaid,
      harnessRevisionSaid: revisions.H1,
      evaluationId,
      evaluationLeaseId: '71d7f67f-d2f9-4fae-87cc-ac827de6f0d1',
      evidenceStreamId: '61d7f67f-d2f9-4fae-87cc-ac827de6f0d1',
      phase: {
        kind: 'Trial' as const,
        manifestSaid: input.manifest.d,
        ...measured.observation.slot,
      },
    };
    const retained = {
      kind: 'Retained' as const,
      capturedSourceSaid: measured.capturedSourceSaid,
      trialEvidenceHeadSaid: measured.trialEvidenceHeadSaid,
      trialCleanupReceiptSaid: measured.trialCleanupReceiptSaid,
      providerUsageEventSaids: measured.providerUsageEventSaids,
      frozenArtifact: {
        kind: 'Frozen' as const,
        executableSaid: measured.observation.disposition.artifactSaid,
        sourceSaid: measured.capturedSourceSaid,
        buildReceiptSaid: said('B'),
        cleanupReceiptSaid: said('C'),
      },
      publicCases: measured.publicObservations.map((item) => ({
        id: item.conditionId,
        verdict: item.verdict,
        rawObservationSaid: item.rawObservationSaid,
        cleanupReceiptSaid: said('D'),
      })),
      protectedVerdict: measured.protectedVerdict,
      protectedObservationSaid: measured.protectedObservationSaid,
      protectedCleanupReceiptSaid: measured.protectedCleanupReceiptSaid,
      acknowledgedArtifactSaids: [
        input.verifier.protectedCase.stimulus.d,
        input.verifier.protectedCase.expected.d,
        measured.protectedObservationSaid,
      ] as const,
      custodyEvidenceHeadSaid: said('V'),
      custodyEvidenceSequence: 1,
    };
    const measure = vi.fn().mockResolvedValue({
      kind: 'Verified',
      trialEvidenceHeadSaid: measured.trialEvidenceHeadSaid,
      providerUsageEventSaids: measured.providerUsageEventSaids,
      usage,
    });
    const prepared = await prepareMeasuredTrialObservation(
      { binding, manifest: input.manifest, verifier: input.verifier, retained },
      { measure },
    );
    expect(prepared.kind).toBe('Prepared');
    if (prepared.kind !== 'Prepared') return;
    expect(prepared.evidence.observation).toEqual(measured.observation);
    measure.mockResolvedValue({
      kind: 'Verified',
      trialEvidenceHeadSaid: said('Z'),
      providerUsageEventSaids: measured.providerUsageEventSaids,
      usage,
    });
    expect(
      await prepareMeasuredTrialObservation(
        { binding, manifest: input.manifest, verifier: input.verifier, retained },
        { measure },
      ),
    ).toEqual({ kind: 'Incomplete', reason: 'Usage' });
  });

  it('derives fifteen typed measurements and selects public task-search attempt two', () => {
    const input = fixture();
    const prepared = prepareComparisonMeasurements(input);
    expect(prepared.kind).toBe('Prepared');
    if (prepared.kind !== 'Prepared') return;
    expect(prepared.measurements).toHaveLength(15);
    const selected = prepared.measurements.filter(
      (item) => item.evidence.measurement.slot.arm === 'H1TaskSearch',
    );
    expect(selected).toHaveLength(3);
    expect(selected.every((item) => item.evidence.measurement.slot.attempt === 2)).toBe(true);
    expect(selected.every((item) => item.evidence.sourceObservationSaids.length === 2)).toBe(true);
    expect(
      prepareComparisonMeasurements({ ...input, observations: input.observations.slice(1) }),
    ).toEqual({
      kind: 'Incomplete',
      reason: 'RequiredSet',
    });
    const first = input.observations[0];
    if (first === undefined) throw new Error('missing observation fixture');
    const substituted = prepareTrialObservationEvidence({
      ...first.evidence,
      manifestSaid: said('z'),
    });
    if (substituted.kind !== 'Prepared') throw new Error(substituted.reason);
    expect(
      prepareComparisonMeasurements({
        ...input,
        observations: [substituted, ...input.observations.slice(1)],
      }),
    ).toEqual({ kind: 'Incomplete', reason: 'Binding' });
    expect(
      prepareComparisonMeasurements({
        ...input,
        observations: [first, first, ...input.observations.slice(2)],
      }),
    ).toEqual({ kind: 'Incomplete', reason: 'RequiredSet' });
  });
});
