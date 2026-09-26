import {
  IdentityFailure,
  PERSONAL_AGENT_ALIAS,
  type IssuerAid,
  type LocalEvidenceSealExchange,
  type PersonalAgentAid,
} from '@devrandom/identity';
import type {
  EvidenceEvent,
  EvidenceSealPayload,
  EvidenceStreamProjection,
} from '@devrandom/protocol';
import type { EvidenceRecorder, EvidenceRecording, RunSettlementFailure } from '@devrandom/runtime';

import {
  deliverNextEvidencePage,
  retryableEvidenceFailure,
  type EvidencePageDelivery,
  type HostedEvidence,
} from './evidence-delivery.js';
import type {
  HostedEvidenceSealReconciliation,
  HostedEvidenceSeals,
} from './evidence-seal-delivery.js';

type SealedEvidenceStream = Omit<EvidenceStreamProjection, 'seal'> & {
  readonly seal: Extract<EvidenceStreamProjection['seal'], { readonly kind: 'Sealed' }>;
};

export interface SealedEvidenceSettlementDependencies {
  readonly hostedEvidence: HostedEvidence;
  readonly hostedSeals: HostedEvidenceSeals;
  readonly exchange: LocalEvidenceSealExchange;
  readonly sourceAid: PersonalAgentAid;
  readonly recipientAid: IssuerAid;
  wait(milliseconds: number): Promise<void>;
  readonly maximumObservations: number;
}

export type SealedEvidenceSettlementOutcome =
  | { readonly kind: 'Sealed'; readonly stream: SealedEvidenceStream }
  | {
      readonly kind: 'EvidenceDeliveryRejected';
      readonly outcome: Exclude<EvidencePageDelivery, { readonly kind: 'Empty' | 'Delivered' }>;
    }
  | { readonly kind: 'CheckpointAcceptanceRejected' }
  | { readonly kind: 'SecretDetected' }
  | { readonly kind: 'EvidenceIntegrityFailure' }
  | { readonly kind: 'EvidenceUnavailable' }
  | { readonly kind: 'SealExchangeUnavailable' }
  | { readonly kind: 'SealObservationUnavailable' }
  | { readonly kind: 'SealPendingLimitReached' }
  | {
      readonly kind: 'SealReconciliationRejected';
      readonly outcome: Exclude<
        HostedEvidenceSealReconciliation,
        { readonly kind: 'Pending' | 'Sealed' }
      >;
    }
  | { readonly kind: 'SealProjectionRejected' }
  | { readonly kind: 'SealAcknowledgementRejected' };

export interface RunEvidenceSealing {
  settle(
    evidence: EvidenceRecorder,
    checkpointSaid: string,
  ): Promise<
    | { readonly kind: 'Sealed' }
    | Exclude<SealedEvidenceSettlementOutcome, { readonly kind: 'Sealed' }>
  >;
}

/** Preserve the closed hosted rejection through every Run settlement path. */
export function evidenceSealingFailure(
  outcome: Exclude<SealedEvidenceSettlementOutcome, { readonly kind: 'Sealed' }>,
): RunSettlementFailure {
  if (outcome.kind !== 'EvidenceDeliveryRejected') {
    return { kind: 'EvidenceSealingRejected', reason: outcome.kind };
  }
  const delivery = outcome.outcome;
  if (delivery.kind !== 'ArtifactDeliveryRejected' && delivery.kind !== 'BatchDeliveryRejected') {
    return { kind: 'EvidenceDeliveryRejected', delivery: { kind: delivery.kind } };
  }
  const failure = delivery.outcome;
  if (failure.kind !== 'RequestRejected') {
    return {
      kind: 'EvidenceDeliveryRejected',
      delivery: { kind: delivery.kind, failure: { kind: failure.kind } },
    };
  }
  const problem = failure.problem;
  if (problem.code !== 'EvidenceConflict') {
    return {
      kind: 'EvidenceDeliveryRejected',
      delivery: {
        kind: delivery.kind,
        failure: { kind: 'RequestRejected', code: problem.code },
      },
    };
  }
  const rejected =
    problem.reason === 'SequenceGap'
      ? {
          kind: 'RequestRejected' as const,
          code: 'EvidenceConflict' as const,
          reason: 'SequenceGap' as const,
          expectedStartingSequence: problem.expectedStartingSequence,
          receivedStartingSequence: problem.receivedStartingSequence,
        }
      : {
          kind: 'RequestRejected' as const,
          code: 'EvidenceConflict' as const,
          reason: problem.reason,
        };
  return {
    kind: 'EvidenceDeliveryRejected',
    delivery: { kind: delivery.kind, failure: rejected },
  };
}
type LocalCheckpointInspection =
  { readonly kind: 'Matches' } | { readonly kind: 'Rejected' } | { readonly kind: 'Unavailable' };

