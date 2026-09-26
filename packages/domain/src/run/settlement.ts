import { taskBudgetNames, type TaskBudgets } from '../task/authority.js';
import {
  preparedCompatibilityFailureCategoriesMatch,
  runPurposeAllowsLifecycle,
  runStateIsCoherent,
  type Run,
  type RunBlockedReason,
  type RunCalibrationDisposition,
  type RunEndedOutcome,
  type RunLifecycle,
  type SubmissionVerification,
} from './run.js';

interface RunCheckpointReference {
  readonly checkpointSaid: string;
}

export interface RunBlock extends RunCheckpointReference {
  readonly reason: RunBlockedReason;
}

export interface RunFailure extends RunCheckpointReference {
  readonly failure: Extract<RunEndedOutcome, { readonly kind: 'Failed' }>['failure'];
}

export interface RunAuthorityRevocation extends RunCheckpointReference {
  readonly mandateSaid: string;
}

export type RunBlocking =
  | { readonly kind: 'Blocked'; readonly run: Run }
  | { readonly kind: 'RunNotActive' }
  | { readonly kind: 'ApprovalRequiredRequiresRunning' }
  | { readonly kind: 'CompatibilityFailureRequiresRunning' };

export type RunFailing =
  { readonly kind: 'Failed'; readonly run: Run } | { readonly kind: 'RunNotActive' };

export type RunAuthorityEnding =
  | { readonly kind: 'AuthorityRevoked'; readonly run: Run }
  | { readonly kind: 'RunNotActive' }
  | { readonly kind: 'MandateBindingConflict' };

export interface RunCalibrationRecord extends RunCheckpointReference {
  readonly disposition: RunCalibrationDisposition;
}

export type PlannedRunCalibrationOutcome =
  | {
      readonly kind: 'CalibrationConfirmed';
      readonly category: Extract<
        RunCalibrationDisposition,
        { readonly kind: 'Confirmed' }
      >['category'];
    }
  | {
      readonly kind: 'CalibrationExcluded';
      readonly reason: Extract<RunCalibrationDisposition, { readonly kind: 'Excluded' }>['reason'];
    }
  | {
      readonly kind: 'CalibrationRejected';
      readonly reason: Extract<RunCalibrationDisposition, { readonly kind: 'Rejected' }>['reason'];
    };

export type PlannedRunCalibrationState =
  | {
      readonly outcome: Extract<
        PlannedRunCalibrationOutcome,
        { readonly kind: 'CalibrationConfirmed' }
      >;
      readonly submissionVerification: { readonly kind: 'Rejected' };
    }
  | {
      readonly outcome: Extract<
        PlannedRunCalibrationOutcome,
        { readonly kind: 'CalibrationExcluded' }
      >;
      readonly submissionVerification: { readonly kind: 'NotSubmitted' };
    }
  | {
      readonly outcome: { readonly kind: 'CalibrationRejected'; readonly reason: 'H1Passed' };
      readonly submissionVerification: { readonly kind: 'Accepted' };
    }
  | {
      readonly outcome: {
        readonly kind: 'CalibrationRejected';
        readonly reason: Exclude<
          Extract<RunCalibrationDisposition, { readonly kind: 'Rejected' }>['reason'],
          'H1Passed'
        >;
      };
      readonly submissionVerification: { readonly kind: 'Rejected' };
    };

export type RunCalibrationRejection =
  | { readonly kind: 'CalibrationPurposeRequired' }
  | { readonly kind: 'RunNotRunning' }
  | { readonly kind: 'CalibrationCategoryBindingConflict' };

export type RunCalibrationPlanning =
  | { readonly kind: 'Planned'; readonly state: PlannedRunCalibrationState }
  | RunCalibrationRejection;

export type RunCalibrationRecording =
  { readonly kind: 'Recorded'; readonly run: Run } | RunCalibrationRejection;

export type RunSubmissionBeginning =
  | { readonly kind: 'Pending'; readonly run: Run }
  | { readonly kind: 'RunNotRunning' }
  | { readonly kind: 'SubmissionAlreadyPending' }
  | { readonly kind: 'SubmissionAlreadyAccepted' };

export type RunSubmissionRejection =
  | { readonly kind: 'Rejected'; readonly run: Run }
  | { readonly kind: 'RunNotRunning' }
  | { readonly kind: 'SubmissionNotPending' };

export type RunSubmissionAcceptance =
  | { readonly kind: 'Accepted'; readonly run: Run }
  | { readonly kind: 'RunNotRunning' }
  | { readonly kind: 'SubmissionNotPending' };

