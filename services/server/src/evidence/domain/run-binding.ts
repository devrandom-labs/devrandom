import { isDeepStrictEqual } from 'node:util';

import type { Run, RunLifecycle, SubmissionVerification } from '@devrandom/domain';
import type {
  AppendEvidenceBatchBody,
  EvidenceEvent,
  VerifiedCheckpoint,
} from '@devrandom/protocol';

export function evidenceEventBelongsToRun(event: EvidenceEvent, run: Run): boolean {
  const recordedAt = Date.parse(event.recordedAt);
  const acquiredAt = run.lease.kind === 'Held' ? Date.parse(run.lease.acquiredAt) : Number.NaN;
  const expiresAt = run.lease.kind === 'Held' ? Date.parse(run.lease.expiresAt) : Number.NaN;
  return (
    event.taskId === run.binding.taskId &&
    event.taskRevisionSaid === run.binding.taskRevisionSaid &&
    event.runId === run.binding.runId &&
    event.harnessRevisionSaid ===
      (run.currentExecution?.harnessRevisionSaid ?? run.binding.initialHarnessRevisionSaid) &&
    event.personalAgentAid === run.binding.personalAgentAid &&
    event.taskMandateSaid === run.binding.taskMandateSaid &&
    run.lease.kind === 'Held' &&
    event.incarnationId === run.lease.incarnationId &&
    Number.isFinite(recordedAt) &&
    Number.isFinite(acquiredAt) &&
    Number.isFinite(expiresAt) &&
    recordedAt >= acquiredAt &&
    recordedAt < expiresAt
  );
}

export function evidenceCheckpointBelongsToRun(checkpoint: VerifiedCheckpoint, run: Run): boolean {
  const repository = checkpoint.repository;
  return (
    checkpoint.taskId === run.binding.taskId &&
    checkpoint.taskRevisionSaid === run.binding.taskRevisionSaid &&
    checkpoint.runId === run.binding.runId &&
    run.lease.kind === 'Held' &&
    checkpoint.incarnationId === run.lease.incarnationId &&
    checkpoint.harnessRevisionSaid ===
      (run.currentExecution?.harnessRevisionSaid ?? run.binding.initialHarnessRevisionSaid) &&
    checkpoint.harnessLineageId === run.binding.harnessLineageId &&
    checkpoint.personalAgentAid === run.binding.personalAgentAid &&
    checkpoint.governorAid === run.binding.governorAid &&
    checkpoint.taskMandateSaid === run.binding.taskMandateSaid &&
    checkpoint.promotionMandateSaid === run.binding.promotionMandateSaid &&
    isDeepStrictEqual(checkpoint.purpose, run.binding.purpose) &&
    repository.objectFormat === run.binding.repository.objectFormat &&
    repository.baseCommit === run.binding.repository.commit &&
    repository.baseTree === run.binding.repository.tree
  );
}

export function bodyCheckpointBelongsToRun(body: AppendEvidenceBatchBody, run: Run): boolean {
  return body.checkpoint === undefined || evidenceCheckpointBelongsToRun(body.checkpoint, run);
}

/** A v2 repository omission is justified only by the final atomic withholding pair. */
export function privacyCheckpointMarkersMatch(
  checkpoint: VerifiedCheckpoint,
  throughCheckpoint: readonly EvidenceEvent[],
): boolean {
  if (checkpoint.version === 1) return true;
  const withheld = throughCheckpoint.at(-2);
  const violation = throughCheckpoint.at(-1);
  const measurement = checkpoint.repository.repositoryMeasurement;
  return (
    withheld !== undefined &&
    violation !== undefined &&
    withheld.sequence === checkpoint.evidence.finalSequence - 1 &&
    violation.sequence === checkpoint.evidence.finalSequence &&
    withheld.d === measurement.dataWithheldEventSaid &&
    violation.d === measurement.securityViolationEventSaid &&
    violation.d === checkpoint.evidence.chainHeadSaid &&
    violation.predecessor.kind === 'Previous' &&
    violation.predecessor.eventSaid === withheld.d &&
    withheld.runId === checkpoint.runId &&
    violation.runId === checkpoint.runId &&
    withheld.incarnationId === checkpoint.incarnationId &&
    violation.incarnationId === checkpoint.incarnationId &&
    withheld.occurredAt === violation.occurredAt &&
    withheld.producer.kind === 'EvidenceRecorder' &&
    violation.producer.kind === 'EvidenceRecorder' &&
    withheld.event.kind === 'DataWithheld' &&
    isDeepStrictEqual(withheld.event.disposition, measurement.disclosure) &&
    violation.event.kind === 'SecurityViolation' &&
    violation.event.violation === 'SecretDetected'
  );
}

export function checkpointRunDisposition(checkpoint: VerifiedCheckpoint): {
  readonly lifecycle: RunLifecycle;
  readonly submissionVerification: SubmissionVerification;
} {
  const state = checkpoint.runState;
  const submissionVerification: SubmissionVerification = { kind: state.verification.kind };
  if (state.kind === 'Active') {
    const lifecycle: RunLifecycle =
      state.phase.kind === 'Blocked'
        ? {
            kind: 'Active',
            phase: {
              kind: 'Blocked',
              reason: state.phase.reason,
              checkpointSaid: checkpoint.d,
            },
          }
        : { kind: 'Active', phase: { kind: state.phase.kind } };
    return { lifecycle, submissionVerification };
  }
  let lifecycle: RunLifecycle;
  switch (state.outcome.kind) {
    case 'Submitted':
      lifecycle = {
        kind: 'Ended',
        outcome: { kind: 'Submitted', checkpointSaid: checkpoint.d },
      };
      break;
    case 'Failed':
      lifecycle = {
        kind: 'Ended',
        outcome: {
          kind: 'Failed',
          failure: state.outcome.failure,
          checkpointSaid: checkpoint.d,
        },
      };
      break;
    case 'Cancelled':
      lifecycle = {
        kind: 'Ended',
        outcome: { kind: 'Cancelled', checkpointSaid: checkpoint.d },
      };
      break;
    case 'AuthorityRevoked':
      lifecycle = {
        kind: 'Ended',
        outcome: {
          kind: 'AuthorityRevoked',
          mandateSaid: state.outcome.mandateSaid,
          checkpointSaid: checkpoint.d,
        },
      };
      break;
    case 'CalibrationConfirmed':
      lifecycle = {
        kind: 'Ended',
        outcome: {
          kind: 'CalibrationConfirmed',
          checkpointSaid: checkpoint.d,
          category: state.outcome.category,
        },
      };
      break;
    case 'CalibrationExcluded':
      lifecycle = {
        kind: 'Ended',
        outcome: {
          kind: 'CalibrationExcluded',
          checkpointSaid: checkpoint.d,
          reason: state.outcome.reason,
        },
      };
      break;
    case 'CalibrationRejected':
      lifecycle = {
        kind: 'Ended',
        outcome: {
          kind: 'CalibrationRejected',
          checkpointSaid: checkpoint.d,
          reason: state.outcome.reason,
        },
      };
      break;
  }
  return { lifecycle, submissionVerification };
}