function evidenceFailure(recording: EvidenceRecording): Extract<
  SealedEvidenceSettlementOutcome,
  {
    readonly kind:
      | 'SecretDetected'
      | 'CheckpointAcceptanceRejected'
      | 'EvidenceIntegrityFailure'
      | 'EvidenceUnavailable';
  }
> {
  switch (recording.kind) {
    case 'SecretDetected':
      return { kind: 'SecretDetected' };
    case 'Unavailable':
      return { kind: 'EvidenceUnavailable' };
    case 'OutboxBackpressure':
    case 'OutboxBoundReached':
      return { kind: 'CheckpointAcceptanceRejected' };
    case 'ObservationRejected':
    case 'LocalStateCorruption':
    case 'Recorded':
      return { kind: 'EvidenceIntegrityFailure' };
  }
}

function timestamp(instant: number): string | undefined {
  if (!Number.isSafeInteger(instant) || instant < 0) return undefined;
  const date = new Date(instant);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

function inspectLocalCheckpoint(
  recorder: EvidenceRecorder,
  checkpointSaid: string,
): LocalCheckpointInspection {
  const reading = recorder.checkpoint(checkpointSaid);
  if (reading.kind === 'Unavailable') return reading;
  if (reading.kind !== 'Read') return { kind: 'Rejected' };
  const checkpoint = reading.checkpoint;
  const run = recorder.run;
  return checkpoint.d === checkpointSaid &&
    checkpoint.runId === run.binding.runId &&
    checkpoint.taskId === run.binding.taskId &&
    checkpoint.taskRevisionSaid === run.binding.taskRevisionSaid &&
    checkpoint.harnessRevisionSaid ===
      (run.currentExecution?.harnessRevisionSaid ?? run.binding.initialHarnessRevisionSaid) &&
    checkpoint.personalAgentAid === run.binding.personalAgentAid &&
    checkpoint.taskMandateSaid === run.binding.taskMandateSaid
    ? { kind: 'Matches' }
    : { kind: 'Rejected' };
}

function projectionMatches(
  stream: EvidenceStreamProjection,
  payload: EvidenceSealPayload,
  checkpointSaid: string,
  exchangeSaid: string,
): boolean {
  if (
    stream.runId !== payload.runId ||
    stream.evidenceStreamId !== payload.evidenceStreamId ||
    stream.cursor.kind !== 'Accepted' ||
    stream.cursor.eventCount !== payload.eventCount ||
    stream.cursor.acceptedThroughSequence !== payload.finalSequence ||
    stream.cursor.chainHeadSaid !== payload.chainHeadSaid ||
    stream.checkpoint.kind !== 'Accepted' ||
    stream.checkpoint.checkpointSaid !== checkpointSaid
  ) {
    return false;
  }
  if (stream.seal.kind === 'SealExchangePending') {
    return stream.seal.sealExchangeSaid === exchangeSaid;
  }
  return (
    stream.seal.kind === 'Sealed' &&
    stream.seal.sealExchangeSaid === exchangeSaid &&
    stream.seal.eventCount === payload.eventCount &&
    stream.seal.finalSequence === payload.finalSequence &&
    stream.seal.chainHeadSaid === payload.chainHeadSaid
  );
}

export class SealedEvidenceSettlement implements RunEvidenceSealing {
  readonly #dependencies: SealedEvidenceSettlementDependencies;

  constructor(dependencies: SealedEvidenceSettlementDependencies) {
    if (
      !Number.isSafeInteger(dependencies.maximumObservations) ||
      dependencies.maximumObservations < 1 ||
      dependencies.maximumObservations > 300
    ) {
      throw new TypeError('Evidence seal observations must be bounded between 1 and 300');
    }
    this.#dependencies = dependencies;
  }

  async settle(
    recorder: EvidenceRecorder,
    checkpointSaid: string,
  ): Promise<SealedEvidenceSettlementOutcome> {
    if (recorder.run.binding.personalAgentAid !== this.#dependencies.sourceAid) {
      return { kind: 'EvidenceIntegrityFailure' };
    }
    const checkpoint = inspectLocalCheckpoint(recorder, checkpointSaid);
    if (checkpoint.kind === 'Unavailable') return { kind: 'EvidenceUnavailable' };
    if (checkpoint.kind === 'Rejected') return { kind: 'EvidenceIntegrityFailure' };
    let acceptanceEvent: EvidenceEvent;
    let pageFailures = 0;
    for (;;) {
      let delivery: EvidencePageDelivery;
      try {
        delivery = await deliverNextEvidencePage({
          recorder,
          hosted: this.#dependencies.hostedEvidence,
        });
      } catch {
        return { kind: 'EvidenceUnavailable' };
      }
      if (delivery.kind === 'Empty') {
        const accepted = recorder.recordCheckpointAcceptance(checkpointSaid);
        if (accepted.kind !== 'Recorded' && accepted.kind !== 'AlreadyRecorded')
          return evidenceFailure(accepted);
        if (
          accepted.event.event.kind !== 'CheckpointAccepted' ||
          accepted.event.event.checkpointSaid !== checkpointSaid
        )
          return { kind: 'EvidenceIntegrityFailure' };
        if (accepted.kind === 'Recorded') continue;
        acceptanceEvent = accepted.event;
        break;
      }
      if (delivery.kind !== 'Delivered') {
        if (
          (delivery.kind === 'ArtifactDeliveryRejected' ||
            delivery.kind === 'BatchDeliveryRejected') &&
          retryableEvidenceFailure(delivery.outcome)
        ) {
          pageFailures += 1;
          if (pageFailures < this.#dependencies.maximumObservations) {
            try {
              await this.#dependencies.wait(1_000);
            } catch {
              return { kind: 'EvidenceUnavailable' };
            }
            continue;
          }
        }
        return { kind: 'EvidenceDeliveryRejected', outcome: delivery };
      }
      pageFailures = 0;
      if (
        delivery.checkpoint.kind === 'CheckpointDelivered' &&
        delivery.checkpoint.checkpointSaid !== checkpointSaid
      ) {
        return { kind: 'EvidenceIntegrityFailure' };
      }
    }

    const readiness = recorder.readiness();
    if (readiness.kind === 'Unavailable') return { kind: 'EvidenceUnavailable' };
    if (
      readiness.kind !== 'Ready' ||
      readiness.readiness.kind !== 'Continued' ||
      readiness.readiness.streamId !==
        (recorder.run.currentExecution?.evidenceStreamId ??
          recorder.run.binding.evidenceStreamId) ||
      readiness.readiness.nextSequence !== acceptanceEvent.sequence + 1 ||
      readiness.readiness.previousEventSaid !== acceptanceEvent.d
    ) {
      return { kind: 'EvidenceIntegrityFailure' };
    }
    // The durable closing event fixes signing time as well as the final cursor.
    const preparedAt = Date.parse(acceptanceEvent.recordedAt);
    if (timestamp(preparedAt) === undefined) return { kind: 'SealExchangeUnavailable' };
    const payload: EvidenceSealPayload = {
      version: 1,
      kind: 'EvidenceStreamSeal',
      runId: recorder.run.binding.runId,
      evidenceStreamId:
        recorder.run.currentExecution?.evidenceStreamId ?? recorder.run.binding.evidenceStreamId,
      eventCount: readiness.readiness.nextSequence,
      finalSequence: readiness.readiness.nextSequence - 1,
      chainHeadSaid: readiness.readiness.previousEventSaid,
      harnessRevisionSaid:
        recorder.run.currentExecution?.harnessRevisionSaid ??
        recorder.run.binding.initialHarnessRevisionSaid,
      taskMandateSaid: recorder.run.binding.taskMandateSaid,
    };
    const acknowledged = recorder.sealAcknowledgement();
    if (acknowledged.kind === 'Unavailable') return { kind: 'EvidenceUnavailable' };
    if (acknowledged.kind === 'LocalStateCorruption') return { kind: 'EvidenceIntegrityFailure' };
    if (acknowledged.kind === 'Read') {
      const stream = acknowledged.projection;
      if (
        stream.seal.kind !== 'Sealed' ||
        !projectionMatches(stream, payload, checkpointSaid, stream.seal.sealExchangeSaid)
      )
        return { kind: 'SealAcknowledgementRejected' };
      return { kind: 'Sealed', stream: { ...stream, seal: stream.seal } };
    }
    const stable = {
      senderAlias: PERSONAL_AGENT_ALIAS,
      sourceAid: this.#dependencies.sourceAid,
      recipientAid: this.#dependencies.recipientAid,
      payload,
      preparedAt,
    };
    let exchangeSaid: string | undefined;
    for (
      let preparation = 0;
      preparation < this.#dependencies.maximumObservations;
      preparation += 1
    ) {
      try {
        const prepared = await this.#dependencies.exchange.prepare(stable);
        exchangeSaid = prepared.exchangeSaid;
        break;
      } catch (cause) {
        if (
          !(cause instanceof IdentityFailure) ||
          cause.detail.kind !== 'keria-unavailable' ||
          preparation + 1 === this.#dependencies.maximumObservations
        )
          return { kind: 'SealExchangeUnavailable' };
        try {
          await this.#dependencies.wait(1_000);
        } catch {
          return { kind: 'SealExchangeUnavailable' };
        }
      }
    }
    if (exchangeSaid === undefined) return { kind: 'SealExchangeUnavailable' };
    for (let delivery = 0; delivery < this.#dependencies.maximumObservations; delivery += 1) {
      try {
        const delivered = await this.#dependencies.exchange.deliver({ ...stable, exchangeSaid });
        if (delivered.exchangeSaid !== exchangeSaid) return { kind: 'SealProjectionRejected' };
        break;
      } catch (cause) {
        if (
          !(cause instanceof IdentityFailure) ||
          cause.detail.kind !== 'keria-unavailable' ||
          delivery + 1 === this.#dependencies.maximumObservations
        )
          return { kind: 'SealExchangeUnavailable' };
        try {
          await this.#dependencies.wait(1_000);
        } catch {
          return { kind: 'SealExchangeUnavailable' };
        }
      }
    }

    for (
      let observation = 0;
      observation < this.#dependencies.maximumObservations;
      observation += 1
    ) {
      let reconciled: HostedEvidenceSealReconciliation;
      try {
        reconciled = await this.#dependencies.hostedSeals.reconcileSeal(
          recorder.run.binding.runId,
          { version: 1, sealExchangeSaid: exchangeSaid },
        );
      } catch {
        reconciled = { kind: 'ServerUnavailable' };
      }
      if (
        reconciled.kind !== 'Pending' &&
        reconciled.kind !== 'Sealed' &&
        !retryableEvidenceFailure(reconciled)
      ) {
        return { kind: 'SealReconciliationRejected', outcome: reconciled };
      }
      if (
        (reconciled.kind === 'Pending' || reconciled.kind === 'Sealed') &&
        !projectionMatches(reconciled.stream, payload, checkpointSaid, exchangeSaid)
      ) {
        return { kind: 'SealProjectionRejected' };
      }
      if (reconciled.kind === 'Sealed') {
        for (
          let acknowledgement = 0;
          acknowledgement < this.#dependencies.maximumObservations;
          acknowledgement += 1
        ) {
          const recorded = recorder.recordSealAcknowledgement(reconciled.stream);
          switch (recorded.kind) {
            case 'Recorded':
            case 'AlreadyRecorded':
              return { kind: 'Sealed', stream: reconciled.stream };
            case 'AcknowledgementRejected':
            case 'LocalStateCorruption':
              return { kind: 'SealAcknowledgementRejected' };
            case 'Unavailable':
              if (acknowledgement + 1 === this.#dependencies.maximumObservations)
                return { kind: 'EvidenceUnavailable' };
              try {
                await this.#dependencies.wait(1_000);
              } catch {
                return { kind: 'EvidenceUnavailable' };
              }
          }
        }
        return { kind: 'EvidenceUnavailable' };
      }
      if (observation + 1 < this.#dependencies.maximumObservations) {
        try {
          await this.#dependencies.wait(1_000);
        } catch {
          return { kind: 'SealObservationUnavailable' };
        }
      } else if (reconciled.kind !== 'Pending') {
        return { kind: 'SealObservationUnavailable' };
      }
    }
    return { kind: 'SealPendingLimitReached' };
  }
}