export interface AcceptedRunStartedProvenance {
  readonly eventSaid: string;
  readonly fromRunVersion: number;
  readonly taskId: string;
  readonly taskRevisionSaid: string;
  readonly runId: string;
  readonly incarnationId: string;
  readonly harnessRevisionSaid: string;
  readonly personalAgentAid: string;
  readonly taskMandateSaid: string;
}

export interface SealedRunCheckpoint {
  readonly checkpointSaid: string;
  readonly taskId: string;
  readonly taskRevisionSaid: string;
  readonly runId: string;
  readonly incarnationId: string;
  readonly harnessRevisionSaid: string;
  readonly lifecycle: RunLifecycle;
  readonly submissionVerification: SubmissionVerification;
}

export interface SealedRunCheckpointInput {
  readonly expectedRunVersion: number;
  readonly consumedBudget: TaskBudgets;
  readonly checkpoint: SealedRunCheckpoint;
  readonly runStarted: AcceptedRunStartedProvenance;
}

export type RunBudgetSettlementInvalidity =
  | { readonly kind: 'RunBudgetInvalid'; readonly budget: (typeof taskBudgetNames)[number] }
  | { readonly kind: 'RunBudgetRegression'; readonly budget: (typeof taskBudgetNames)[number] }
  | {
      readonly kind: 'RunBudgetCeilingExceeded';
      readonly budget: (typeof taskBudgetNames)[number];
    };

export type SealedRunCheckpointSettlement =
  | { readonly kind: 'Applied'; readonly run: Run }
  | { readonly kind: 'Equivalent'; readonly run: Run }
  | { readonly kind: 'VersionConflict'; readonly currentVersion: number }
  | { readonly kind: 'RunNotPreparing' }
  | { readonly kind: 'LeaseNotHeld' }
  | { readonly kind: 'IncarnationConflict' }
  | { readonly kind: 'CheckpointBindingConflict' }
  | { readonly kind: 'RunStartedProvenanceConflict' }
  | { readonly kind: 'CheckpointDispositionInvalid' }
  | RunBudgetSettlementInvalidity
  | { readonly kind: 'RunSettlementConflict' };

function transition(
  run: Run,
  lifecycle: RunLifecycle,
  submissionVerification: SubmissionVerification,
): Run {
  return {
    ...run,
    version: run.version + 1,
    lifecycle,
    submissionVerification,
  };
}

function runIsRunning(run: Run): boolean {
  return run.lifecycle.kind === 'Active' && run.lifecycle.phase.kind === 'Running';
}

function checkpointMatchesRun(run: Run, checkpoint: SealedRunCheckpoint): boolean {
  return (
    checkpoint.taskId === run.binding.taskId &&
    checkpoint.taskRevisionSaid === run.binding.taskRevisionSaid &&
    checkpoint.runId === run.binding.runId &&
    checkpoint.harnessRevisionSaid ===
      (run.currentExecution?.harnessRevisionSaid ?? run.binding.initialHarnessRevisionSaid)
  );
}

function runStartedMatches(run: Run, provenance: AcceptedRunStartedProvenance): boolean {
  return (
    Number.isSafeInteger(provenance.fromRunVersion) &&
    provenance.fromRunVersion > 0 &&
    provenance.fromRunVersion <= run.version &&
    provenance.taskId === run.binding.taskId &&
    provenance.taskRevisionSaid === run.binding.taskRevisionSaid &&
    provenance.runId === run.binding.runId &&
    provenance.harnessRevisionSaid ===
      (run.currentExecution?.harnessRevisionSaid ?? run.binding.initialHarnessRevisionSaid) &&
    provenance.personalAgentAid === run.binding.personalAgentAid &&
    provenance.taskMandateSaid === run.binding.taskMandateSaid
  );
}

