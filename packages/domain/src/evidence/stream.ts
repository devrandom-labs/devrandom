import { runStateIsCoherent, type RunLifecycle, type SubmissionVerification } from '../run/run.js';

const maximumBatchEvents = 32;
const maximumBatchBytes = 256 * 1_024;
const maximumArtifactBytes = 512 * 1_024;

export interface EvidenceStreamBinding {
  readonly streamId: string;
  readonly runId: string;
  readonly ownerAid: string;
  readonly taskId: string;
  readonly taskRevisionSaid: string;
  readonly incarnationId: string;
  readonly harnessRevisionSaid: string;
  readonly personalAgentAid: string;
  readonly taskMandateSaid: string;
  readonly combinedByteCeiling: number;
}

export type EvidenceCursor =
  | { readonly kind: 'Genesis' }
  | {
      readonly kind: 'Continued';
      readonly acceptedThrough: number;
      readonly chainHeadSaid: string;
    };

export type EvidenceProvisionalOutcome =
  | { readonly kind: 'None' }
  | {
      readonly kind: 'Checkpointed';
      readonly checkpointSaid: string;
      readonly lifecycle: RunLifecycle;
      readonly submissionVerification: SubmissionVerification;
    };

export type EvidenceSeal =
  | { readonly kind: 'Open' }
  | {
      readonly kind: 'Sealed';
      readonly exchangeSaid: string;
      readonly sealedAt: string;
    };

export interface EvidenceStream {
  readonly version: number;
  readonly binding: EvidenceStreamBinding;
  readonly cursor: EvidenceCursor;
  readonly acceptedEvidenceBytes: number;
  readonly acceptedArtifactBytes: number;
  readonly provisional: EvidenceProvisionalOutcome;
  readonly seal: EvidenceSeal;
}

export type EvidenceStreamCreation =
  | { readonly kind: 'Created'; readonly stream: EvidenceStream }
  | { readonly kind: 'InvalidByteCeiling' }
  | { readonly kind: 'PrincipalConflict' };

export type EvidenceBatchPredecessor =
  { readonly kind: 'Genesis' } | { readonly kind: 'Previous'; readonly eventSaid: string };

export type EvidenceBatchCheckpoint =
  | { readonly kind: 'Absent' }
  | {
      readonly kind: 'Present';
      readonly checkpointSaid: string;
      readonly lifecycle: RunLifecycle;
      readonly submissionVerification: SubmissionVerification;
    };

export interface EvidenceBatchAcceptanceInput {
  readonly batchSaid: string;
  readonly startingSequence: number;
  readonly endingSequence: number;
  readonly predecessor: EvidenceBatchPredecessor;
  readonly eventSaids: readonly string[];
  readonly encodedBytes: number;
  readonly checkpoint: EvidenceBatchCheckpoint;
}

export type EvidenceBatchAcceptance =
  | { readonly kind: 'Accepted'; readonly stream: EvidenceStream }
  | { readonly kind: 'StreamSealed' }
  | { readonly kind: 'BatchLimitExceeded' }
  | { readonly kind: 'BatchPositionInvalid' }
  | { readonly kind: 'DuplicateEventSaid' }
  | { readonly kind: 'SequenceGap'; readonly expectedSequence: number }
  | { readonly kind: 'PredecessorConflict' }
  | { readonly kind: 'CheckpointConflict' }
  | { readonly kind: 'CheckpointDispositionInvalid' }
  | { readonly kind: 'RunByteBudgetExhausted' };

export type EvidenceArtifactAdmission =
  | { readonly kind: 'Admitted'; readonly stream: EvidenceStream }
  | { readonly kind: 'StreamSealed' }
  | { readonly kind: 'ArtifactLimitExceeded' }
  | { readonly kind: 'RunByteBudgetExhausted' };

export interface EvidenceStreamSealInput {
  readonly exchangeSaid: string;
  readonly eventCount: number;
  readonly finalSequence: number;
  readonly chainHeadSaid: string;
  readonly sealedAt: string;
}

export type EvidenceStreamSealing =
  | { readonly kind: 'Sealed'; readonly stream: EvidenceStream }
  | { readonly kind: 'Equivalent'; readonly stream: EvidenceStream }
  | { readonly kind: 'SealConflict' }
  | { readonly kind: 'EvidenceAbsent' }
  | { readonly kind: 'CheckpointAbsent' }
  | { readonly kind: 'CursorConflict' };

