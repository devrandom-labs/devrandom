import { isDeepStrictEqual } from 'node:util';

import { comparisonSlots, selectTaskSearchArtifact, type TrialUsage } from '@devrandom/domain';
import {
  bindEvaluationVerifierBundle,
  decodeEvaluationEvidenceEvent,
  decodeEvaluationManifest,
  decodeEvidenceArtifact,
  prepareEvidenceArtifact,
  prepareEvaluationEvidenceBatch,
  type EvaluationManifest,
  type EvaluationVerifierBundle,
  type EvaluationEvidenceEvent,
  type EvidenceArtifact,
  type TrialObservationEvidence,
} from '@devrandom/protocol';
import { observedPublicCase, prepareComparisonMeasurements } from '@devrandom/runtime';

import { interpretNativeCesrReceiptRecord } from './native-cesr-receipt-record.js';
import { decodeParentAuditOperation, type ParentAuditOperation } from './parent-audit-operation.js';
import type { PromotionAcceptedEvidenceReading } from './open-promotion-custody.js';
import type { PromotionProtectedTrialRegrading } from './review-promotion-protected-schedule.js';

type Raw = { readonly artifact: EvidenceArtifact; readonly bytes: Uint8Array };
export interface ParentAuditSources {
  readonly manifest: EvaluationManifest;
  readonly verifier: EvaluationVerifierBundle;
  readonly acceptedEvents: readonly EvaluationEvidenceEvent[];
  readonly observationArtifactSaids: readonly string[];
  readonly measurementArtifactSaids: readonly string[];
  readonly operationArtifactSaids: readonly string[];
}
export interface ParentAuditSourceReading {
  readonly reading: Pick<PromotionAcceptedEvidenceReading, 'openPublic'>;
  readonly regrading: PromotionProtectedTrialRegrading;
  readonly usage: {
    remeasure(
      trial: TrialObservationEvidence,
    ): Promise<
      { readonly kind: 'Verified'; readonly usage: TrialUsage } | { readonly kind: 'Incomplete' }
    >;
  };
}
export type ParentAuditSourceReview =
  | {
      readonly kind: 'Verified';
      readonly throughSequence: number;
      readonly throughHeadSaid: string;
      readonly observations: readonly TrialObservationEvidence[];
      readonly operations: readonly ParentAuditOperation[];
    }
  | { readonly kind: 'Incomplete' };

function sameSlot(event: EvaluationEvidenceEvent, trial: TrialObservationEvidence): boolean {
  const phase = event.phase;
  const slot = trial.observation.slot;
  return (
    phase.kind === 'Trial' &&
    phase.manifestSaid === trial.manifestSaid &&
    phase.arm === slot.arm &&
    phase.repetition === slot.repetition &&
    phase.attempt === slot.attempt &&
    event.harnessRevisionSaid === trial.harnessRevisionSaid
  );
}

/** Replays native sources; an operation receipt alone never establishes a clean audit. */
export async function reviewParentAuditSources(
  input: ParentAuditSources,
  ports: ParentAuditSourceReading,
): Promise<ParentAuditSourceReview> {
  try {
    return await review(input, ports);
  } catch {
    return { kind: 'Incomplete' };
  }
}

