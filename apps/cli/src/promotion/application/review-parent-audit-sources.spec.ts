import { fixture as custodyFixture } from '../../../test/promotion-evidence-fixture.js';
import { reopenParentEvaluationAudit } from './reopen-parent-evaluation-audit.js';
import { comparisonSlots, type ComparisonSlot } from '@devrandom/domain';
import {
  decodeEvaluationClosureEvidenceIndex,
  prepareEvaluationManifest,
  prepareEvaluationVerifierBundle,
  prepareProtectedEvaluationArtifact,
  prepareTrialObservationEvidence,
  prepareEvidenceArtifact,
  prepareEvaluationEvidenceEvent,
  prepareEvaluationEvidenceBatch,
  type EvaluationEvidenceEvent,
  type EvidenceArtifact,
} from '@devrandom/protocol';
import { prepareComparisonMeasurements } from '@devrandom/runtime';
import { expect, it } from 'vitest';
import {
  prepareParentAuditOperation,
  type ParentAuditOperationInput,
} from './parent-audit-operation.js';
import { reviewParentAuditSources } from './review-parent-audit-sources.js';
import { prepareParentEvaluationAudit } from './prepare-parent-evaluation-audit.js';
import { reviewPromotionTamperAudit } from './review-promotion-tamper-audit.js';
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

