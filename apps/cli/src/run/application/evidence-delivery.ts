import {
  evidenceArtifactReferences,
  type AppendEvidenceBatchBody,
  type EvidenceArtifact,
  type EvidenceArtifactAcknowledgement,
  type EvidenceBatchAcknowledgement,
  type EvidenceEvent,
  type EvidenceProblem,
  type VerifiedCheckpoint,
} from '@devrandom/protocol';
import type {
  EvidenceRecorder,
  RunEvidenceDeliveryDisposition,
  RunWallClock,
} from '@devrandom/runtime';

export type HostedEvidenceFailure =
  | { readonly kind: 'InputInvalid' }
  | { readonly kind: 'ServerUnavailable' }
  | { readonly kind: 'ResponseInvalid' }
  | { readonly kind: 'RequestRejected'; readonly problem: EvidenceProblem };

export type HostedArtifactStorage =
  | {
      readonly kind: 'Stored' | 'AlreadyStored';
      readonly acknowledgement: EvidenceArtifactAcknowledgement;
    }
  | HostedEvidenceFailure;

export type HostedBatchAppend =
  | { readonly kind: 'Accepted'; readonly acknowledgement: EvidenceBatchAcknowledgement }
  | HostedEvidenceFailure;

export interface HostedEvidence {
  storeArtifact(
    runId: string,
    artifact: EvidenceArtifact,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<HostedArtifactStorage>;
  appendBatch(
    runId: string,
    body: AppendEvidenceBatchBody,
    signal?: AbortSignal,
  ): Promise<HostedBatchAppend>;
}

export interface EvidenceDeliveryInput {
  readonly recorder: EvidenceRecorder;
  readonly hosted: HostedEvidence;
  readonly signal?: AbortSignal;
}

export type DeliveredEvidenceCheckpoint =
  | { readonly kind: 'NoCheckpoint' }
  | { readonly kind: 'CheckpointDelivered'; readonly checkpointSaid: string };

export type EvidencePageDelivery =
  | { readonly kind: 'Empty' }
  | { readonly kind: 'Aborted' }
  | {
      readonly kind: 'Delivered';
      readonly acknowledgement: EvidenceBatchAcknowledgement;
      readonly checkpoint: DeliveredEvidenceCheckpoint;
    }
  | { readonly kind: 'CheckpointUnavailable' }
  | { readonly kind: 'LocalStateCorruption' }
  | { readonly kind: 'OutboxUnavailable' }
  | { readonly kind: 'ArtifactDeliveryRejected'; readonly outcome: HostedEvidenceFailure }
  | { readonly kind: 'BatchDeliveryRejected'; readonly outcome: HostedEvidenceFailure }
  | { readonly kind: 'AcknowledgementRejected' };

function checkpointForPage(
  recorder: EvidenceRecorder,
  events: readonly EvidenceEvent[],
): VerifiedCheckpoint | undefined | 'LocalStateCorruption' | 'OutboxUnavailable' {
  const references = events.flatMap((event) =>
    event.event.kind === 'CheckpointVerified' ? [event.event.checkpointSaid] : [],
  );
  if (references.length === 0) {
    return undefined;
  }
  if (references.length !== 1 || references[0] === undefined) {
    return 'LocalStateCorruption';
  }
  const reading = recorder.checkpoint(references[0]);
  switch (reading.kind) {
    case 'Read':
      return reading.checkpoint;
    case 'CheckpointNotFound':
    case 'LocalStateCorruption':
      return 'LocalStateCorruption';
    case 'Unavailable':
      return 'OutboxUnavailable';
  }
}

function localPageFailure(
  kind: 'LocalStateCorruption' | 'Unavailable',
): Extract<EvidencePageDelivery, { readonly kind: 'LocalStateCorruption' | 'OutboxUnavailable' }> {
  return kind === 'LocalStateCorruption'
    ? { kind: 'LocalStateCorruption' }
    : { kind: 'OutboxUnavailable' };
}

export async function deliverNextEvidencePage(
  input: EvidenceDeliveryInput,
): Promise<EvidencePageDelivery> {
  if (input.signal?.aborted) return { kind: 'Aborted' };
  const pending = input.recorder.page();
  if (pending.kind === 'Empty') {
    return pending;
  }
  if (pending.kind === 'LocalStateCorruption' || pending.kind === 'Unavailable') {
    return localPageFailure(pending.kind);
  }

  const referenced = new Set(
    pending.page.events.flatMap((event) => evidenceArtifactReferences(event.event)),
  );
  for (const artifactSaid of referenced) {
    const local = input.recorder.artifact(artifactSaid);
    if (local.kind === 'ArtifactNotFound' || local.kind === 'LocalStateCorruption') {
      return { kind: 'LocalStateCorruption' };
    }
    if (local.kind === 'Unavailable') {
      return { kind: 'OutboxUnavailable' };
    }
    const stored = await input.hosted.storeArtifact(
      input.recorder.run.binding.runId,
      local.artifact,
      local.bytes,
      input.signal,
    );
    if (input.signal?.aborted) return { kind: 'Aborted' };
    switch (stored.kind) {
      case 'InputInvalid':
      case 'ServerUnavailable':
      case 'ResponseInvalid':
      case 'RequestRejected':
        return { kind: 'ArtifactDeliveryRejected', outcome: stored };
      case 'Stored':
      case 'AlreadyStored':
        break;
    }
    if (
      stored.acknowledgement.runId !== input.recorder.run.binding.runId ||
      stored.acknowledgement.artifact.d !== local.artifact.d
    ) {
      return {
        kind: 'ArtifactDeliveryRejected',
        outcome: { kind: 'ResponseInvalid' },
      };
    }
  }

  const checkpoint = checkpointForPage(input.recorder, pending.page.events);
  if (checkpoint === 'LocalStateCorruption' || checkpoint === 'OutboxUnavailable') {
    return { kind: checkpoint };
  }
  const body: AppendEvidenceBatchBody =
    checkpoint === undefined
      ? {
          version: 1,
          batch: pending.page.batch,
          events: [...pending.page.events],
        }
      : {
          version: 1,
          batch: pending.page.batch,
          events: [...pending.page.events],
          checkpoint,
        };
  const appended = await input.hosted.appendBatch(
    input.recorder.run.binding.runId,
    body,
    input.signal,
  );
  if (input.signal?.aborted) return { kind: 'Aborted' };
  if (appended.kind !== 'Accepted') {
    return { kind: 'BatchDeliveryRejected', outcome: appended };
  }
  const acknowledged = input.recorder.acknowledge(appended.acknowledgement);
  switch (acknowledged.kind) {
    case 'Acknowledged':
    case 'AlreadyAcknowledged':
      return {
        kind: 'Delivered',
        acknowledgement: acknowledged.acknowledgement,
        checkpoint:
          checkpoint === undefined
            ? { kind: 'NoCheckpoint' }
            : { kind: 'CheckpointDelivered', checkpointSaid: checkpoint.d },
      };
    case 'AcknowledgementRejected':
      return { kind: 'AcknowledgementRejected' };
    case 'LocalStateCorruption':
      return { kind: 'LocalStateCorruption' };
    case 'Unavailable':
      return { kind: 'OutboxUnavailable' };
  }
}

export function retryableEvidenceFailure(failure: HostedEvidenceFailure): boolean {
  if (failure.kind === 'ServerUnavailable') return true;
  if (failure.kind !== 'RequestRejected') return false;
  switch (failure.problem.code) {
    case 'EvidenceUnavailable':
    case 'WorkAccessGrantConcurrentUpdate':
      return true;
    case 'EvidenceConflict':
      return failure.problem.reason === 'CursorConcurrentUpdate';
    case 'EvidenceRejected':
    case 'EvidenceRequestInvalid':
    case 'EvidenceCapabilityInvalid':
    case 'EvidenceRunNotFound':
    case 'EvidenceQuotaExceeded':
    case 'WorkAccessGrantExpired':
    case 'WorkAccessGrantRevoked':
    case 'WorkAccessGrantReleased':
    case 'WorkAccessGrantScopeRejected':
    case 'WorkAccessGrantExhausted':
      return false;
  }
}

function deliveryFailure(
  failure: HostedEvidenceFailure,
): RunEvidenceDeliveryDisposition | { readonly kind: 'Retry' } {
  if (retryableEvidenceFailure(failure)) return { kind: 'Retry' };
  switch (failure.kind) {
    case 'ServerUnavailable':
      return { kind: 'Retry' };
    case 'InputInvalid':
    case 'ResponseInvalid':
      return { kind: 'EvidenceIntegrityFailure' };
    case 'RequestRejected':
      switch (failure.problem.code) {
        case 'EvidenceConflict':
          return { kind: 'EvidenceIntegrityFailure' };
        case 'EvidenceRejected':
        case 'EvidenceRequestInvalid':
          return { kind: 'EvidenceIntegrityFailure' };
        case 'EvidenceCapabilityInvalid':
        case 'EvidenceRunNotFound':
        case 'EvidenceQuotaExceeded':
        case 'WorkAccessGrantExpired':
        case 'WorkAccessGrantRevoked':
        case 'WorkAccessGrantReleased':
        case 'WorkAccessGrantScopeRejected':
        case 'WorkAccessGrantExhausted':
          return { kind: 'DependencyUnavailable' };
        case 'EvidenceUnavailable':
        case 'WorkAccessGrantConcurrentUpdate':
          return { kind: 'Retry' };
      }
  }
}

/** Deliver ordered pages during execution; settlement takes over after cancellation joins. */
export async function deliverRunEvidence(
  input: EvidenceDeliveryInput & { readonly signal: AbortSignal; readonly clock: RunWallClock },
): Promise<RunEvidenceDeliveryDisposition> {
  while (!input.signal.aborted) {
    const delivery = await deliverNextEvidencePage(input);
    switch (delivery.kind) {
      case 'Aborted':
        return delivery;
      case 'Delivered':
        if (delivery.checkpoint.kind !== 'NoCheckpoint') {
          return { kind: 'EvidenceIntegrityFailure' };
        }
        continue;
      case 'Empty':
        break;
      case 'ArtifactDeliveryRejected':
      case 'BatchDeliveryRejected': {
        const failure = deliveryFailure(delivery.outcome);
        if (failure.kind !== 'Retry') return failure;
        break;
      }
      case 'OutboxUnavailable':
        return { kind: 'EvidenceUnavailable' };
      case 'CheckpointUnavailable':
      case 'LocalStateCorruption':
      case 'AcknowledgementRejected':
        return { kind: 'EvidenceIntegrityFailure' };
    }
    const waited = await input.clock.waitUntil(input.clock.monotonicNow() + 1_000, input.signal);
    if (waited.kind === 'Aborted') return waited;
  }
  return { kind: 'Aborted' };
}