function checkpointDispositionIsValid(run: Run, checkpoint: SealedRunCheckpoint): boolean {
  if (
    !runPurposeAllowsLifecycle(run.binding.purpose, checkpoint.lifecycle) ||
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
  const outcome = checkpoint.lifecycle.outcome;
  if (outcome.checkpointSaid !== checkpoint.checkpointSaid) {
    return false;
  }
  return outcome.kind !== 'AuthorityRevoked' || outcome.mandateSaid === run.binding.taskMandateSaid;
}

function lifecycleMatches(left: RunLifecycle, right: RunLifecycle): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === 'Active' && right.kind === 'Active') {
    if (left.phase.kind !== right.phase.kind) {
      return false;
    }
    return left.phase.kind === 'Blocked' && right.phase.kind === 'Blocked'
      ? left.phase.reason === right.phase.reason &&
          left.phase.checkpointSaid === right.phase.checkpointSaid
      : true;
  }
  if (left.kind !== 'Ended' || right.kind !== 'Ended') {
    return false;
  }
  const leftOutcome = left.outcome;
  const rightOutcome = right.outcome;
  if (leftOutcome.kind !== rightOutcome.kind) {
    return false;
  }
  if (leftOutcome.checkpointSaid !== rightOutcome.checkpointSaid) {
    return false;
  }
  if (leftOutcome.kind === 'Failed' && rightOutcome.kind === 'Failed') {
    return leftOutcome.failure === rightOutcome.failure;
  }
  if (leftOutcome.kind === 'AuthorityRevoked' && rightOutcome.kind === 'AuthorityRevoked') {
    return leftOutcome.mandateSaid === rightOutcome.mandateSaid;
  }
  if (leftOutcome.kind === 'CalibrationExcluded' && rightOutcome.kind === 'CalibrationExcluded') {
    return leftOutcome.reason === rightOutcome.reason;
  }
  if (leftOutcome.kind === 'CalibrationRejected' && rightOutcome.kind === 'CalibrationRejected') {
    return leftOutcome.reason === rightOutcome.reason;
  }
  if (leftOutcome.kind === 'CalibrationConfirmed' && rightOutcome.kind === 'CalibrationConfirmed') {
    return preparedCompatibilityFailureCategoriesMatch(leftOutcome.category, rightOutcome.category);
  }
  return true;
}

function verificationMatches(left: SubmissionVerification, right: SubmissionVerification): boolean {
  return left.kind === right.kind;
}

export function runLifecycleRetainsBudgetExcess(
  lifecycle:
    | {
        readonly kind: 'Active';
        readonly phase:
          | { readonly kind: 'Preparing' | 'Running' }
          | { readonly kind: 'Blocked'; readonly reason: RunBlockedReason };
      }
    | {
        readonly kind: 'Ended';
        readonly outcome:
          | { readonly kind: Exclude<RunEndedOutcome['kind'], 'CalibrationExcluded'> }
          | Pick<
              Extract<RunEndedOutcome, { readonly kind: 'CalibrationExcluded' }>,
              'kind' | 'reason'
            >;
      },
): boolean {
  if (lifecycle.kind === 'Active') {
    return (
      lifecycle.phase.kind === 'Blocked' && lifecycle.phase.reason !== 'HarnessCompatibilityFailure'
    );
  }
  switch (lifecycle.outcome.kind) {
    case 'Failed':
    case 'Cancelled':
    case 'AuthorityRevoked':
      return true;
    case 'CalibrationExcluded':
      return lifecycle.outcome.reason === 'BudgetExhausted';
    case 'Submitted':
    case 'CalibrationConfirmed':
    case 'CalibrationRejected':
      return false;
  }
}

function budgetInvalidity(
  run: Run,
  consumed: TaskBudgets,
  lifecycle: RunLifecycle,
): RunBudgetSettlementInvalidity | undefined {
  for (const budget of taskBudgetNames) {
    const amount = consumed[budget];
    if (!Number.isSafeInteger(amount) || amount < 0) {
      return { kind: 'RunBudgetInvalid', budget };
    }
    if (amount < run.consumedBudget[budget]) {
      return { kind: 'RunBudgetRegression', budget };
    }
    if (amount > run.binding.budget[budget] && !runLifecycleRetainsBudgetExcess(lifecycle)) {
      return { kind: 'RunBudgetCeilingExceeded', budget };
    }
  }
  return undefined;
}

