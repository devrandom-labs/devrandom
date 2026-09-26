import type { CredentialDisclosure, ProtectedCredentials, TaskBudgets } from '@devrandom/domain';
import type { EvidenceRecorder } from '@devrandom/runtime';

import type { PreparedRunWorktree } from './run-worktree.js';

export interface ProposedWorktreeWrite {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly replacement?: {
    readonly oldText: string;
    readonly newText: string;
  };
}

export type WorktreeWriteInspection =
  | {
      readonly kind: 'Projected';
      readonly changedFiles: number;
      readonly changedWorktreeBytes: number;
    }
  | { readonly kind: 'BudgetExhausted' }
  | { readonly kind: 'DependencyUnavailable' }
  | Extract<CredentialDisclosure, { readonly kind: 'WithheldSecret' }>;

export interface WorktreeWriteRepository {
  inspectWrite(
    worktree: PreparedRunWorktree,
    limits: Pick<TaskBudgets, 'changedFiles' | 'changedWorktreeBytes'>,
    write: ProposedWorktreeWrite,
    signal: AbortSignal,
  ): Promise<WorktreeWriteInspection>;
}

export type WorktreeWriteDisposition =
  | Exclude<WorktreeWriteInspection, { readonly kind: 'WithheldSecret' | 'Projected' }>
  | { readonly kind: 'Admitted' }
  | { readonly kind: 'SecretDetected' }
  | { readonly kind: 'OutboxBackpressure' }
  | { readonly kind: 'EvidenceIntegrityFailure' };

export interface WorktreeWriteAdmission {
  admit(write: ProposedWorktreeWrite, signal: AbortSignal): Promise<WorktreeWriteDisposition>;
}

interface RunWorktreeWriteAdmissionDependencies {
  readonly worktree: PreparedRunWorktree;
  readonly limits: Pick<TaskBudgets, 'changedFiles' | 'changedWorktreeBytes'>;
  readonly repository: WorktreeWriteRepository;
  readonly credentials: ProtectedCredentials;
  readonly evidence: Pick<EvidenceRecorder, 'withhold'>;
  now(): string;
}

export class RunWorktreeWriteAdmission implements WorktreeWriteAdmission {
  readonly #dependencies: RunWorktreeWriteAdmissionDependencies;

  constructor(dependencies: RunWorktreeWriteAdmissionDependencies) {
    this.#dependencies = dependencies;
  }

  async admit(
    write: ProposedWorktreeWrite,
    signal: AbortSignal,
  ): Promise<WorktreeWriteDisposition> {
    signal.throwIfAborted();
    const pathDisclosure = this.#dependencies.credentials.inspect(
      new TextEncoder().encode(write.path),
    );
    const replacedTextDisclosure =
      pathDisclosure.kind === 'WithheldSecret' || write.replacement === undefined
        ? pathDisclosure
        : this.#dependencies.credentials.inspect(
            new TextEncoder().encode(write.replacement.oldText),
          );
    const replacementTextDisclosure =
      replacedTextDisclosure.kind === 'WithheldSecret' || write.replacement === undefined
        ? replacedTextDisclosure
        : this.#dependencies.credentials.inspect(
            new TextEncoder().encode(write.replacement.newText),
          );
    const disclosure =
      replacementTextDisclosure.kind === 'WithheldSecret'
        ? replacementTextDisclosure
        : this.#dependencies.credentials.inspect(write.bytes);
    const inspection =
      disclosure.kind === 'WithheldSecret'
        ? disclosure
        : await this.#dependencies.repository.inspectWrite(
            this.#dependencies.worktree,
            this.#dependencies.limits,
            write,
            signal,
          );
    signal.throwIfAborted();
    if (inspection.kind === 'Projected') {
      return inspection.changedFiles > this.#dependencies.limits.changedFiles ||
        inspection.changedWorktreeBytes > this.#dependencies.limits.changedWorktreeBytes
        ? { kind: 'BudgetExhausted' }
        : { kind: 'Admitted' };
    }
    if (inspection.kind !== 'WithheldSecret') return inspection;
    const recording = this.#dependencies.evidence.withhold({
      occurredAt: this.#dependencies.now(),
      producer: { kind: 'ToolGateway' },
      disclosure: inspection,
    });
    switch (recording.kind) {
      case 'SecretDetected':
        return { kind: 'SecretDetected' };
      case 'OutboxBackpressure':
      case 'OutboxBoundReached':
        return { kind: 'OutboxBackpressure' };
      case 'Unavailable':
        return { kind: 'DependencyUnavailable' };
      case 'ObservationRejected':
      case 'LocalStateCorruption':
        return { kind: 'EvidenceIntegrityFailure' };
    }
  }
}
