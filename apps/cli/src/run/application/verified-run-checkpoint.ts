import { isDeepStrictEqual } from 'node:util';

import {
  taskBudgetNames,
  taskBudgetCeilings,
  runLifecycleRetainsBudgetExcess,
  type CredentialDisclosure,
  type Run,
  type TaskBudgets,
} from '@devrandom/domain';
import {
  prepareVerifiedCheckpoint,
  type BaselineHarnessRevision,
  type PublicVerifierReceipt,
  type TaskProjection,
  type VerifiedCheckpoint,
  type VerifiedCheckpointDraft,
} from '@devrandom/protocol';
import type {
  EvidenceRecorder,
  EvidenceRecording,
  RunBudgetAmount,
  RunBudgetSettlement,
  RunResourceBudget,
} from '@devrandom/runtime';

import type { PreparedRunWorktree } from './run-worktree.js';

export type CheckpointRepositoryCapture =
  | Extract<CredentialDisclosure, { readonly kind: 'WithheldSecret' }>
  | {
      readonly kind: 'Captured';
      readonly repository: Extract<VerifiedCheckpoint, { readonly version: 1 }>['repository'];
      readonly changedWorktreeBytes: number;
    }
  | { readonly kind: 'RepositoryBindingRejected' }
  | { readonly kind: 'ChangedFileLimitExceeded' }
  | { readonly kind: 'ChangedWorktreeLimitExceeded' }
  | { readonly kind: 'GitUnavailable' };

export interface CheckpointRepository {
  capture(
    worktree: PreparedRunWorktree,
    limits: { readonly changedFiles: number; readonly changedWorktreeBytes: number },
    signal?: AbortSignal,
  ): Promise<CheckpointRepositoryCapture>;
}

export interface VerifiedCheckpointDisposition {
  readonly runState: VerifiedCheckpointDraft['runState'];
  readonly continuation: VerifiedCheckpointDraft['continuation'];
}

export interface VerifiedRunCheckpointInput {
  readonly run: Run;
  readonly outputArtifactSaids: readonly string[];
  readonly verifierReceipts: readonly PublicVerifierReceipt[];
  readonly disposition: VerifiedCheckpointDisposition;
}

type PrivacyCheckpointDisposition = {
  readonly runState: Extract<VerifiedCheckpointDraft, { readonly version: 2 }>['runState'];
  readonly continuation: Extract<VerifiedCheckpointDraft, { readonly version: 2 }>['continuation'];
};

function isPrivacyDisposition(
  disposition: VerifiedCheckpointDisposition,
): disposition is PrivacyCheckpointDisposition {
  return (
    disposition.runState.kind === 'Active' &&
    disposition.runState.phase.kind === 'Blocked' &&
    disposition.runState.phase.reason === 'SecretDetected' &&
    disposition.continuation.kind === 'ExternalResolutionRequired' &&
    disposition.continuation.reason === 'SecretDetected'
  );
}

export type VerifiedRunCheckpointMaterialization =
  | { readonly kind: 'Materialized'; readonly checkpoint: VerifiedCheckpoint }
  | { readonly kind: 'BindingRejected' }
  | {
      readonly kind: 'RepositoryRejected';
      readonly reason: Exclude<CheckpointRepositoryCapture['kind'], 'Captured' | 'WithheldSecret'>;
    }
  | { readonly kind: 'OutboxBackpressure' }
  | { readonly kind: 'EvidenceUnavailable' }
  | { readonly kind: 'SecretDetected' }
  | { readonly kind: 'EvidenceIntegrityFailure' };

export interface RunCheckpointing {
  materialize(
    input: VerifiedRunCheckpointInput,
  ): Promise<
    | { readonly kind: 'Materialized'; readonly checkpoint: { readonly d: string } }
    | Exclude<VerifiedRunCheckpointMaterialization, { readonly kind: 'Materialized' }>
  >;
}

export interface VerifiedRunCheckpointDependencies {
  readonly task: TaskProjection;
  readonly harness: BaselineHarnessRevision;
  readonly worktree: PreparedRunWorktree;
  readonly evidence: EvidenceRecorder;
  readonly budget: RunResourceBudget;
  readonly repository: CheckpointRepository;
  now(): string;
}

