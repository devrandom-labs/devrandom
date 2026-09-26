import type { InitialSpecializationAccepted } from '../harness/initial-specialization.js';
import { taskBudgetNames, type TaskBudgets } from '../task/authority.js';

export type PreparedCompatibilityCalibrationOrdinal = 1 | 2 | 3 | 4 | 5;

export type RunPurpose =
  | {
      readonly kind: 'PreparedCompatibilityCalibration';
      readonly campaignId: string;
      readonly ordinal: PreparedCompatibilityCalibrationOrdinal;
    }
  | { readonly kind: 'Retained' };

export interface PreparedCompatibilityFailureCategory {
  readonly version: 1;
  readonly taskId: string;
  readonly taskRevisionSaid: string;
  readonly harnessRevisionSaid: string;
  readonly currentCommandSaid: string;
  readonly tamperCommandSaid: string;
  readonly legacyCommandSaid: string;
  readonly legacyObservedExitCode: 101;
}

export function preparedCompatibilityFailureCategoriesMatch(
  left: PreparedCompatibilityFailureCategory,
  right: PreparedCompatibilityFailureCategory,
): boolean {
  return (
    left.taskId === right.taskId &&
    left.taskRevisionSaid === right.taskRevisionSaid &&
    left.harnessRevisionSaid === right.harnessRevisionSaid &&
    left.currentCommandSaid === right.currentCommandSaid &&
    left.tamperCommandSaid === right.tamperCommandSaid &&
    left.legacyCommandSaid === right.legacyCommandSaid
  );
}

export type CalibrationExclusionReason =
  | 'IdentityUnavailable'
  | 'KERIAUnavailable'
  | 'StorageUnavailable'
  | 'ProviderUnavailable'
  | 'NetworkUnavailable'
  | 'ModelCredentialUnavailable'
  | 'ModelConfigurationRequired'
  | 'ModelUsageUnavailable'
  | 'EffectAborted'
  | 'BudgetExhausted'
  | 'OutboxBackpressure';

export type CalibrationRejectionReason =
  'H1Passed' | 'ReceiptPatternMismatch' | 'FixtureBindingMismatch' | 'CategoryChanged';

export type RunCalibrationDisposition =
  | { readonly kind: 'Confirmed'; readonly category: PreparedCompatibilityFailureCategory }
  | { readonly kind: 'Excluded'; readonly reason: CalibrationExclusionReason }
  | { readonly kind: 'Rejected'; readonly reason: CalibrationRejectionReason };

export type RunRepository =
  | { readonly objectFormat: 'sha1'; readonly commit: string; readonly tree: string }
  | { readonly objectFormat: 'sha256'; readonly commit: string; readonly tree: string };

export interface RunBinding {
  readonly runId: string;
  readonly ownerAid: string;
  readonly taskId: string;
  readonly taskRevisionSaid: string;
  readonly harnessLineageId: string;
  readonly personalAgentAid: string;
  readonly taskMandateSaid: string;
  readonly governorAid: string;
  readonly promotionMandateSaid: string;
  readonly initialHarnessRevisionSaid: string;
  readonly purpose: RunPurpose;
  readonly initialSpecialization: InitialSpecializationAccepted;
  readonly repository: RunRepository;
  readonly commandId: string;
  readonly admissionExchangeSaid: string;
  readonly evidenceStreamId: string;
  readonly budget: TaskBudgets;
  readonly acceptedAt: string;
}

export type RunBlockedReason =
  | 'ApprovalRequired'
  | 'UserInterrupted'
  | 'DependencyUnavailable'
  | 'ContextLimitReached'
  | 'BudgetExhausted'
  | 'TaskMandateExpired'
  | 'OutboxBackpressure'
  | 'SecretDetected'
  | 'LeaseLost'
  | 'ProcessLost'
  | 'HarnessCompatibilityFailure';

export type RunActivePhase =
  | { readonly kind: 'Preparing' }
  | { readonly kind: 'Running' }
  | {
      readonly kind: 'Blocked';
      readonly reason: RunBlockedReason;
      readonly checkpointSaid: string;
    };

export type RunEndedOutcome =
  | { readonly kind: 'Submitted'; readonly checkpointSaid: string }
  | {
      readonly kind: 'Failed';
      readonly failure:
        'EvidenceIntegrityFailure' | 'LocalStateCorruption' | 'ProviderUnrecoverableFailure';
      readonly checkpointSaid: string;
    }
  | { readonly kind: 'Cancelled'; readonly checkpointSaid: string }
  | {
      readonly kind: 'AuthorityRevoked';
      readonly mandateSaid: string;
      readonly checkpointSaid: string;
    }
  | {
      readonly kind: 'CalibrationConfirmed';
      readonly checkpointSaid: string;
      readonly category: PreparedCompatibilityFailureCategory;
    }
  | {
      readonly kind: 'CalibrationExcluded';
      readonly checkpointSaid: string;
      readonly reason: CalibrationExclusionReason;
    }
  | {
      readonly kind: 'CalibrationRejected';
      readonly checkpointSaid: string;
      readonly reason: CalibrationRejectionReason;
    };