function cloneLifecycle(lifecycle: RunLifecycle): RunLifecycle {
  if (lifecycle.kind === 'Active') {
    const phase = lifecycle.phase;
    return phase.kind === 'Blocked'
      ? {
          kind: 'Active',
          phase: {
            kind: 'Blocked',
            reason: phase.reason,
            checkpointSaid: phase.checkpointSaid,
          },
        }
      : { kind: 'Active', phase: { kind: phase.kind } };
  }
  const outcome = lifecycle.outcome;
  switch (outcome.kind) {
    case 'Submitted':
      return {
        kind: 'Ended',
        outcome: { kind: 'Submitted', checkpointSaid: outcome.checkpointSaid },
      };
    case 'Failed':
      return {
        kind: 'Ended',
        outcome: {
          kind: 'Failed',
          failure: outcome.failure,
          checkpointSaid: outcome.checkpointSaid,
        },
      };
    case 'Cancelled':
      return {
        kind: 'Ended',
        outcome: { kind: 'Cancelled', checkpointSaid: outcome.checkpointSaid },
      };
    case 'AuthorityRevoked':
      return {
        kind: 'Ended',
        outcome: {
          kind: 'AuthorityRevoked',
          mandateSaid: outcome.mandateSaid,
          checkpointSaid: outcome.checkpointSaid,
        },
      };
    case 'CalibrationConfirmed':
      return {
        kind: 'Ended',
        outcome: {
          kind: 'CalibrationConfirmed',
          checkpointSaid: outcome.checkpointSaid,
          category: { ...outcome.category },
        },
      };
    case 'CalibrationExcluded':
      return {
        kind: 'Ended',
        outcome: {
          kind: 'CalibrationExcluded',
          checkpointSaid: outcome.checkpointSaid,
          reason: outcome.reason,
        },
      };
    case 'CalibrationRejected':
      return {
        kind: 'Ended',
        outcome: {
          kind: 'CalibrationRejected',
          checkpointSaid: outcome.checkpointSaid,
          reason: outcome.reason,
        },
      };
  }
}

function checkpointDispositionIsValid(checkpoint: EvidenceBatchCheckpoint): boolean {
  if (checkpoint.kind === 'Absent') {
    return true;
  }
  if (
    !runStateIsCoherent({
      lifecycle: checkpoint.lifecycle,
      submissionVerification: checkpoint.submissionVerification,
    })
  ) {
    return false;
  }
  if (checkpoint.lifecycle.kind === 'Active') {
    return (
      checkpoint.lifecycle.phase.kind === 'Blocked' &&
      checkpoint.lifecycle.phase.checkpointSaid === checkpoint.checkpointSaid
    );
  }
  return (
    checkpoint.lifecycle.outcome.kind !== 'Cancelled' &&
    checkpoint.lifecycle.outcome.checkpointSaid === checkpoint.checkpointSaid
  );
}

function expectedSequence(cursor: EvidenceCursor): number {
  return cursor.kind === 'Genesis' ? 0 : cursor.acceptedThrough + 1;
}

function predecessorMatches(
  cursor: EvidenceCursor,
  predecessor: EvidenceBatchPredecessor,
): boolean {
  return cursor.kind === 'Genesis'
    ? predecessor.kind === 'Genesis'
    : predecessor.kind === 'Previous' && predecessor.eventSaid === cursor.chainHeadSaid;
}

function combinedBytes(stream: EvidenceStream, addedBytes: number): number {
  return stream.acceptedEvidenceBytes + stream.acceptedArtifactBytes + addedBytes;
}

export function createEvidenceStream(binding: EvidenceStreamBinding): EvidenceStreamCreation {
  if (!Number.isSafeInteger(binding.combinedByteCeiling) || binding.combinedByteCeiling < 0) {
    return { kind: 'InvalidByteCeiling' };
  }
  if (binding.ownerAid === binding.personalAgentAid) {
    return { kind: 'PrincipalConflict' };
  }
  return {
    kind: 'Created',
    stream: {
      version: 0,
      binding: { ...binding },
      cursor: { kind: 'Genesis' },
      acceptedEvidenceBytes: 0,
      acceptedArtifactBytes: 0,
      provisional: { kind: 'None' },
      seal: { kind: 'Open' },
    },
  };
}