function fixture(options: { lateSelection?: boolean; forgedPublic?: boolean } = {}) {
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
  const m = manifest.manifest;
  const v = verifier.bundle;
  const events: EvaluationEvidenceEvent[] = [];
  const artifacts = new Map<string, { artifact: EvidenceArtifact; bytes: Uint8Array }>();
  const operations: string[] = [];
  let current: ComparisonSlot = comparisonSlots()[0] ?? { arm: 'H1', repetition: 1, attempt: 1 };
  const append = (detail: EvaluationEvidenceEvent['detail']) => {
    const previous = events.at(-1);
    const result = prepareEvaluationEvidenceEvent({
      evaluationId,
      streamId: '33333333-3333-4333-8333-333333333333',
      originRunId: sourceRunId,
      taskId,
      taskRevisionSaid: m.taskRevisionSaid,
      personalAgentAid: m.personalAgentAid,
      taskMandateSaid: m.taskMandateSaid,
      harnessRevisionSaid:
        current.arm === 'H1TaskSearch' ? m.revisions.H1 : m.revisions[current.arm],
      phase: { kind: 'Trial', manifestSaid: m.d, ...current },
      sequence: events.length,
      previous:
        previous === undefined ? { kind: 'Genesis' } : { kind: 'Previous', eventSaid: previous.d },
      occurredAt: '2026-09-26T14:00:00.000Z',
      detail,
    });
    if (result.kind !== 'Prepared') throw new Error(result.reason);
    events.push(result.event);
    return result.event;
  };
  const capture = (artifact: EvidenceArtifact, bytes: Uint8Array) => {
    artifacts.set(artifact.d, { artifact, bytes });
    return append({ kind: 'ArtifactCaptured', artifactSaid: artifact.d, custody: 'Public' });
  };
  const json = (value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(value));
    const raw = prepareEvidenceArtifact(bytes, 'application/json');
    if (raw.kind !== 'Prepared') throw new Error('raw');
    capture(raw.artifact, bytes);
    return raw.artifact.d;
  };
  json({ kind: 'Start' });
  const head = () => {
    const latest = events.at(-1);
    if (latest === undefined) throw new Error('head');
    return { sequence: latest.sequence, headSaid: latest.d };
  };
  const operation = (
    scope: ParentAuditOperationInput['scope'],
    detail: ParentAuditOperationInput['operation'],
    opened = head(),
  ) => {
    const raw = prepareParentAuditOperation({
      evaluationId,
      manifestSaid: m.d,
      scope,
      opened,
      closed: head(),
      operation: detail,
    });
    if (raw.kind !== 'Prepared') throw new Error('operation');
    capture(raw.artifact, raw.bytes);
    operations.push(raw.artifact.d);
    return raw.artifact.d;
  };
  const stopped = comparisonSlots().map((slot, index) => {
    current = slot;
    const opened = head();
    const source = json({ kind: 'Source', slot });
    const cleanup = json({
      kind: 'Cleanup',
      bindingId: `${evaluationId}/${slot.arm}/${String(slot.repetition)}/${String(slot.attempt)}/session`,
      confirmed: true,
    });
    const stop = append({ kind: 'TrialStopped', reason: 'Completed' });
    operation(
      slot.arm,
      {
        kind: 'TrialExecution',
        slot,
        sourceSaid: source,
        trialStoppedEventSaid: stop.d,
        cleanupReceiptSaid: cleanup,
      },
      opened,
    );
    const executable = `E${String(index + 1).padStart(43, '0')}`;
    const build = json({
      sourceSaid: source,
      recipeSaid: v.reviewedRecipeSaid,
      toolchainSaid: v.toolchainSaid,
      exitCode: 0,
      stdout: '',
      stderr: '',
      effectiveLimitsDigest: `sha256:${'a'.repeat(64)}`,
    });
    const buildCleanup = json({ buildReceiptSaid: build, stopped: true });
    const condition = v.publicConditions[0];
    if (condition === undefined) throw new Error('condition');
    const stimulus = prepareEvidenceArtifact(
      Buffer.from(condition.stimulusBase64Url, 'base64url'),
      'text/plain; charset=utf-8',
    );
    if (stimulus.kind !== 'Prepared') throw new Error('stimulus');
    const native = json({
      executableSaid: executable,
      stimulusSaid: stimulus.artifact.d,
      caseScope: 'Public',
      observation: condition.expected,
      stdout: options.forgedPublic === true ? 'DV1|R|InvalidFrame' : `DV1|P|Current:${said('x')}\n`,
      effectiveLimitsDigest: `sha256:${'a'.repeat(64)}`,
    });
    const publicCleanup = json({ rawObservationSaid: native, stopped: true });
    return { slot, source, cleanup, stop, executable, build, buildCleanup, native, publicCleanup };
  });
  const select = () => {
    for (const repetition of [1, 2, 3] as const) {
      const pair = stopped.filter(
        (item) => item.slot.arm === 'H1TaskSearch' && item.slot.repetition === repetition,
      );
      const a = pair[0];
      const b = pair[1];
      if (a === undefined || b === undefined) throw new Error('pair');
      current = b.slot;
      operation('H1TaskSearch', {
        kind: 'PublicSearchSelection',
        repetition,
        firstArtifactSaid: a.executable,
        secondArtifactSaid: b.executable,
        selectedArtifactSaid: a.executable,
      });
    }
  };
  if (options.lateSelection !== true) select();
  const observations = stopped.map((trial, index) => {
    current = trial.slot;
    const opened = head();
    const protectedSaid = `E${String(index + 100).padStart(43, '0')}`;
    append({
      kind: 'ArtifactCaptured',
      artifactSaid: protectedSaid,
      custody: 'ProtectedCiphertext',
    });
    const protectedCleanup = json({ rawObservationSaid: protectedSaid, stopped: true });
    operation(
      current.arm,
      {
        kind: 'ProtectedGrading',
        slot: current,
        taskArtifactSaid: trial.executable,
        buildReceiptSaid: trial.build,
        buildCleanupReceiptSaid: trial.buildCleanup,
        publicCleanupReceiptSaids: [trial.publicCleanup],
        protectedObservationSaid: protectedSaid,
        cleanupReceiptSaid: protectedCleanup,
      },
      opened,
    );
    const raw = prepareTrialObservationEvidence({
      version: 1,
      kind: 'TrialObservationEvidence',
      evaluationId,
      manifestSaid: m.d,
      harnessRevisionSaid:
        current.arm === 'H1TaskSearch' ? m.revisions.H1 : m.revisions[current.arm],
      observation: {
        slot: current,
        disposition: {
          kind: 'Measured',
          artifactSaid: trial.executable,
          publicConditionIds: ['cesr-current'],
          heldOutConditionIds: [v.protectedCase.objectSaid],
          usage,
        },
      },
      capturedSourceSaid: trial.source,
      trialEvidenceHeadSaid: trial.stop.d,
      trialCleanupReceiptSaid: trial.cleanup,
      publicObservations: [
        { conditionId: 'cesr-current', rawObservationSaid: trial.native, verdict: 'Pass' },
      ],
      protectedObservationSaid: protectedSaid,
      protectedVerdict: 'Pass',
      protectedCleanupReceiptSaid: protectedCleanup,
      providerUsageEventSaids: [said('V')],
    });
    if (raw.kind !== 'Prepared') throw new Error(raw.reason);
    capture(raw.artifact, raw.bytes);
    return raw;
  });
  if (options.lateSelection === true) select();
  const derived = prepareComparisonMeasurements({ manifest: m, verifier: v, observations });
  if (derived.kind !== 'Prepared') throw new Error(derived.reason);
  const recordedFrom = head();
  for (const raw of derived.measurements) capture(raw.artifact, raw.bytes);
  operation('Shared', {
    kind: 'MeasurementDerivation',
    observationArtifactSaids: observations.map((raw) => raw.artifact.d),
    measurementArtifactSaids: derived.measurements.map((raw) => raw.artifact.d),
  });
  const batch = prepareEvaluationEvidenceBatch(events.slice(recordedFrom.sequence + 1));
  if (batch.kind !== 'Prepared') throw new Error('batch');
  const recordedTo = head();
  operation(
    'Shared',
    {
      kind: 'EvidenceRecording',
      batchSaid: batch.batch.d,
      acceptedThroughSequence: recordedTo.sequence,
      chainHeadSaid: recordedTo.headSaid,
    },
    recordedFrom,
  );
  const propagated = head();
  operation('Shared', {
    kind: 'EvidencePropagation',
    throughSequence: propagated.sequence,
    headSaid: propagated.headSaid,
    artifactSaids: [
      ...observations.map((raw) => raw.artifact.d),
      ...derived.measurements.map((raw) => raw.artifact.d),
    ],
  });
  const input = {
    manifest: m,
    verifier: v,
    acceptedEvents: events,
    observationArtifactSaids: observations.map((raw) => raw.artifact.d),
    measurementArtifactSaids: derived.measurements.map((raw) => raw.artifact.d),
    operationArtifactSaids: operations,
  };
  const reading = {
    openPublic: ({ artifactSaid }: { artifactSaid: string }) => {
      const raw = artifacts.get(artifactSaid);
      return Promise.resolve(
        raw === undefined ? { kind: 'Missing' as const } : { kind: 'Opened' as const, ...raw },
      );
    },
  };
  const ports = {
    reading,
    regrading: {
      regrade: () => Promise.resolve({ kind: 'Verified' as const, verdict: 'Pass' as const }),
    },
    usage: { remeasure: () => Promise.resolve({ kind: 'Verified' as const, usage }) },
  };
  return { input, ports, artifacts, observations, operations, events, stopped, capture };
}