async function review(
  input: ParentAuditSources,
  ports: ParentAuditSourceReading,
): Promise<ParentAuditSourceReview> {
  const { manifest, verifier, acceptedEvents: events } = input;
  if (
    decodeEvaluationManifest(manifest).kind !== 'Accepted' ||
    bindEvaluationVerifierBundle(verifier, manifest).kind !== 'Bound' ||
    events.length === 0 ||
    !isDeepStrictEqual(manifest.slots, comparisonSlots())
  )
    return { kind: 'Incomplete' };
  const first = events[0];
  const last = events.at(-1);
  if (first === undefined || last === undefined) return { kind: 'Incomplete' };
  const captures = new Map<string, EvaluationEvidenceEvent[]>();
  for (const [position, event] of events.entries()) {
    if (
      decodeEvaluationEvidenceEvent(event).kind !== 'Accepted' ||
      event.sequence !== position ||
      (position === 0
        ? event.previous.kind !== 'Genesis'
        : event.previous.kind !== 'Previous' ||
          event.previous.eventSaid !== events[position - 1]?.d) ||
      event.streamId !== first.streamId ||
      event.evaluationId !== manifest.evaluationId ||
      event.originRunId !== manifest.originRunId ||
      event.taskId !== manifest.taskId ||
      event.taskRevisionSaid !== manifest.taskRevisionSaid ||
      event.personalAgentAid !== manifest.personalAgentAid ||
      event.taskMandateSaid !== manifest.taskMandateSaid ||
      (event.phase.kind === 'Trial' && event.phase.manifestSaid !== manifest.d)
    )
      return { kind: 'Incomplete' };
    if (event.detail.kind === 'ArtifactCaptured') {
      const prior = captures.get(event.detail.artifactSaid) ?? [];
      captures.set(event.detail.artifactSaid, [...prior, event]);
    }
    if (event.detail.kind === 'ToolAuthorization' && event.detail.disposition !== 'Allowed')
      return { kind: 'Incomplete' };
    if (event.detail.kind === 'ToolProposed') {
      const authorizations = events.filter(
        (other) =>
          other.detail.kind === 'ToolAuthorization' && other.detail.proposalEventSaid === event.d,
      );
      if (authorizations.length !== 1) return { kind: 'Incomplete' };
    }
    if (event.detail.kind === 'EffectObserved') {
      const authorization = events.find(
        (item) =>
          item.d ===
          (event.detail.kind === 'EffectObserved' ? event.detail.authorizationEventSaid : ''),
      );
      if (
        authorization?.detail.kind !== 'ToolAuthorization' ||
        authorization.detail.disposition !== 'Allowed' ||
        authorization.sequence >= event.sequence ||
        !isDeepStrictEqual(authorization.phase, event.phase)
      )
        return { kind: 'Incomplete' };
      const proposal = events.find(
        (item) =>
          item.d ===
          (authorization.detail.kind === 'ToolAuthorization'
            ? authorization.detail.proposalEventSaid
            : ''),
      );
      if (
        proposal?.detail.kind !== 'ToolProposed' ||
        proposal.sequence >= authorization.sequence ||
        !isDeepStrictEqual(proposal.phase, event.phase)
      )
        return { kind: 'Incomplete' };
    }
  }
  const captured = (
    artifactSaid: string,
    custody: 'Public' | 'ProtectedCiphertext',
    trial?: TrialObservationEvidence,
  ) =>
    (captures.get(artifactSaid) ?? []).find(
      (event) =>
        event.detail.kind === 'ArtifactCaptured' &&
        event.detail.custody === custody &&
        (trial === undefined || sameSlot(event, trial)),
    );
  const cache = new Map<string, Raw>();
  const open = async (artifactSaid: string): Promise<Raw | undefined> => {
    const prior = cache.get(artifactSaid);
    if (prior !== undefined) return prior;
    if (captured(artifactSaid, 'Public') === undefined) return undefined;
    const raw = await ports.reading.openPublic({
      evaluationId: manifest.evaluationId,
      artifactSaid,
    });
    if (
      raw.kind !== 'Opened' ||
      raw.artifact.d !== artifactSaid ||
      decodeEvidenceArtifact(raw.artifact, raw.bytes).kind !== 'Accepted'
    )
      return undefined;
    cache.set(artifactSaid, raw);
    return raw;
  };
  const json = async (artifactSaid: string): Promise<unknown> => {
    const raw = await open(artifactSaid);
    if (raw?.artifact.mediaType !== 'application/json') return undefined;
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw.bytes)) as unknown;
  };
  const rawObservations: Raw[] = [];
  for (const said of input.observationArtifactSaids) {
    const raw = await open(said);
    if (raw === undefined) return { kind: 'Incomplete' };
    rawObservations.push(raw);
  }
  const measurements = prepareComparisonMeasurements({
    manifest,
    verifier,
    observations: rawObservations,
  });
  if (
    measurements.kind !== 'Prepared' ||
    !isDeepStrictEqual(
      measurements.measurements.map((item) => item.artifact.d),
      input.measurementArtifactSaids,
    )
  )
    return { kind: 'Incomplete' };
  for (const expected of measurements.measurements) {
    const raw = await open(expected.artifact.d);
    if (raw === undefined || !Buffer.from(raw.bytes).equals(Buffer.from(expected.bytes)))
      return { kind: 'Incomplete' };
  }
  const operations: { receipt: ParentAuditOperation; capture: EvaluationEvidenceEvent }[] = [];
  if (new Set(input.operationArtifactSaids).size !== input.operationArtifactSaids.length)
    return { kind: 'Incomplete' };
  for (const said of input.operationArtifactSaids) {
    const raw = await open(said);
    if (raw === undefined) return { kind: 'Incomplete' };
    const decoded = decodeParentAuditOperation(raw.artifact, raw.bytes);
    const capture = captured(said, 'Public');
    if (decoded.kind !== 'Accepted' || capture === undefined) return { kind: 'Incomplete' };
    const receipt = decoded.receipt;
    if (
      receipt.evaluationId !== manifest.evaluationId ||
      receipt.manifestSaid !== manifest.d ||
      events[receipt.opened.sequence]?.d !== receipt.opened.headSaid ||
      events[receipt.closed.sequence]?.d !== receipt.closed.headSaid ||
      capture.sequence <= receipt.closed.sequence
    )
      return { kind: 'Incomplete' };
    operations.push({ receipt, capture });
  }
  for (const [position, trial] of measurements.observations.entries()) {
    const observationSaid = input.observationArtifactSaids[position];
    if (
      observationSaid === undefined ||
      captured(observationSaid, 'Public', trial) === undefined ||
      captured(trial.capturedSourceSaid, 'Public', trial) === undefined ||
      captured(trial.protectedObservationSaid, 'ProtectedCiphertext', trial) === undefined
    )
      return { kind: 'Incomplete' };
    const stops = events.filter(
      (event) => sameSlot(event, trial) && event.detail.kind === 'TrialStopped',
    );
    if (
      stops.length !== 1 ||
      stops[0]?.d !== trial.trialEvidenceHeadSaid ||
      stops[0].detail.kind !== 'TrialStopped' ||
      stops[0].detail.reason !== 'Completed'
    )
      return { kind: 'Incomplete' };
    const execution = operations.filter(
      ({ receipt }) =>
        receipt.operation.kind === 'TrialExecution' &&
        isDeepStrictEqual(receipt.operation.slot, trial.observation.slot),
    );
    const grading = operations.filter(
      ({ receipt }) =>
        receipt.operation.kind === 'ProtectedGrading' &&
        isDeepStrictEqual(receipt.operation.slot, trial.observation.slot),
    );
    const executed = execution[0];
    const graded = grading[0];
    if (
      execution.length !== 1 ||
      grading.length !== 1 ||
      executed?.receipt.operation.kind !== 'TrialExecution' ||
      graded?.receipt.operation.kind !== 'ProtectedGrading'
    )
      return { kind: 'Incomplete' };
    const e = executed.receipt.operation;
    const g = graded.receipt.operation;
    if (
      e.sourceSaid !== trial.capturedSourceSaid ||
      e.trialStoppedEventSaid !== trial.trialEvidenceHeadSaid ||
      e.cleanupReceiptSaid !== trial.trialCleanupReceiptSaid ||
      g.taskArtifactSaid !== trial.observation.disposition.artifactSaid ||
      g.protectedObservationSaid !== trial.protectedObservationSaid ||
      g.cleanupReceiptSaid !== trial.protectedCleanupReceiptSaid ||
      executed.receipt.closed.sequence < stops[0].sequence ||
      graded.receipt.opened.sequence < executed.receipt.closed.sequence
    )
      return { kind: 'Incomplete' };
    if (
      captured(g.buildReceiptSaid, 'Public', trial) === undefined ||
      captured(g.buildCleanupReceiptSaid, 'Public', trial) === undefined ||
      captured(trial.trialCleanupReceiptSaid, 'Public', trial) === undefined ||
      captured(trial.protectedCleanupReceiptSaid, 'Public', trial) === undefined ||
      g.publicCleanupReceiptSaids.length !== verifier.publicConditions.length
    )
      return { kind: 'Incomplete' };
    const build = await json(g.buildReceiptSaid);
    if (
      typeof build !== 'object' ||
      build === null ||
      !('sourceSaid' in build) ||
      build.sourceSaid !== trial.capturedSourceSaid ||
      !('recipeSaid' in build) ||
      build.recipeSaid !== verifier.reviewedRecipeSaid ||
      !('toolchainSaid' in build) ||
      build.toolchainSaid !== verifier.toolchainSaid ||
      !('exitCode' in build) ||
      build.exitCode !== 0 ||
      !('effectiveLimitsDigest' in build) ||
      typeof build.effectiveLimitsDigest !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/u.test(build.effectiveLimitsDigest) ||
      !isDeepStrictEqual(await json(g.buildCleanupReceiptSaid), {
        buildReceiptSaid: g.buildReceiptSaid,
        stopped: true,
      })
    )
      return { kind: 'Incomplete' };
    const sourceCapture = captured(trial.capturedSourceSaid, 'Public', trial);
    const hiddenCapture = captured(trial.protectedObservationSaid, 'ProtectedCiphertext', trial);
    if (
      sourceCapture === undefined ||
      hiddenCapture === undefined ||
      sourceCapture.sequence <= executed.receipt.opened.sequence ||
      sourceCapture.sequence > executed.receipt.closed.sequence ||
      hiddenCapture.sequence <= graded.receipt.opened.sequence ||
      hiddenCapture.sequence > graded.receipt.closed.sequence
    )
      return { kind: 'Incomplete' };
    const cleanup = await json(trial.trialCleanupReceiptSaid);
    if (
      typeof cleanup !== 'object' ||
      cleanup === null ||
      !('kind' in cleanup) ||
      cleanup.kind !== 'Cleanup' ||
      !('confirmed' in cleanup) ||
      cleanup.confirmed !== true ||
      !('bindingId' in cleanup) ||
      typeof cleanup.bindingId !== 'string' ||
      !cleanup.bindingId.startsWith(
        `${manifest.evaluationId}/${trial.observation.slot.arm}/${String(trial.observation.slot.repetition)}/${String(trial.observation.slot.attempt)}/`,
      )
    )
      return { kind: 'Incomplete' };
    if (
      !isDeepStrictEqual(await json(trial.protectedCleanupReceiptSaid), {
        rawObservationSaid: trial.protectedObservationSaid,
        stopped: true,
      })
    )
      return { kind: 'Incomplete' };
    const accepted: string[] = [];
    for (const [index, condition] of verifier.publicConditions.entries()) {
      const declared = trial.publicObservations[index];
      if (
        declared === undefined ||
        declared.conditionId !== condition.id ||
        captured(declared.rawObservationSaid, 'Public', trial) === undefined
      )
        return { kind: 'Incomplete' };
      const publicCleanup = g.publicCleanupReceiptSaids[index];
      if (
        publicCleanup === undefined ||
        captured(publicCleanup, 'Public', trial) === undefined ||
        !isDeepStrictEqual(await json(publicCleanup), {
          rawObservationSaid: declared.rawObservationSaid,
          stopped: true,
        })
      )
        return { kind: 'Incomplete' };
      const stimulus = prepareEvidenceArtifact(
        Buffer.from(condition.stimulusBase64Url, 'base64url'),
        'text/plain; charset=utf-8',
      );
      if (stimulus.kind !== 'Prepared') return { kind: 'Incomplete' };
      const native = interpretNativeCesrReceiptRecord(await json(declared.rawObservationSaid), {
        caseScope: 'Public',
        executableSaid: trial.observation.disposition.artifactSaid,
        stimulusSaid: stimulus.artifact.d,
      });
      if (native.kind !== 'Interpreted') return { kind: 'Incomplete' };
      const verdict = observedPublicCase(condition.expected, native.observation);
      if (verdict === undefined || declared.verdict !== (verdict ? 'Pass' : 'Fail'))
        return { kind: 'Incomplete' };
      if (verdict) accepted.push(condition.id);
    }
    if (!isDeepStrictEqual(accepted, trial.observation.disposition.publicConditionIds))
      return { kind: 'Incomplete' };
    const protectedGrade = await ports.regrading.regrade({ manifest, trial });
    const usage = await ports.usage.remeasure(trial);
    if (
      protectedGrade.kind !== 'Verified' ||
      protectedGrade.verdict !== trial.protectedVerdict ||
      usage.kind !== 'Verified' ||
      !isDeepStrictEqual(usage.usage, trial.observation.disposition.usage) ||
      usage.usage.unsafeProposals !== 0 ||
      usage.usage.unsafeEffects !== 0
    )
      return { kind: 'Incomplete' };
  }
  for (const repetition of [1, 2, 3] as const) {
    const pair = measurements.observations.filter(
      (trial) =>
        trial.observation.slot.arm === 'H1TaskSearch' &&
        trial.observation.slot.repetition === repetition,
    );
    const a = pair[0];
    const b = pair[1];
    if (a === undefined || b === undefined || pair.length !== 2) return { kind: 'Incomplete' };
    const selection = selectTaskSearchArtifact(manifest.publicConditionIds, [
      {
        artifactSaid: a.observation.disposition.artifactSaid,
        acceptedConditionIds: a.observation.disposition.publicConditionIds,
      },
      {
        artifactSaid: b.observation.disposition.artifactSaid,
        acceptedConditionIds: b.observation.disposition.publicConditionIds,
      },
    ]);
    const selections = operations.filter(
      ({ receipt }) =>
        receipt.operation.kind === 'PublicSearchSelection' &&
        receipt.operation.repetition === repetition,
    );
    const selected = selections[0];
    if (
      selection.kind !== 'Selected' ||
      selections.length !== 1 ||
      selected?.receipt.operation.kind !== 'PublicSearchSelection'
    )
      return { kind: 'Incomplete' };
    const detail = selected.receipt.operation;
    if (
      pair.some((trial) =>
        trial.publicObservations.some(
          (raw) =>
            (captured(raw.rawObservationSaid, 'Public', trial)?.sequence ??
              Number.MAX_SAFE_INTEGER) > selected.receipt.closed.sequence,
        ),
      )
    )
      return { kind: 'Incomplete' };

    if (
      detail.firstArtifactSaid !== a.observation.disposition.artifactSaid ||
      detail.secondArtifactSaid !== b.observation.disposition.artifactSaid ||
      detail.selectedArtifactSaid !== selection.artifactSaid ||
      pair.some(
        (trial) =>
          (captured(trial.protectedObservationSaid, 'ProtectedCiphertext', trial)?.sequence ??
            -1) <= selected.capture.sequence,
      )
    )
      return { kind: 'Incomplete' };
  }
  const derivations = operations.filter(
    ({ receipt }) => receipt.operation.kind === 'MeasurementDerivation',
  );
  const derived = derivations[0];
  if (
    derivations.length !== 1 ||
    derived?.receipt.operation.kind !== 'MeasurementDerivation' ||
    !isDeepStrictEqual(
      derived.receipt.operation.observationArtifactSaids,
      input.observationArtifactSaids,
    ) ||
    !isDeepStrictEqual(
      derived.receipt.operation.measurementArtifactSaids,
      input.measurementArtifactSaids,
    )
  )
    return { kind: 'Incomplete' };
  const recording = operations.filter(
    ({ receipt }) => receipt.operation.kind === 'EvidenceRecording',
  );
  const propagation = operations.filter(
    ({ receipt }) => receipt.operation.kind === 'EvidencePropagation',
  );
  const required = [...input.observationArtifactSaids, ...input.measurementArtifactSaids];
  if (
    !recording.some(({ receipt }) => {
      if (receipt.operation.kind !== 'EvidenceRecording') return false;
      const batch = prepareEvaluationEvidenceBatch(
        events.slice(receipt.opened.sequence + 1, receipt.closed.sequence + 1),
      );
      return (
        batch.kind === 'Prepared' &&
        batch.batch.d === receipt.operation.batchSaid &&
        receipt.closed.sequence >= derived.capture.sequence
      );
    }) ||
    !propagation.some(
      ({ receipt }) =>
        receipt.operation.kind === 'EvidencePropagation' &&
        receipt.closed.sequence >= derived.capture.sequence &&
        required.every(
          (said) =>
            receipt.operation.kind === 'EvidencePropagation' &&
            receipt.operation.artifactSaids.includes(said),
        ),
    )
  )
    return { kind: 'Incomplete' };
  return {
    kind: 'Verified',
    throughSequence: last.sequence,
    throughHeadSaid: last.d,
    observations: measurements.observations,
    operations: operations.map(({ receipt }) => receipt),
  };
}
