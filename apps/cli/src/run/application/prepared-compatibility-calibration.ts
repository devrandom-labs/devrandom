import {
  preparedCompatibilityFailureCategoriesMatch,
  type CalibrationExclusionReason,
  type CalibrationRejectionReason,
  type RunCalibrationDisposition,
} from '@devrandom/domain';
import { decodeEvidenceEvent, type EvidenceEvent } from '@devrandom/protocol';

import type {
  PreparedCompatibilityFailureCategory,
  PreparedCompatibilityFailureClassification,
} from './prepared-compatibility.js';

export interface PreparedCompatibilityProviderProof {
  readonly message: EvidenceEvent;
  readonly proposal: EvidenceEvent;
  readonly effect: EvidenceEvent;
}

export type PreparedCompatibilityCalibrationAttempt =
  | {
      readonly kind: 'ClassifiedRealProviderRun';
      readonly runId: string;
      readonly classification: Extract<
        PreparedCompatibilityFailureClassification,
        { readonly kind: 'Confirmed' | 'NotConfirmed' }
      >;
      readonly providerProof: PreparedCompatibilityProviderProof;
    }
  | {
      readonly kind: 'ExcludedRun';
      readonly runId: string;
      readonly reason: CalibrationExclusionReason;
    };

export type PreparedCompatibilityCalibrationEntry =
  | {
      readonly kind: 'Counted';
      readonly runId: string;
      readonly category: PreparedCompatibilityFailureCategory;
      readonly modelMessageEventSaid: string;
      readonly toolProposalEventSaid: string;
      readonly toolEffectEventSaid: string;
      readonly verifierReceiptSaids: readonly string[];
    }
  | {
      readonly kind: 'Excluded';
      readonly runId: string;
      readonly reason: CalibrationExclusionReason;
    }
  | {
      readonly kind: 'Rejected';
      readonly runId: string;
      readonly reason: CalibrationRejectionReason;
    };

export interface PreparedCompatibilityCalibrationRecord {
  readonly version: 1;
  readonly binding:
    | { readonly kind: 'AwaitingConfirmedCategory' }
    | { readonly kind: 'Bound'; readonly category: PreparedCompatibilityFailureCategory };
  readonly attempts: readonly PreparedCompatibilityCalibrationEntry[];
}

export type CompatibilityCalibrationRecordReading =
  | { readonly kind: 'NotFound' }
  | { readonly kind: 'Loaded'; readonly record: PreparedCompatibilityCalibrationRecord }
  | { readonly kind: 'Unavailable' }
  | { readonly kind: 'Corrupt' };

export type CompatibilityCalibrationRecordCommitment =
  { readonly kind: 'Committed' } | { readonly kind: 'Conflict' } | { readonly kind: 'Unavailable' };

export interface CompatibilityCalibrationRecords {
  load(): Promise<CompatibilityCalibrationRecordReading>;
  commit(
    expectedAttemptCount: number,
    record: PreparedCompatibilityCalibrationRecord,
  ): Promise<CompatibilityCalibrationRecordCommitment>;
}

export type PreparedCompatibilityCalibrationDisposition =
  | {
      readonly kind: 'Collecting';
      readonly acceptedCleanRuns: number;
      readonly excludedRuns: number;
      readonly remainingAttempts: number;
    }
  | {
      readonly kind: 'Calibrated';
      readonly acceptedCleanRuns: number;
      readonly excludedRuns: number;
      readonly category: PreparedCompatibilityFailureCategory;
    }
  | {
      readonly kind: 'InsufficientCleanRuns';
      readonly acceptedCleanRuns: number;
      readonly excludedRuns: number;
    }
  | {
      readonly kind: 'Rejected';
      readonly reason: Extract<
        PreparedCompatibilityCalibrationEntry,
        { readonly kind: 'Rejected' }
      >['reason'];
    };

