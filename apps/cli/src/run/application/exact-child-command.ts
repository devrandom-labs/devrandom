import type { EvidenceProducer } from '@devrandom/runtime';
import type { CredentialDisclosure } from '@devrandom/domain';

export interface ExactChildCommand {
  readonly executableRealpath: string;
  readonly arguments: readonly string[];
  readonly timeoutSeconds: number;
  readonly expectedExitCode: number;
  readonly budgetProducer: EvidenceProducer;
}

export interface CapturedChildStream {
  readonly path: string;
  readonly byteLength: number;
}

export type ChildOutputAcknowledgement =
  | { readonly kind: 'Cleaned' }
  | { readonly kind: 'AlreadyCleaned' }
  | { readonly kind: 'Unavailable' };

export interface CapturedChildOutput {
  readonly disclosure: CredentialDisclosure;
  readonly stdout: CapturedChildStream;
  readonly stderr: CapturedChildStream;
  acknowledge(): Promise<ChildOutputAcknowledgement>;
}

interface ObservedChildExit {
  readonly exitCode: number | null;
  readonly terminationSignal: NodeJS.Signals | null;
  readonly elapsedMilliseconds: number;
  readonly output: CapturedChildOutput;
}

export type ChildBudgetCommitmentFailure =
  | 'SecretDetected'
  | 'BudgetExhausted'
  | 'OutboxBackpressure'
  | 'EvidenceIntegrityFailure'
  | 'DependencyUnavailable';

type ChildCommandExecution =
  | { readonly kind: 'AbortedBeforeStart' }
  | ({ readonly kind: 'Completed'; readonly exitCode: number } & ObservedChildExit)
  | ({ readonly kind: 'ExitCodeMismatch'; readonly exitCode: number } & ObservedChildExit)
  | ({ readonly kind: 'TimedOut' } & ObservedChildExit)
  | ({ readonly kind: 'OutputLimitExceeded' } & ObservedChildExit)
  | ({ readonly kind: 'Aborted' } & ObservedChildExit)
  | ({ readonly kind: 'SecretDetected' } & ObservedChildExit)
  | ({ readonly kind: 'ProcessGroupSurvived' } & ObservedChildExit)
  | ({ readonly kind: 'ProcessCleanupUnconfirmed' } & ObservedChildExit)
  | ({
      readonly kind: 'BudgetCommitmentFailed';
      readonly failure: ChildBudgetCommitmentFailure;
    } & ObservedChildExit)
  | { readonly kind: 'BudgetExhausted' }
  | { readonly kind: 'ExecutableUnavailable' }
  | { readonly kind: 'DependencyUnavailable' };

export type CommandWorktreeFailure =
  | 'BudgetExhausted'
  | 'SecretDetected'
  | 'OutboxBackpressure'
  | 'EvidenceIntegrityFailure'
  | 'DependencyUnavailable';

export type ExactChildCommandOutcome =
  | ChildCommandExecution
  | { readonly kind: 'WorktreeAdmissionRejected'; readonly failure: CommandWorktreeFailure }
  | {
      readonly kind: 'WorktreeReconciliationFailed';
      readonly failure: CommandWorktreeFailure;
      readonly execution: Extract<ChildCommandExecution, { readonly output: CapturedChildOutput }>;
    };

export interface ExactChildCommands {
  run(command: ExactChildCommand, signal: AbortSignal): Promise<ExactChildCommandOutcome>;
}