export function admitEvidenceArtifact(
  stream: EvidenceStream,
  input: { readonly byteLength: number },
): EvidenceArtifactAdmission {
  if (stream.seal.kind === 'Sealed') {
    return { kind: 'StreamSealed' };
  }
  if (
    !Number.isSafeInteger(input.byteLength) ||
    input.byteLength < 0 ||
    input.byteLength > maximumArtifactBytes
  ) {
    return { kind: 'ArtifactLimitExceeded' };
  }
  if (combinedBytes(stream, input.byteLength) > stream.binding.combinedByteCeiling) {
    return { kind: 'RunByteBudgetExhausted' };
  }
  return {
    kind: 'Admitted',
    stream: {
      ...stream,
      version: stream.version + 1,
      acceptedArtifactBytes: stream.acceptedArtifactBytes + input.byteLength,
    },
  };
}

export function acceptEvidenceBatch(
  stream: EvidenceStream,
  input: EvidenceBatchAcceptanceInput,
): EvidenceBatchAcceptance {
  if (stream.seal.kind === 'Sealed') {
    return { kind: 'StreamSealed' };
  }
  if (
    input.eventSaids.length === 0 ||
    input.eventSaids.length > maximumBatchEvents ||
    !Number.isSafeInteger(input.encodedBytes) ||
    input.encodedBytes <= 0 ||
    input.encodedBytes > maximumBatchBytes
  ) {
    return { kind: 'BatchLimitExceeded' };
  }
  if (
    !Number.isSafeInteger(input.startingSequence) ||
    !Number.isSafeInteger(input.endingSequence) ||
    input.startingSequence < 0 ||
    input.endingSequence !== input.startingSequence + input.eventSaids.length - 1
  ) {
    return { kind: 'BatchPositionInvalid' };
  }
  if (new Set(input.eventSaids).size !== input.eventSaids.length) {
    return { kind: 'DuplicateEventSaid' };
  }
  const nextSequence = expectedSequence(stream.cursor);
  if (input.startingSequence !== nextSequence) {
    return { kind: 'SequenceGap', expectedSequence: nextSequence };
  }
  if (!predecessorMatches(stream.cursor, input.predecessor)) {
    return { kind: 'PredecessorConflict' };
  }
  if (stream.provisional.kind === 'Checkpointed' && input.checkpoint.kind === 'Present') {
    return { kind: 'CheckpointConflict' };
  }
  if (!checkpointDispositionIsValid(input.checkpoint)) {
    return { kind: 'CheckpointDispositionInvalid' };
  }
  if (combinedBytes(stream, input.encodedBytes) > stream.binding.combinedByteCeiling) {
    return { kind: 'RunByteBudgetExhausted' };
  }
  const chainHeadSaid = input.eventSaids[input.eventSaids.length - 1];
  if (chainHeadSaid === undefined) {
    return { kind: 'BatchPositionInvalid' };
  }
  const provisional: EvidenceProvisionalOutcome =
    input.checkpoint.kind === 'Absent'
      ? stream.provisional
      : {
          kind: 'Checkpointed',
          checkpointSaid: input.checkpoint.checkpointSaid,
          lifecycle: cloneLifecycle(input.checkpoint.lifecycle),
          submissionVerification: { ...input.checkpoint.submissionVerification },
        };
  return {
    kind: 'Accepted',
    stream: {
      ...stream,
      version: stream.version + 1,
      cursor: {
        kind: 'Continued',
        acceptedThrough: input.endingSequence,
        chainHeadSaid,
      },
      acceptedEvidenceBytes: stream.acceptedEvidenceBytes + input.encodedBytes,
      provisional,
    },
  };
}

export function sealEvidenceStream(
  stream: EvidenceStream,
  input: EvidenceStreamSealInput,
): EvidenceStreamSealing {
  if (stream.seal.kind === 'Sealed') {
    return stream.seal.exchangeSaid === input.exchangeSaid &&
      stream.seal.sealedAt === input.sealedAt
      ? { kind: 'Equivalent', stream }
      : { kind: 'SealConflict' };
  }
  if (stream.cursor.kind === 'Genesis') {
    return { kind: 'EvidenceAbsent' };
  }
  if (stream.provisional.kind === 'None') {
    return { kind: 'CheckpointAbsent' };
  }
  if (
    input.eventCount !== stream.cursor.acceptedThrough + 1 ||
    input.finalSequence !== stream.cursor.acceptedThrough ||
    input.chainHeadSaid !== stream.cursor.chainHeadSaid
  ) {
    return { kind: 'CursorConflict' };
  }
  return {
    kind: 'Sealed',
    stream: {
      ...stream,
      version: stream.version + 1,
      seal: {
        kind: 'Sealed',
        exchangeSaid: input.exchangeSaid,
        sealedAt: input.sealedAt,
      },
    },
  };
}