export function applySealedRunCheckpoint(
  run: Run,
  input: SealedRunCheckpointInput,
): SealedRunCheckpointSettlement {
  if (!checkpointMatchesRun(run, input.checkpoint)) {
    return { kind: 'CheckpointBindingConflict' };
  }
  if (run.lease.kind !== 'Held') {
    return { kind: 'LeaseNotHeld' };
  }
  if (
    input.checkpoint.incarnationId !== run.lease.incarnationId ||
    input.runStarted.incarnationId !== run.lease.incarnationId
  ) {
    return { kind: 'IncarnationConflict' };
  }
  if (!runStartedMatches(run, input.runStarted)) {
    return { kind: 'RunStartedProvenanceConflict' };
  }
  if (!checkpointDispositionIsValid(run, input.checkpoint)) {
    return { kind: 'CheckpointDispositionInvalid' };
  }
  const invalidBudget = budgetInvalidity(run, input.consumedBudget, input.checkpoint.lifecycle);
  if (invalidBudget !== undefined) {
    return invalidBudget;
  }
  const exactDisposition =
    lifecycleMatches(run.lifecycle, input.checkpoint.lifecycle) &&
    verificationMatches(run.submissionVerification, input.checkpoint.submissionVerification) &&
    taskBudgetNames.every((budget) => run.consumedBudget[budget] === input.consumedBudget[budget]);
  if (
    exactDisposition &&
    Number.isSafeInteger(input.expectedRunVersion) &&
    input.expectedRunVersion >= 0 &&
    input.expectedRunVersion + 1 === run.version
  ) {
    return { kind: 'Equivalent', run };
  }
  if (run.lifecycle.kind !== 'Active' || run.lifecycle.phase.kind !== 'Preparing') {
    return run.lifecycle.kind === 'Active' && run.lifecycle.phase.kind === 'Running'
      ? { kind: 'RunNotPreparing' }
      : { kind: 'RunSettlementConflict' };
  }
  if (
    !Number.isSafeInteger(input.expectedRunVersion) ||
    input.expectedRunVersion < 0 ||
    input.expectedRunVersion !== run.version
  ) {
    return { kind: 'VersionConflict', currentVersion: run.version };
  }
  return {
    kind: 'Applied',
    run: {
      ...run,
      version: run.version + 1,
      lifecycle: input.checkpoint.lifecycle,
      submissionVerification: input.checkpoint.submissionVerification,
      consumedBudget: { ...input.consumedBudget },
    },
  };
}

export function blockRun(run: Run, input: RunBlock): RunBlocking {
  if (run.lifecycle.kind !== 'Active') {
    return { kind: 'RunNotActive' };
  }
  if (input.reason === 'ApprovalRequired' && run.lifecycle.phase.kind !== 'Running') {
    return { kind: 'ApprovalRequiredRequiresRunning' };
  }
  if (input.reason === 'HarnessCompatibilityFailure' && run.lifecycle.phase.kind !== 'Running') {
    return { kind: 'CompatibilityFailureRequiresRunning' };
  }
  return {
    kind: 'Blocked',
    run: transition(
      run,
      {
        kind: 'Active',
        phase: {
          kind: 'Blocked',
          reason: input.reason,
          checkpointSaid: input.checkpointSaid,
        },
      },
      run.submissionVerification,
    ),
  };
}

/** An unsubmitted Run can end without acquiring failure or calibration meaning. */
export function planRunCancellation(
  run: Run,
):
  | {
      readonly kind: 'Planned';
      readonly state: {
        readonly outcome: { readonly kind: 'Cancelled' };
        readonly submissionVerification: { readonly kind: 'NotSubmitted' };
      };
    }
  | { readonly kind: 'RunNotActive' | 'SubmissionAlreadyAccepted' | 'SubmissionAlreadyStarted' } {
  if (run.lifecycle.kind !== 'Active') return { kind: 'RunNotActive' };
  if (run.submissionVerification.kind === 'Accepted') return { kind: 'SubmissionAlreadyAccepted' };
  if (run.submissionVerification.kind !== 'NotSubmitted')
    return { kind: 'SubmissionAlreadyStarted' };
  return {
    kind: 'Planned',
    state: { outcome: { kind: 'Cancelled' }, submissionVerification: { kind: 'NotSubmitted' } },
  };
}

/** Explicit owner cancellation is terminal bookkeeping, never a failure qualification. */
export function cancelRun(
  run: Run,
  input: RunCheckpointReference,
):
  | { readonly kind: 'Cancelled'; readonly run: Run }
  | { readonly kind: 'RunNotActive' | 'SubmissionAlreadyAccepted' | 'SubmissionAlreadyStarted' } {
  const plan = planRunCancellation(run);
  if (plan.kind !== 'Planned') return plan;
  return {
    kind: 'Cancelled',
    run: transition(
      run,
      { kind: 'Ended', outcome: { ...plan.state.outcome, checkpointSaid: input.checkpointSaid } },
      plan.state.submissionVerification,
    ),
  };
}

export function failRun(run: Run, input: RunFailure): RunFailing {
  if (run.lifecycle.kind !== 'Active') {
    return { kind: 'RunNotActive' };
  }
  return {
    kind: 'Failed',
    run: transition(
      run,
      {
        kind: 'Ended',
        outcome: {
          kind: 'Failed',
          failure: input.failure,
          checkpointSaid: input.checkpointSaid,
        },
      },
      run.submissionVerification,
    ),
  };
}

