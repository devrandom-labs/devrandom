import type { Task } from '../task/task.js';
import {
  preparedCompatibilityFailureCategoriesMatch,
  runStateIsCoherent,
  type PreparedCompatibilityFailureCategory,
  type Run,
  type RunBinding,
} from './run.js';

/** These references must come from exact-read, acknowledged seal and artifact verification. */
export interface AcknowledgedRunSeal {
  readonly kind: 'Acknowledged';
  readonly runId: string;
  readonly checkpointSaid: string;
  readonly evidenceHeadSaid: string;
  readonly sealSaid: string;
  readonly artifactSaids: readonly string[];
}

export interface SealedRunObservation {
  readonly run: Pick<Run, 'binding' | 'lifecycle' | 'submissionVerification'>;
  readonly incarnationId: string;
  readonly worktreeId: string;
  readonly executionProfileSaid: string;
  readonly seal: AcknowledgedRunSeal;
}

/** Produced by exact-read verification of the retained FailureObserved event and its public receipts. */
export interface RetainedFailureObservation {
  readonly runId: string;
  readonly eventSaid: string;
  readonly category: PreparedCompatibilityFailureCategory;
}

export type FailureQualification =
  | {
      readonly kind: 'Qualified';
      readonly campaignId: string;
      readonly retainedRunId: string;
      readonly failure: PreparedCompatibilityFailureCategory;
    }
  | {
      readonly kind: 'Rejected';
      readonly reason:
        | 'TaskNotOpen'
        | 'CampaignIncomplete'
        | 'CampaignMismatch'
        | 'ExecutionBindingMismatch'
        | 'IdentityReused'
        | 'SealUnavailable'
        | 'CalibrationRejected'
        | 'FailureCategoryMismatch'
        | 'InsufficientConfirmations'
        | 'RetainedRunUnavailable'
        | 'RetainedFailureMismatch';
    };

function rejected(
  reason: Extract<FailureQualification, { kind: 'Rejected' }>['reason'],
): FailureQualification {
  return { kind: 'Rejected', reason };
}

function sameRepository(left: RunBinding['repository'], right: RunBinding['repository']): boolean {
  return (
    left.objectFormat === right.objectFormat &&
    left.commit === right.commit &&
    left.tree === right.tree
  );
}

function sameExecutionBinding(left: SealedRunObservation, right: SealedRunObservation): boolean {
  const a = left.run.binding;
  const b = right.run.binding;
  return (
    a.ownerAid === b.ownerAid &&
    a.taskId === b.taskId &&
    a.taskRevisionSaid === b.taskRevisionSaid &&
    a.harnessLineageId === b.harnessLineageId &&
    a.personalAgentAid === b.personalAgentAid &&
    a.governorAid === b.governorAid &&
    a.taskMandateSaid === b.taskMandateSaid &&
    a.promotionMandateSaid === b.promotionMandateSaid &&
    a.initialHarnessRevisionSaid === b.initialHarnessRevisionSaid &&
    sameRepository(a.repository, b.repository) &&
    left.executionProfileSaid === right.executionProfileSaid
  );
}

function sealMatches(observation: SealedRunObservation, checkpointSaid: string): boolean {
  const { seal } = observation;
  return (
    seal.runId === observation.run.binding.runId &&
    seal.checkpointSaid === checkpointSaid &&
    seal.evidenceHeadSaid.length > 0 &&
    seal.sealSaid.length > 0 &&
    seal.artifactSaids.length > 0 &&
    seal.artifactSaids.every((said) => said.length > 0)
  );
}