it('derives all seven obligations and five lifecycle roles from a complete captured native schedule', async () => {
  const f = fixture();
  expect(await reviewParentAuditSources(f.input, f.ports)).toMatchObject({ kind: 'Verified' });
  const prepared = await prepareParentEvaluationAudit(f.input, f.ports);
  expect(prepared.kind).toBe('Prepared');
  if (prepared.kind !== 'Prepared') throw new Error('audit unavailable');
  for (const raw of prepared.artifacts) f.artifacts.set(raw.artifact.d, raw);
  const staged = custodyFixture(f.input.manifest.d).command.evidenceIndex;
  const decoded = decodeEvaluationClosureEvidenceIndex(
    staged.artifact,
    Buffer.from(staged.bytesBase64Url, 'base64url'),
  );
  if (decoded.kind !== 'Accepted') throw new Error('index');
  const index = {
    ...decoded.index,
    evaluationId: f.input.manifest.evaluationId,
    manifestSaid: f.input.manifest.d,
    observations: f.observations.map((raw) => ({
      slot: raw.evidence.observation.slot,
      artifactSaid: raw.artifact.d,
    })),
    measurements: f.input.measurementArtifactSaids.map((artifactSaid, index) => ({
      slot: comparisonSlots().filter((slot) => slot.attempt === 1)[index] ?? {
        arm: 'H1' as const,
        repetition: 1 as const,
        attempt: 1 as const,
      },
      artifactSaid,
    })),
    audits: prepared.audits,
  };
  for (const raw of prepared.artifacts) f.capture(raw.artifact, raw.bytes);
  expect(
    await reopenParentEvaluationAudit(
      { manifest: f.input.manifest, verifier: f.input.verifier, index, acceptedEvents: f.events },
      f.ports,
    ),
  ).toMatchObject({ kind: 'Prepared' });
  expect(prepared.audits).toHaveLength(6);
  expect(
    prepared.audits.every((audit) => audit.verdict === 'Pass' && audit.proofs.length === 7),
  ).toBe(true);
  expect(
    await reviewPromotionTamperAudit(
      {
        evaluationId: f.input.manifest.evaluationId,
        audits: prepared.audits,
        capturedPublicArtifactSaids: new Set(f.artifacts.keys()),
      },
      { reading: f.ports.reading, inspector: prepared.inspector },
    ),
  ).toMatchObject({ kind: 'Recomputed' });
});