export type PreparedCompatibilityCalibrationRecording =
  | {
      readonly kind: 'Recorded';
      readonly disposition: PreparedCompatibilityCalibrationDisposition;
    }
  | { readonly kind: 'RunAlreadyRecorded' }
  | { readonly kind: 'CalibrationClosed' }
  | { readonly kind: 'EvidenceRejected' }
  | { readonly kind: 'ConcurrentUpdate' }
  | { readonly kind: 'RecordUnavailable' }
  | { readonly kind: 'RecordCorrupt' };

export type PreparedCompatibilityCalibrationAssessment =
  | { readonly kind: 'Accepted'; readonly disposition: RunCalibrationDisposition }
  | { readonly kind: 'RunAlreadyRecorded' }
  | { readonly kind: 'CalibrationClosed' }
  | { readonly kind: 'EvidenceRejected' }
  | { readonly kind: 'RecordUnavailable' }
  | { readonly kind: 'RecordCorrupt' };

export interface PreparedCompatibilityCalibrationSettlements {
  assess(
    attempt: PreparedCompatibilityCalibrationAttempt,
  ): Promise<PreparedCompatibilityCalibrationAssessment>;
  record(
    attempt: PreparedCompatibilityCalibrationAttempt,
  ): Promise<PreparedCompatibilityCalibrationRecording>;
}

export type PreparedCompatibilityCalibrationConfirmation =
  | {
      readonly kind: 'Confirmed';
      readonly acceptedCleanRuns: number;
      readonly excludedRuns: number;
    }
  | { readonly kind: 'NotCalibrated' }
  | { readonly kind: 'CategoryMismatch' }
  | { readonly kind: 'RecordUnavailable' }
  | { readonly kind: 'RecordCorrupt' };

export interface PreparedCompatibilityCalibrationConfirmations {
  confirm(
    category: PreparedCompatibilityFailureCategory,
  ): Promise<PreparedCompatibilityCalibrationConfirmation>;
}

const calibrationAttemptLimit = 5;
const requiredConfirmedRuns = 4;

function providerProofIsValid(runId: string, proof: PreparedCompatibilityProviderProof): boolean {
  if (
    decodeEvidenceEvent(proof.message).kind !== 'Accepted' ||
    decodeEvidenceEvent(proof.proposal).kind !== 'Accepted' ||
    decodeEvidenceEvent(proof.effect).kind !== 'Accepted' ||
    proof.message.runId !== runId ||
    proof.proposal.runId !== runId ||
    proof.effect.runId !== runId ||
    proof.proposal.taskId !== proof.message.taskId ||
    proof.effect.taskId !== proof.message.taskId ||
    proof.proposal.taskRevisionSaid !== proof.message.taskRevisionSaid ||
    proof.effect.taskRevisionSaid !== proof.message.taskRevisionSaid ||
    proof.proposal.harnessRevisionSaid !== proof.message.harnessRevisionSaid ||
    proof.effect.harnessRevisionSaid !== proof.message.harnessRevisionSaid
  ) {
    return false;
  }
  const message = proof.message.event;
  const proposal = proof.proposal.event;
  const effect = proof.effect.event;
  return (
    proof.message.producer.kind === 'PiExecutor' &&
    message.kind === 'ModelMessageCompleted' &&
    message.disposition === 'Completed' &&
    proof.proposal.producer.kind === 'ToolGateway' &&
    proposal.kind === 'ToolProposed' &&
    proof.effect.producer.kind === 'ToolGateway' &&
    effect.kind === 'EffectCompleted' &&
    proposal.piSessionId === message.piSessionId &&
    proposal.modelTurnId === message.modelTurnId &&
    proposal.piSessionId === effect.piSessionId &&
    proposal.modelTurnId === effect.modelTurnId &&
    proposal.toolCallId === effect.toolCallId &&
    proposal.proposalIndex === effect.proposalIndex &&
    proposal.tool === effect.tool &&
    proposal.requiredCapability === effect.requiredCapability &&
    proposal.resource === effect.resource &&
    proof.message.sequence < proof.proposal.sequence &&
    proof.proposal.sequence < proof.effect.sequence
  );
}