/** E3 entry law over verified existing Run and Task states; no new campaign state is created. */
export function assessFailureQualification(input: {
  readonly task: Pick<Task, 'taskId' | 'ownerAid' | 'harnessLineageId' | 'revision' | 'lifecycle'>;
  readonly calibrations: readonly SealedRunObservation[];
  readonly retained: SealedRunObservation;
  readonly retainedFailure: RetainedFailureObservation;
}): FailureQualification {
  if (input.task.lifecycle.kind !== 'Open') return rejected('TaskNotOpen');
  if (input.calibrations.length !== 5) return rejected('CampaignIncomplete');
  const first = input.calibrations[0];
  if (first === undefined) return rejected('CampaignIncomplete');
  const purpose = first.run.binding.purpose;
  if (purpose.kind !== 'PreparedCompatibilityCalibration' || purpose.campaignId.length === 0)
    return rejected('CampaignMismatch');
  const all = [...input.calibrations, input.retained];
  if (
    all.some(
      (observation) =>
        observation.run.binding.taskId !== input.task.taskId ||
        observation.run.binding.taskRevisionSaid !== input.task.revision.said ||
        observation.run.binding.ownerAid !== input.task.ownerAid ||
        observation.run.binding.harnessLineageId !== input.task.harnessLineageId ||
        observation.executionProfileSaid.length === 0 ||
        !sameExecutionBinding(first, observation),
    )
  )
    return rejected('ExecutionBindingMismatch');
  if (
    new Set(all.map(({ run }) => run.binding.runId)).size !== 6 ||
    new Set(all.map(({ incarnationId }) => incarnationId)).size !== 6 ||
    new Set(all.map(({ worktreeId }) => worktreeId)).size !== 6 ||
    all.some(
      ({ run, incarnationId, worktreeId }) =>
        run.binding.runId.length === 0 || incarnationId.length === 0 || worktreeId.length === 0,
    )
  )
    return rejected('IdentityReused');
  let failure: PreparedCompatibilityFailureCategory | undefined;
  let confirmations = 0;
  let exclusions = 0;
  for (let index = 0; index < 5; index += 1) {
    const observation = input.calibrations[index];
    if (observation === undefined) return rejected('CampaignIncomplete');
    const runPurpose = observation.run.binding.purpose;
    if (
      runPurpose.kind !== 'PreparedCompatibilityCalibration' ||
      runPurpose.campaignId !== purpose.campaignId ||
      runPurpose.ordinal !== index + 1
    )
      return rejected('CampaignMismatch');
    const { lifecycle, submissionVerification } = observation.run;
    if (!runStateIsCoherent({ lifecycle, submissionVerification }) || lifecycle.kind !== 'Ended')
      return rejected('CalibrationRejected');
    const outcome = lifecycle.outcome;
    if (!sealMatches(observation, outcome.checkpointSaid)) return rejected('SealUnavailable');
    if (outcome.kind === 'CalibrationExcluded') {
      exclusions += 1;
      continue;
    }
    if (outcome.kind !== 'CalibrationConfirmed') return rejected('CalibrationRejected');
    if (
      outcome.category.taskId !== input.task.taskId ||
      outcome.category.taskRevisionSaid !== input.task.revision.said ||
      outcome.category.harnessRevisionSaid !== observation.run.binding.initialHarnessRevisionSaid
    )
      return rejected('FailureCategoryMismatch');
    if (
      failure !== undefined &&
      !preparedCompatibilityFailureCategoriesMatch(failure, outcome.category)
    )
      return rejected('FailureCategoryMismatch');
    failure = outcome.category;
    confirmations += 1;
  }
  if (confirmations < 4 || exclusions > 1 || failure === undefined)
    return rejected('InsufficientConfirmations');
  const retained = input.retained.run;
  if (
    retained.binding.purpose.kind !== 'Retained' ||
    !runStateIsCoherent(retained) ||
    retained.lifecycle.kind !== 'Active' ||
    retained.lifecycle.phase.kind !== 'Blocked' ||
    retained.lifecycle.phase.reason !== 'HarnessCompatibilityFailure' ||
    retained.submissionVerification.kind === 'Accepted'
  )
    return rejected('RetainedRunUnavailable');
  if (!sealMatches(input.retained, retained.lifecycle.phase.checkpointSaid))
    return rejected('SealUnavailable');
  if (
    input.retainedFailure.runId !== retained.binding.runId ||
    input.retainedFailure.eventSaid.length === 0 ||
    !preparedCompatibilityFailureCategoriesMatch(failure, input.retainedFailure.category)
  )
    return rejected('RetainedFailureMismatch');
  return {
    kind: 'Qualified',
    campaignId: purpose.campaignId,
    retainedRunId: retained.binding.runId,
    failure,
  };
}