export type RunLifecycle =
  | { readonly kind: 'Active'; readonly phase: RunActivePhase }
  | { readonly kind: 'Ended'; readonly outcome: RunEndedOutcome };

export type SubmissionVerification =
  | { readonly kind: 'NotSubmitted' }
  | { readonly kind: 'Pending' }
  | { readonly kind: 'Accepted' }
  | { readonly kind: 'Rejected' };

export type RunLease =
  | { readonly kind: 'Unassigned' }
  | {
      readonly kind: 'Held';
      readonly incarnationId: string;
      readonly acquiredAt: string;
      readonly expiresAt: string;
      readonly lastChange:
        | { readonly kind: 'Acquired'; readonly fromRunVersion: number }
        | { readonly kind: 'Renewed'; readonly fromRunVersion: number };
    };

export interface Run {
  readonly version: number;
  readonly binding: RunBinding;
  readonly lifecycle: RunLifecycle;
  readonly submissionVerification: SubmissionVerification;
  readonly lease: RunLease;
  readonly consumedBudget: TaskBudgets;
}

export function runStateIsCoherent(
  state: Pick<Run, 'lifecycle' | 'submissionVerification'>,
): boolean {
  if (state.lifecycle.kind === 'Ended') {
    if (state.lifecycle.outcome.kind === 'Submitted') {
      return state.submissionVerification.kind === 'Accepted';
    }
    if (state.lifecycle.outcome.kind === 'CalibrationConfirmed') {
      return state.submissionVerification.kind === 'Rejected';
    }
    if (state.lifecycle.outcome.kind === 'CalibrationExcluded') {
      return (
        state.submissionVerification.kind === 'NotSubmitted' ||
        state.submissionVerification.kind === 'Rejected'
      );
    }
    if (
      state.lifecycle.outcome.kind === 'CalibrationRejected' &&
      state.lifecycle.outcome.reason === 'H1Passed'
    ) {
      return state.submissionVerification.kind === 'Accepted';
    }
    if (state.lifecycle.outcome.kind === 'CalibrationRejected') {
      return state.submissionVerification.kind === 'Rejected';
    }
    return state.submissionVerification.kind !== 'Accepted';
  }
  if (state.submissionVerification.kind === 'Accepted') {
    return false;
  }
  if (state.lifecycle.phase.kind === 'Preparing') {
    return state.submissionVerification.kind === 'NotSubmitted';
  }
  if (state.lifecycle.phase.kind === 'Running') {
    return true;
  }
  return true;
}

export function runPurposeAllowsLifecycle(purpose: RunPurpose, lifecycle: RunLifecycle): boolean {
  if (lifecycle.kind === 'Active') {
    return true;
  }
  switch (lifecycle.outcome.kind) {
    case 'CalibrationConfirmed':
    case 'CalibrationExcluded':
    case 'CalibrationRejected':
      return purpose.kind === 'PreparedCompatibilityCalibration';
    case 'Submitted':
    case 'Failed':
    case 'Cancelled':
    case 'AuthorityRevoked':
      return true;
  }
}

export type RunCreation =
  | { readonly kind: 'Created'; readonly run: Run }
  | {
      readonly kind: 'Rejected';
      readonly reason:
        'PrincipalConflict' | 'BudgetInvalid' | 'PurposeInvalid' | 'InitialSpecializationConflict';
    };

export interface RunBudgetIntersection {
  readonly requested: TaskBudgets;
  readonly task: TaskBudgets;
  readonly server: TaskBudgets;
  readonly mandate: TaskBudgets;
}

function minimumBudget(requested: number, task: number, server: number, mandate: number): number {
  return Math.min(requested, task, server, mandate);
}

export function effectiveRunBudget(input: RunBudgetIntersection): TaskBudgets {
  const minimum = (name: (typeof taskBudgetNames)[number]) =>
    minimumBudget(input.requested[name], input.task[name], input.server[name], input.mandate[name]);
  return {
    workAccessAttemptLifetimeSeconds: minimum('workAccessAttemptLifetimeSeconds'),
    workAccessGrantLifetimeSeconds: minimum('workAccessGrantLifetimeSeconds'),
    nonterminalAttemptsPerUserClient: minimum('nonterminalAttemptsPerUserClient'),
    activeGrantsPerUserClient: minimum('activeGrantsPerUserClient'),
    publicAttemptCreationsPerMinutePerLoopbackSource: minimum(
      'publicAttemptCreationsPerMinutePerLoopbackSource',
    ),
    nonterminalAttemptsGlobally: minimum('nonterminalAttemptsGlobally'),
    requestsPerGrant: minimum('requestsPerGrant'),
    tasksPerAdmittedUser: minimum('tasksPerAdmittedUser'),
    runsPerAdmittedUser: minimum('runsPerAdmittedUser'),
    activeRunsPerAdmittedUser: minimum('activeRunsPerAdmittedUser'),
    hostedWorkTasksGlobally: minimum('hostedWorkTasksGlobally'),
    hostedWorkRunsGlobally: minimum('hostedWorkRunsGlobally'),
    activeHostedWorkRunsGlobally: minimum('activeHostedWorkRunsGlobally'),
    ordinaryJsonRequestBodyBytes: minimum('ordinaryJsonRequestBodyBytes'),
    evidenceBatchBodyBytes: minimum('evidenceBatchBodyBytes'),
    artifactRequestBodyBytes: minimum('artifactRequestBodyBytes'),
    evidencePlusArtifactsPerRunBytes: minimum('evidencePlusArtifactsPerRunBytes'),
    acceptedEvidencePlusArtifactsGloballyBytes: minimum(
      'acceptedEvidencePlusArtifactsGloballyBytes',
    ),
    runWallTimeSeconds: minimum('runWallTimeSeconds'),
    providerRequests: minimum('providerRequests'),
    providerInputTokens: minimum('providerInputTokens'),
    providerOutputTokens: minimum('providerOutputTokens'),
    toolProposals: minimum('toolProposals'),
    aggregateChildCommandTimeSeconds: minimum('aggregateChildCommandTimeSeconds'),
    oneChildCommandTimeSeconds: minimum('oneChildCommandTimeSeconds'),
    changedFiles: minimum('changedFiles'),
    changedWorktreeBytes: minimum('changedWorktreeBytes'),
    providerSpendMicroUsd: minimum('providerSpendMicroUsd'),
  };
}