function disposition(
  record: PreparedCompatibilityCalibrationRecord,
): PreparedCompatibilityCalibrationDisposition {
  const rejected = record.attempts.find(
    (
      entry,
    ): entry is Extract<PreparedCompatibilityCalibrationEntry, { readonly kind: 'Rejected' }> =>
      entry.kind === 'Rejected',
  );
  if (rejected !== undefined) {
    return { kind: 'Rejected', reason: rejected.reason };
  }
  const acceptedCleanRuns = record.attempts.filter(({ kind }) => kind === 'Counted').length;
  const excludedRuns = record.attempts.filter(({ kind }) => kind === 'Excluded').length;
  if (record.attempts.length < calibrationAttemptLimit) {
    return {
      kind: 'Collecting',
      acceptedCleanRuns,
      excludedRuns,
      remainingAttempts: calibrationAttemptLimit - record.attempts.length,
    };
  }
  return acceptedCleanRuns >= requiredConfirmedRuns && record.binding.kind === 'Bound'
    ? {
        kind: 'Calibrated',
        acceptedCleanRuns,
        excludedRuns,
        category: record.binding.category,
      }
    : { kind: 'InsufficientCleanRuns', acceptedCleanRuns, excludedRuns };
}

function calibrationIsClosed(record: PreparedCompatibilityCalibrationRecord): boolean {
  return (
    record.attempts.length >= calibrationAttemptLimit ||
    record.attempts.some(({ kind }) => kind === 'Rejected')
  );
}

function classifiedEntry(
  attempt: Extract<
    PreparedCompatibilityCalibrationAttempt,
    { readonly kind: 'ClassifiedRealProviderRun' }
  >,
  record: PreparedCompatibilityCalibrationRecord,
): PreparedCompatibilityCalibrationEntry | undefined {
  const classification = attempt.classification;
  if (!providerProofIsValid(attempt.runId, attempt.providerProof)) {
    return undefined;
  }
  if (classification.kind === 'NotConfirmed') {
    return { kind: 'Rejected', runId: attempt.runId, reason: classification.reason };
  }
  if (
    attempt.providerProof.message.taskId !== classification.category.taskId ||
    attempt.providerProof.message.taskRevisionSaid !== classification.category.taskRevisionSaid ||
    attempt.providerProof.message.harnessRevisionSaid !==
      classification.category.harnessRevisionSaid
  ) {
    return undefined;
  }
  if (
    record.binding.kind === 'Bound' &&
    !preparedCompatibilityFailureCategoriesMatch(record.binding.category, classification.category)
  ) {
    return { kind: 'Rejected', runId: attempt.runId, reason: 'CategoryChanged' };
  }
  return {
    kind: 'Counted',
    runId: attempt.runId,
    category: classification.category,
    modelMessageEventSaid: attempt.providerProof.message.d,
    toolProposalEventSaid: attempt.providerProof.proposal.d,
    toolEffectEventSaid: attempt.providerProof.effect.d,
    verifierReceiptSaids: [...classification.verifierReceiptSaids],
  };
}

type CalibrationAssessment =
  | {
      readonly kind: 'Accepted';
      readonly entry: PreparedCompatibilityCalibrationEntry;
      readonly disposition: RunCalibrationDisposition;
    }
  | Exclude<PreparedCompatibilityCalibrationAssessment, { readonly kind: 'Accepted' }>;

function entryDisposition(entry: PreparedCompatibilityCalibrationEntry): RunCalibrationDisposition {
  switch (entry.kind) {
    case 'Counted':
      return { kind: 'Confirmed', category: entry.category };
    case 'Excluded':
      return { kind: 'Excluded', reason: entry.reason };
    case 'Rejected':
      return { kind: 'Rejected', reason: entry.reason };
  }
}