function remainingBudget(run: Run, consumed: TaskBudgets): TaskBudgets {
  const ceiling = run.binding.budget;
  const remaining = {
    workAccessAttemptLifetimeSeconds:
      ceiling.workAccessAttemptLifetimeSeconds - consumed.workAccessAttemptLifetimeSeconds,
    workAccessGrantLifetimeSeconds:
      ceiling.workAccessGrantLifetimeSeconds - consumed.workAccessGrantLifetimeSeconds,
    nonterminalAttemptsPerUserClient:
      ceiling.nonterminalAttemptsPerUserClient - consumed.nonterminalAttemptsPerUserClient,
    activeGrantsPerUserClient:
      ceiling.activeGrantsPerUserClient - consumed.activeGrantsPerUserClient,
    publicAttemptCreationsPerMinutePerLoopbackSource:
      ceiling.publicAttemptCreationsPerMinutePerLoopbackSource -
      consumed.publicAttemptCreationsPerMinutePerLoopbackSource,
    nonterminalAttemptsGlobally:
      ceiling.nonterminalAttemptsGlobally - consumed.nonterminalAttemptsGlobally,
    requestsPerGrant: ceiling.requestsPerGrant - consumed.requestsPerGrant,
    tasksPerAdmittedUser: ceiling.tasksPerAdmittedUser - consumed.tasksPerAdmittedUser,
    runsPerAdmittedUser: ceiling.runsPerAdmittedUser - consumed.runsPerAdmittedUser,
    activeRunsPerAdmittedUser:
      ceiling.activeRunsPerAdmittedUser - consumed.activeRunsPerAdmittedUser,
    hostedWorkTasksGlobally: ceiling.hostedWorkTasksGlobally - consumed.hostedWorkTasksGlobally,
    hostedWorkRunsGlobally: ceiling.hostedWorkRunsGlobally - consumed.hostedWorkRunsGlobally,
    activeHostedWorkRunsGlobally:
      ceiling.activeHostedWorkRunsGlobally - consumed.activeHostedWorkRunsGlobally,
    ordinaryJsonRequestBodyBytes:
      ceiling.ordinaryJsonRequestBodyBytes - consumed.ordinaryJsonRequestBodyBytes,
    evidenceBatchBodyBytes: ceiling.evidenceBatchBodyBytes - consumed.evidenceBatchBodyBytes,
    artifactRequestBodyBytes: ceiling.artifactRequestBodyBytes - consumed.artifactRequestBodyBytes,
    evidencePlusArtifactsPerRunBytes:
      ceiling.evidencePlusArtifactsPerRunBytes - consumed.evidencePlusArtifactsPerRunBytes,
    acceptedEvidencePlusArtifactsGloballyBytes:
      ceiling.acceptedEvidencePlusArtifactsGloballyBytes -
      consumed.acceptedEvidencePlusArtifactsGloballyBytes,
    runWallTimeSeconds: ceiling.runWallTimeSeconds - consumed.runWallTimeSeconds,
    providerRequests: ceiling.providerRequests - consumed.providerRequests,
    providerInputTokens: ceiling.providerInputTokens - consumed.providerInputTokens,
    providerOutputTokens: ceiling.providerOutputTokens - consumed.providerOutputTokens,
    toolProposals: ceiling.toolProposals - consumed.toolProposals,
    aggregateChildCommandTimeSeconds:
      ceiling.aggregateChildCommandTimeSeconds - consumed.aggregateChildCommandTimeSeconds,
    oneChildCommandTimeSeconds:
      ceiling.oneChildCommandTimeSeconds - consumed.oneChildCommandTimeSeconds,
    changedFiles: ceiling.changedFiles - consumed.changedFiles,
    changedWorktreeBytes: ceiling.changedWorktreeBytes - consumed.changedWorktreeBytes,
    providerSpendMicroUsd: ceiling.providerSpendMicroUsd - consumed.providerSpendMicroUsd,
  };
  for (const name of taskBudgetNames) remaining[name] = Math.max(0, remaining[name]);
  return remaining;
}