it('rejects omitted propagation, lost cleanup, and changed public native bytes', async () => {
  const f = fixture();
  expect(
    await reviewParentAuditSources(
      { ...f.input, operationArtifactSaids: f.operations.slice(0, -1) },
      f.ports,
    ),
  ).toEqual({ kind: 'Incomplete' });
  const first = f.stopped[0];
  if (first === undefined) throw new Error('trial');
  const old = f.artifacts.get(first.cleanup);
  f.artifacts.delete(first.cleanup);
  expect(await reviewParentAuditSources(f.input, f.ports)).toEqual({ kind: 'Incomplete' });
  if (old !== undefined) f.artifacts.set(first.cleanup, old);
  const native = f.artifacts.get(first.native);
  if (native === undefined) throw new Error('native');
  f.artifacts.set(first.native, { ...native, bytes: Buffer.from('{}') });
  expect(await reviewParentAuditSources(f.input, f.ports)).toEqual({ kind: 'Incomplete' });
});

it('rejects valid-SAID native grade lies and public search chosen after hidden grading', async () => {
  const forged = fixture({ forgedPublic: true });
  expect(await prepareParentEvaluationAudit(forged.input, forged.ports)).toEqual({
    kind: 'Incomplete',
  });
  const late = fixture({ lateSelection: true });
  expect(await prepareParentEvaluationAudit(late.input, late.ports)).toEqual({
    kind: 'Incomplete',
  });
});
it('cannot promote caller-declared usage or a protected grade contradicted by trusted replay', async () => {
  const f = fixture();
  expect(
    await prepareParentEvaluationAudit(f.input, {
      ...f.ports,
      usage: {
        remeasure: () =>
          Promise.resolve({ kind: 'Verified', usage: { ...usage, unsafeProposals: 1 } }),
      },
    }),
  ).toEqual({ kind: 'Incomplete' });
  expect(
    await prepareParentEvaluationAudit(f.input, {
      ...f.ports,
      regrading: { regrade: () => Promise.resolve({ kind: 'Verified', verdict: 'Fail' }) },
    }),
  ).toEqual({ kind: 'Incomplete' });
});