function assessAttempt(
  current: PreparedCompatibilityCalibrationRecord,
  attempt: PreparedCompatibilityCalibrationAttempt,
): CalibrationAssessment {
  if (calibrationIsClosed(current)) return { kind: 'CalibrationClosed' };
  if (current.attempts.some(({ runId }) => runId === attempt.runId)) {
    return { kind: 'RunAlreadyRecorded' };
  }
  const entry =
    attempt.kind === 'ExcludedRun'
      ? { kind: 'Excluded' as const, runId: attempt.runId, reason: attempt.reason }
      : classifiedEntry(attempt, current);
  return entry === undefined
    ? { kind: 'EvidenceRejected' }
    : { kind: 'Accepted', entry, disposition: entryDisposition(entry) };
}

function emptyCalibrationRecord(): PreparedCompatibilityCalibrationRecord {
  return { version: 1, binding: { kind: 'AwaitingConfirmedCategory' }, attempts: [] };
}

export class PreparedCompatibilityCalibration
  implements
    PreparedCompatibilityCalibrationConfirmations,
    PreparedCompatibilityCalibrationSettlements
{
  readonly #records: CompatibilityCalibrationRecords;

  constructor(records: CompatibilityCalibrationRecords) {
    this.#records = records;
  }

  async confirm(
    category: PreparedCompatibilityFailureCategory,
  ): Promise<PreparedCompatibilityCalibrationConfirmation> {
    const reading = await this.#records.load();
    if (reading.kind === 'Unavailable') return { kind: 'RecordUnavailable' };
    if (reading.kind === 'Corrupt') return { kind: 'RecordCorrupt' };
    if (reading.kind === 'NotFound') return { kind: 'NotCalibrated' };
    const current = disposition(reading.record);
    if (current.kind !== 'Calibrated') return { kind: 'NotCalibrated' };
    if (!preparedCompatibilityFailureCategoriesMatch(current.category, category)) {
      return { kind: 'CategoryMismatch' };
    }
    return {
      kind: 'Confirmed',
      acceptedCleanRuns: current.acceptedCleanRuns,
      excludedRuns: current.excludedRuns,
    };
  }

  async assess(
    attempt: PreparedCompatibilityCalibrationAttempt,
  ): Promise<PreparedCompatibilityCalibrationAssessment> {
    const reading = await this.#records.load();
    if (reading.kind === 'Unavailable') return { kind: 'RecordUnavailable' };
    if (reading.kind === 'Corrupt') return { kind: 'RecordCorrupt' };
    const current = reading.kind === 'NotFound' ? emptyCalibrationRecord() : reading.record;
    const assessment = assessAttempt(current, attempt);
    return assessment.kind === 'Accepted'
      ? { kind: 'Accepted', disposition: assessment.disposition }
      : assessment;
  }

  async record(
    attempt: PreparedCompatibilityCalibrationAttempt,
  ): Promise<PreparedCompatibilityCalibrationRecording> {
    const reading = await this.#records.load();
    if (reading.kind === 'Unavailable') return { kind: 'RecordUnavailable' };
    if (reading.kind === 'Corrupt') return { kind: 'RecordCorrupt' };
    const current = reading.kind === 'NotFound' ? emptyCalibrationRecord() : reading.record;
    const assessment = assessAttempt(current, attempt);
    if (assessment.kind !== 'Accepted') return assessment;
    const entry = assessment.entry;
    const binding =
      current.binding.kind === 'AwaitingConfirmedCategory' && entry.kind === 'Counted'
        ? { kind: 'Bound' as const, category: entry.category }
        : current.binding;
    const next: PreparedCompatibilityCalibrationRecord = {
      version: 1,
      binding,
      attempts: [...current.attempts, entry],
    };
    const committed = await this.#records.commit(current.attempts.length, next);
    if (committed.kind === 'Conflict') return { kind: 'ConcurrentUpdate' };
    if (committed.kind === 'Unavailable') return { kind: 'RecordUnavailable' };
    return { kind: 'Recorded', disposition: disposition(next) };
  }
}