function zeroBudget(): TaskBudgets {
  return {
    workAccessAttemptLifetimeSeconds: 0,
    workAccessGrantLifetimeSeconds: 0,
    nonterminalAttemptsPerUserClient: 0,
    activeGrantsPerUserClient: 0,
    publicAttemptCreationsPerMinutePerLoopbackSource: 0,
    nonterminalAttemptsGlobally: 0,
    requestsPerGrant: 0,
    tasksPerAdmittedUser: 0,
    runsPerAdmittedUser: 0,
    activeRunsPerAdmittedUser: 0,
    hostedWorkTasksGlobally: 0,
    hostedWorkRunsGlobally: 0,
    activeHostedWorkRunsGlobally: 0,
    ordinaryJsonRequestBodyBytes: 0,
    evidenceBatchBodyBytes: 0,
    artifactRequestBodyBytes: 0,
    evidencePlusArtifactsPerRunBytes: 0,
    acceptedEvidencePlusArtifactsGloballyBytes: 0,
    runWallTimeSeconds: 0,
    providerRequests: 0,
    providerInputTokens: 0,
    providerOutputTokens: 0,
    toolProposals: 0,
    aggregateChildCommandTimeSeconds: 0,
    oneChildCommandTimeSeconds: 0,
    changedFiles: 0,
    changedWorktreeBytes: 0,
    providerSpendMicroUsd: 0,
  };
}

function budgetIsValid(budget: TaskBudgets): boolean {
  return taskBudgetNames.every((name) => Number.isSafeInteger(budget[name]) && budget[name] >= 0);
}

function purposeIsValid(purpose: RunPurpose): boolean {
  return (
    purpose.kind === 'Retained' ||
    (purpose.campaignId.length > 0 &&
      Number.isSafeInteger(purpose.ordinal) &&
      purpose.ordinal >= 1 &&
      purpose.ordinal <= 5)
  );
}

function initialSpecializationMatches(binding: RunBinding): boolean {
  const activation = binding.initialSpecialization;
  if (
    activation.harnessLineageId !== binding.harnessLineageId ||
    activation.harnessRevisionSaid !== binding.initialHarnessRevisionSaid ||
    activation.acceptedAt > binding.acceptedAt
  ) {
    return false;
  }
  return binding.purpose.kind === 'PreparedCompatibilityCalibration' &&
    binding.purpose.ordinal === 1
    ? activation.runId === binding.runId && activation.acceptedAt === binding.acceptedAt
    : activation.runId !== binding.runId;
}

export function createRun(binding: RunBinding): RunCreation {
  if (
    binding.ownerAid === binding.personalAgentAid ||
    binding.ownerAid === binding.governorAid ||
    binding.personalAgentAid === binding.governorAid
  ) {
    return { kind: 'Rejected', reason: 'PrincipalConflict' };
  }
  if (!budgetIsValid(binding.budget)) {
    return { kind: 'Rejected', reason: 'BudgetInvalid' };
  }
  if (!purposeIsValid(binding.purpose)) {
    return { kind: 'Rejected', reason: 'PurposeInvalid' };
  }
  if (!initialSpecializationMatches(binding)) {
    return { kind: 'Rejected', reason: 'InitialSpecializationConflict' };
  }
  return {
    kind: 'Created',
    run: {
      version: 0,
      binding: {
        ...binding,
        purpose: { ...binding.purpose },
        initialSpecialization: { ...binding.initialSpecialization },
        repository: { ...binding.repository },
        budget: { ...binding.budget },
      },
      lifecycle: { kind: 'Active', phase: { kind: 'Preparing' } },
      submissionVerification: { kind: 'NotSubmitted' },
      lease: { kind: 'Unassigned' },
      consumedBudget: zeroBudget(),
    },
  };
}