export function revokeRunAuthority(run: Run, input: RunAuthorityRevocation): RunAuthorityEnding {
  if (run.lifecycle.kind !== 'Active') {
    return { kind: 'RunNotActive' };
  }
  if (input.mandateSaid !== run.binding.taskMandateSaid) {
    return { kind: 'MandateBindingConflict' };
  }
  return {
    kind: 'AuthorityRevoked',
    run: transition(
      run,
      {
        kind: 'Ended',
        outcome: {
          kind: 'AuthorityRevoked',
          mandateSaid: input.mandateSaid,
          checkpointSaid: input.checkpointSaid,
        },
      },
      run.submissionVerification,
    ),
  };
}

export function planRunCalibration(
  run: Run,
  disposition: RunCalibrationDisposition,
): RunCalibrationPlanning {
  if (run.binding.purpose.kind !== 'PreparedCompatibilityCalibration') {
    return { kind: 'CalibrationPurposeRequired' };
  }
  if (!runIsRunning(run)) {
    return { kind: 'RunNotRunning' };
  }
  if (
    disposition.kind === 'Confirmed' &&
    (disposition.category.taskId !== run.binding.taskId ||
      disposition.category.taskRevisionSaid !== run.binding.taskRevisionSaid ||
      disposition.category.harnessRevisionSaid !== run.binding.initialHarnessRevisionSaid)
  ) {
    return { kind: 'CalibrationCategoryBindingConflict' };
  }
  switch (disposition.kind) {
    case 'Confirmed':
      return {
        kind: 'Planned',
        state: {
          outcome: { kind: 'CalibrationConfirmed', category: { ...disposition.category } },
          submissionVerification: { kind: 'Rejected' },
        },
      };
    case 'Excluded':
      return {
        kind: 'Planned',
        state: {
          outcome: { kind: 'CalibrationExcluded', reason: disposition.reason },
          submissionVerification: { kind: 'NotSubmitted' },
        },
      };
    case 'Rejected':
      return disposition.reason === 'H1Passed'
        ? {
            kind: 'Planned',
            state: {
              outcome: { kind: 'CalibrationRejected', reason: 'H1Passed' },
              submissionVerification: { kind: 'Accepted' },
            },
          }
        : {
            kind: 'Planned',
            state: {
              outcome: { kind: 'CalibrationRejected', reason: disposition.reason },
              submissionVerification: { kind: 'Rejected' },
            },
          };
  }
}

export function recordRunCalibration(
  run: Run,
  input: RunCalibrationRecord,
): RunCalibrationRecording {
  const planned = planRunCalibration(run, input.disposition);
  if (planned.kind !== 'Planned') {
    return planned;
  }
  const state = planned.state;
  switch (state.outcome.kind) {
    case 'CalibrationConfirmed':
      return {
        kind: 'Recorded',
        run: transition(
          run,
          {
            kind: 'Ended',
            outcome: {
              ...state.outcome,
              checkpointSaid: input.checkpointSaid,
              category: { ...state.outcome.category },
            },
          },
          state.submissionVerification,
        ),
      };
    case 'CalibrationExcluded':
    case 'CalibrationRejected':
      return {
        kind: 'Recorded',
        run: transition(
          run,
          {
            kind: 'Ended',
            outcome: { ...state.outcome, checkpointSaid: input.checkpointSaid },
          },
          state.submissionVerification,
        ),
      };
  }
}

export function beginRunSubmission(run: Run): RunSubmissionBeginning {
  if (!runIsRunning(run)) {
    return { kind: 'RunNotRunning' };
  }
  if (run.submissionVerification.kind === 'Pending') {
    return { kind: 'SubmissionAlreadyPending' };
  }
  if (run.submissionVerification.kind === 'Accepted') {
    return { kind: 'SubmissionAlreadyAccepted' };
  }
  return {
    kind: 'Pending',
    run: transition(run, run.lifecycle, { kind: 'Pending' }),
  };
}

export function rejectRunSubmission(run: Run): RunSubmissionRejection {
  if (!runIsRunning(run)) {
    return { kind: 'RunNotRunning' };
  }
  if (run.submissionVerification.kind !== 'Pending') {
    return { kind: 'SubmissionNotPending' };
  }
  return {
    kind: 'Rejected',
    run: transition(run, run.lifecycle, { kind: 'Rejected' }),
  };
}

export function acceptRunSubmission(
  run: Run,
  input: RunCheckpointReference,
): RunSubmissionAcceptance {
  if (!runIsRunning(run)) {
    return { kind: 'RunNotRunning' };
  }
  if (run.submissionVerification.kind !== 'Pending') {
    return { kind: 'SubmissionNotPending' };
  }
  return {
    kind: 'Accepted',
    run: transition(
      run,
      {
        kind: 'Ended',
        outcome: { kind: 'Submitted', checkpointSaid: input.checkpointSaid },
      },
      { kind: 'Accepted' },
    ),
  };
}