function checkpointBindingsMatch(
  dependencies: VerifiedRunCheckpointDependencies,
  run: Run,
): boolean {
  const { task, harness, worktree, evidence } = dependencies;
  const recordedRun = evidence.run;
  return (
    task.lifecycle.kind === 'Open' &&
    run.lifecycle.kind === 'Active' &&
    run.lifecycle.phase.kind === 'Running' &&
    run.lease.kind === 'Held' &&
    recordedRun.binding.runId === run.binding.runId &&
    recordedRun.binding.evidenceStreamId === run.binding.evidenceStreamId &&
    recordedRun.lease.kind === 'Held' &&
    recordedRun.lease.incarnationId === run.lease.incarnationId &&
    run.binding.ownerAid === task.ownerAid &&
    run.binding.taskId === task.taskId &&
    run.binding.taskRevisionSaid === task.revisionSaid &&
    run.binding.harnessLineageId === task.harnessLineageId &&
    run.binding.initialHarnessRevisionSaid === harness.d &&
    run.binding.personalAgentAid === harness.authority.personalAgentAid &&
    run.binding.taskMandateSaid === harness.authority.taskMandateSaid &&
    harness.task.taskId === task.taskId &&
    harness.task.revisionSaid === task.revisionSaid &&
    harness.task.harnessLineageId === task.harnessLineageId &&
    worktree.repository.objectFormat === run.binding.repository.objectFormat &&
    worktree.repository.commit === run.binding.repository.commit &&
    worktree.repository.tree === run.binding.repository.tree
  );
}

function evidenceFailure(recording: EvidenceRecording): VerifiedRunCheckpointMaterialization {
  switch (recording.kind) {
    case 'SecretDetected':
      return { kind: 'SecretDetected' };
    case 'OutboxBackpressure':
    case 'OutboxBoundReached':
      return { kind: 'OutboxBackpressure' };
    case 'Unavailable':
      return { kind: 'EvidenceUnavailable' };
    case 'ObservationRejected':
    case 'LocalStateCorruption':
      return { kind: 'EvidenceIntegrityFailure' };
    case 'Recorded':
      return { kind: 'EvidenceIntegrityFailure' };
  }
}

function budgetFailure(
  commitment: Exclude<RunBudgetSettlement, { readonly kind: 'Settled' | 'Exhausted' }>,
): VerifiedRunCheckpointMaterialization {
  switch (commitment.kind) {
    case 'SecretDetected':
      return { kind: 'SecretDetected' };
    case 'OutboxBackpressure':
      return { kind: 'OutboxBackpressure' };
    case 'Unavailable':
      return { kind: 'EvidenceUnavailable' };
    case 'EvidenceIntegrityFailure':
    case 'SettlementRejected':
      return { kind: 'EvidenceIntegrityFailure' };
  }
}

type CheckpointMaterializationState =
  | { readonly kind: 'Unprepared' }
  | {
      readonly kind: 'BudgetDebited';
      readonly input: VerifiedRunCheckpointInput;
      readonly repository: Extract<CheckpointRepositoryCapture, { readonly kind: 'Captured' }>;
    }
  | {
      readonly kind: 'PrivacyWithheld';
      readonly input: Omit<VerifiedRunCheckpointInput, 'disposition'> & {
        readonly disposition: PrivacyCheckpointDisposition;
      };
      readonly disclosure: Extract<CredentialDisclosure, { readonly kind: 'WithheldSecret' }>;
      readonly dataWithheldEventSaid: string;
      readonly securityViolationEventSaid: string;
    }
  | {
      readonly kind: 'Prepared';
      readonly input: VerifiedRunCheckpointInput;
      readonly checkpoint: VerifiedCheckpoint;
    }
  | {
      readonly kind: 'Recorded';
      readonly input: VerifiedRunCheckpointInput;
      readonly checkpoint: VerifiedCheckpoint;
    };

export class VerifiedRunCheckpoint implements RunCheckpointing {
  readonly #dependencies: VerifiedRunCheckpointDependencies;
  #state: CheckpointMaterializationState = { kind: 'Unprepared' };
  #sequence: Promise<void> = Promise.resolve();

  constructor(dependencies: VerifiedRunCheckpointDependencies) {
    this.#dependencies = dependencies;
  }

