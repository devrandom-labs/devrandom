import type { TaskBudgets } from '@devrandom/domain';
import type { EvidenceProducer, EvidenceRecorder } from '@devrandom/runtime';

import type {
  CommandWorktreeFailure,
  ExactChildCommand,
  ExactChildCommandOutcome,
  ExactChildCommands,
} from './exact-child-command.js';
import type { PreparedRunWorktree } from './run-worktree.js';
import type { CheckpointRepository } from './verified-run-checkpoint.js';

interface RunWorktreeCommandsDependencies {
  readonly commands: ExactChildCommands;
  readonly worktree: PreparedRunWorktree;
  readonly limits: Pick<TaskBudgets, 'changedFiles' | 'changedWorktreeBytes'>;
  readonly repository: CheckpointRepository;
  readonly evidence: Pick<EvidenceRecorder, 'withhold'>;
  now(): string;
}

type WorktreeCommandAdmission =
  | { readonly kind: 'Open' }
  | { readonly kind: 'Rejected'; readonly failure: CommandWorktreeFailure };

// Run tools execute sequentially. This owner applies the same footprint law to
// managed commands and the public verifier, without taking custody of their output.
export class RunWorktreeCommands implements ExactChildCommands {
  readonly #dependencies: RunWorktreeCommandsDependencies;
  #admission: WorktreeCommandAdmission = { kind: 'Open' };

  constructor(dependencies: RunWorktreeCommandsDependencies) {
    this.#dependencies = dependencies;
  }

  async run(command: ExactChildCommand, signal: AbortSignal): Promise<ExactChildCommandOutcome> {
    if (signal.aborted) return { kind: 'AbortedBeforeStart' };
    if (this.#admission.kind === 'Rejected') {
      return { kind: 'WorktreeAdmissionRejected', failure: this.#admission.failure };
    }
    const admission = await this.#inspect(command.budgetProducer, signal);
    try {
      signal.throwIfAborted();
    } catch {
      return { kind: 'AbortedBeforeStart' };
    }
    if (admission.kind === 'Rejected') {
      this.#admission = admission;
      return { kind: 'WorktreeAdmissionRejected', failure: admission.failure };
    }
    const execution = await this.#dependencies.commands.run(command, signal);
    switch (execution.kind) {
      case 'WorktreeAdmissionRejected':
      case 'WorktreeReconciliationFailed':
        this.#admission = { kind: 'Rejected', failure: execution.failure };
        return execution;
      case 'ProcessGroupSurvived':
      case 'ProcessCleanupUnconfirmed':
        // A non-quiescent worktree cannot be reconciled as a stable footprint.
        this.#admission = { kind: 'Rejected', failure: 'EvidenceIntegrityFailure' };
        return execution;
      case 'SecretDetected':
        this.#admission = { kind: 'Rejected', failure: 'SecretDetected' };
        return execution;
      case 'BudgetCommitmentFailed':
        this.#admission = { kind: 'Rejected', failure: execution.failure };
        return execution;
      case 'AbortedBeforeStart':
      case 'BudgetExhausted':
      case 'ExecutableUnavailable':
      case 'DependencyUnavailable':
        return execution;
      case 'Completed':
      case 'ExitCodeMismatch':
      case 'TimedOut':
      case 'OutputLimitExceeded':
      case 'Aborted': {
        // This is bounded read-only closure, including after caller cancellation.
        // Checkpoint settlement remains the sole owner of footprint debits.
        const reconciliation = await this.#inspect(command.budgetProducer);
        if (reconciliation.kind === 'Open') return execution;
        this.#admission = reconciliation;
        return {
          kind: 'WorktreeReconciliationFailed',
          failure: reconciliation.failure,
          execution,
        };
      }
    }
  }

  async #inspect(
    producer: EvidenceProducer,
    signal?: AbortSignal,
  ): Promise<WorktreeCommandAdmission> {
    try {
      const capture = await this.#dependencies.repository.capture(
        this.#dependencies.worktree,
        this.#dependencies.limits,
        signal,
      );
      switch (capture.kind) {
        case 'Captured':
          return capture.repository.changedFiles.length > this.#dependencies.limits.changedFiles ||
            capture.changedWorktreeBytes > this.#dependencies.limits.changedWorktreeBytes
            ? { kind: 'Rejected', failure: 'BudgetExhausted' }
            : { kind: 'Open' };
        case 'ChangedFileLimitExceeded':
        case 'ChangedWorktreeLimitExceeded':
          return { kind: 'Rejected', failure: 'BudgetExhausted' };
        case 'GitUnavailable':
        case 'RepositoryBindingRejected':
          return { kind: 'Rejected', failure: 'DependencyUnavailable' };
        case 'WithheldSecret': {
          const recorded = this.#dependencies.evidence.withhold({
            occurredAt: this.#dependencies.now(),
            producer,
            disclosure: capture,
          });
          switch (recorded.kind) {
            case 'SecretDetected':
              return { kind: 'Rejected', failure: 'SecretDetected' };
            case 'OutboxBackpressure':
            case 'OutboxBoundReached':
              return { kind: 'Rejected', failure: 'OutboxBackpressure' };
            case 'Unavailable':
              return { kind: 'Rejected', failure: 'DependencyUnavailable' };
            case 'ObservationRejected':
            case 'LocalStateCorruption':
              return { kind: 'Rejected', failure: 'EvidenceIntegrityFailure' };
          }
        }
      }
    } catch {
      return { kind: 'Rejected', failure: 'DependencyUnavailable' };
    }
  }
}