  materialize(input: VerifiedRunCheckpointInput): Promise<VerifiedRunCheckpointMaterialization> {
    const boundInput = structuredClone(input);
    const pending = this.#sequence.then(() => this.#materialize(boundInput));
    this.#sequence = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  async #materialize(
    input: VerifiedRunCheckpointInput,
  ): Promise<VerifiedRunCheckpointMaterialization> {
    if (this.#state.kind !== 'Unprepared' && !isDeepStrictEqual(input, this.#state.input)) {
      return { kind: 'BindingRejected' };
    }
    if (
      !checkpointBindingsMatch(this.#dependencies, input.run) ||
      this.#dependencies.budget.runId !== input.run.binding.runId
    ) {
      return { kind: 'BindingRejected' };
    }
    if (this.#state.kind === 'Recorded') {
      return { kind: 'Materialized', checkpoint: structuredClone(this.#state.checkpoint) };
    }
    if (this.#state.kind === 'Prepared') return this.#persist(this.#state);
    if (this.#state.kind === 'Unprepared') {
      const remaining = remainingBudget(input.run, this.#dependencies.budget.snapshot());
      const repository = await this.#dependencies.repository.capture(this.#dependencies.worktree, {
        changedFiles: taskBudgetCeilings.changedFiles,
        changedWorktreeBytes: taskBudgetCeilings.changedWorktreeBytes,
      });
      if (repository.kind === 'WithheldSecret') {
        if (!isPrivacyDisposition(input.disposition)) {
          return { kind: 'BindingRejected' };
        }
        const withheld = this.#dependencies.evidence.withhold({
          occurredAt: this.#dependencies.now(),
          producer: { kind: 'EvidenceRecorder' },
          disclosure: repository,
        });
        if (withheld.kind !== 'SecretDetected') return evidenceFailure(withheld);
        this.#state = {
          kind: 'PrivacyWithheld',
          input: { ...input, disposition: input.disposition },
          disclosure: repository,
          dataWithheldEventSaid: withheld.dataWithheldEventSaid,
          securityViolationEventSaid: withheld.securityViolationEventSaid,
        };
      } else if (repository.kind !== 'Captured') {
        return { kind: 'RepositoryRejected', reason: repository.kind };
      } else {
        if (
          repository.repository.objectFormat !== input.run.binding.repository.objectFormat ||
          repository.repository.baseCommit !== input.run.binding.repository.commit ||
          repository.repository.baseTree !== input.run.binding.repository.tree ||
          !Number.isSafeInteger(repository.changedWorktreeBytes) ||
          repository.changedWorktreeBytes < 0
        ) {
          return { kind: 'BindingRejected' };
        }
        if (
          repository.repository.changedFiles.length > remaining.changedFiles &&
          !runLifecycleRetainsBudgetExcess(input.disposition.runState)
        ) {
          return { kind: 'RepositoryRejected', reason: 'ChangedFileLimitExceeded' };
        }
        if (
          repository.changedWorktreeBytes > remaining.changedWorktreeBytes &&
          !runLifecycleRetainsBudgetExcess(input.disposition.runState)
        ) {
          return { kind: 'RepositoryRejected', reason: 'ChangedWorktreeLimitExceeded' };
        }
        const changedBudget: RunBudgetAmount[] = [
          { budget: 'changedFiles', amount: repository.repository.changedFiles.length },
          { budget: 'changedWorktreeBytes', amount: repository.changedWorktreeBytes },
        ];
        const settlement = this.#dependencies.budget.settle({
          producer: { kind: 'EvidenceRecorder' },
          actual: changedBudget,
        });
        if (settlement.kind !== 'Settled' && settlement.kind !== 'Exhausted') {
          return budgetFailure(settlement);
        }
        this.#state = { kind: 'BudgetDebited', input, repository };
      }
    }
    const state = this.#state;
    const readiness = this.#dependencies.evidence.readiness();
    if (readiness.kind === 'Unavailable') {
      return { kind: 'EvidenceUnavailable' };
    }
    if (readiness.kind !== 'Ready' || readiness.readiness.kind !== 'Continued') {
      return { kind: 'EvidenceIntegrityFailure' };
    }
    if (
      readiness.readiness.streamId !== input.run.binding.evidenceStreamId ||
      readiness.readiness.nextSequence < 1
    ) {
      return { kind: 'EvidenceIntegrityFailure' };
    }
    const lease = input.run.lease;
    if (lease.kind !== 'Held') {
      return { kind: 'BindingRejected' };
    }
    const conditionIds = this.#dependencies.task.revision.completionConditions.map(({ id }) => id);
    const consumed = this.#dependencies.budget.snapshot();
    const draftBody = {
      taskId: input.run.binding.taskId,
      taskRevisionSaid: input.run.binding.taskRevisionSaid,
      runId: input.run.binding.runId,
      incarnationId: lease.incarnationId,
      harnessRevisionSaid: input.run.binding.initialHarnessRevisionSaid,
      harnessLineageId: input.run.binding.harnessLineageId,
      personalAgentAid: input.run.binding.personalAgentAid,
      governorAid: input.run.binding.governorAid,
      taskMandateSaid: input.run.binding.taskMandateSaid,
      promotionMandateSaid: input.run.binding.promotionMandateSaid,
      purpose: input.run.binding.purpose,
      outputArtifactSaids: [...input.outputArtifactSaids],
      verifierReceipts: [...input.verifierReceipts],
      evidence: {
        eventCount: readiness.readiness.nextSequence,
        finalSequence: readiness.readiness.nextSequence - 1,
        chainHeadSaid: readiness.readiness.previousEventSaid,
      },
      budget: {
        consumed,
        remaining: remainingBudget(input.run, consumed),
      },
      runState: input.disposition.runState,
      continuation: input.disposition.continuation,
    };
    const draft: VerifiedCheckpointDraft =
      state.kind === 'PrivacyWithheld'
        ? {
            ...draftBody,
            version: 2,
            repository: {
              objectFormat: input.run.binding.repository.objectFormat,
              baseCommit: input.run.binding.repository.commit,
              baseTree: input.run.binding.repository.tree,
              repositoryMeasurement: {
                kind: 'UnavailableBecauseSecret',
                disclosure: state.disclosure,
                dataWithheldEventSaid: state.dataWithheldEventSaid,
                securityViolationEventSaid: state.securityViolationEventSaid,
              },
            },
            runState: state.input.disposition.runState,
            continuation: state.input.disposition.continuation,
          }
        : { ...draftBody, version: 1, repository: state.repository.repository };
    const prepared = prepareVerifiedCheckpoint(draft, conditionIds);
    if (prepared.kind !== 'Prepared') {
      return { kind: 'EvidenceIntegrityFailure' };
    }
    this.#state = { kind: 'Prepared', input, checkpoint: prepared.checkpoint };
    return this.#persist(this.#state);
  }

  #persist(
    state: Extract<CheckpointMaterializationState, { readonly kind: 'Prepared' }>,
  ): VerifiedRunCheckpointMaterialization {
    const checkpoint = state.checkpoint;
    const conditionIds = this.#dependencies.task.revision.completionConditions.map(({ id }) => id);
    const stored = this.#dependencies.evidence.storeCheckpoint({
      checkpoint,
      completionConditionIds: conditionIds,
    });
    switch (stored.kind) {
      case 'CheckpointRejected':
      case 'LocalStateCorruption':
        return { kind: 'EvidenceIntegrityFailure' };
      case 'OutboxBackpressure':
      case 'OutboxBoundReached':
        return { kind: 'OutboxBackpressure' };
      case 'Unavailable':
        return { kind: 'EvidenceUnavailable' };
      case 'Stored':
      case 'AlreadyStored':
        break;
    }
    const recorded = this.#dependencies.evidence.record({
      occurredAt: this.#dependencies.now(),
      producer: { kind: 'EvidenceRecorder' },
      event: { kind: 'CheckpointVerified', checkpointSaid: checkpoint.d },
    });
    if (recorded.kind !== 'Recorded') return evidenceFailure(recorded);
    this.#state = { ...state, kind: 'Recorded' };
    return { kind: 'Materialized', checkpoint: structuredClone(checkpoint) };
  }
}
