import type { RunRepository } from '@devrandom/domain';

export interface RunWorktreeInput {
  readonly stateRoot: string;
  readonly repositoryDirectory: string;
  readonly runId: string;
  readonly repository: RunRepository;
}

export interface PreparedRunWorktree {
  readonly directory: string;
  readonly branch: string;
  readonly repository: RunRepository;
}

export type RunWorktreePreparation =
  | { readonly kind: 'Interrupted' }
  | { readonly kind: 'Prepared'; readonly worktree: PreparedRunWorktree }
  | { readonly kind: 'Reconciled'; readonly worktree: PreparedRunWorktree }
  | { readonly kind: 'RepositoryBindingRejected' }
  | { readonly kind: 'ManagedWorktreeConflict' }
  | { readonly kind: 'GitUnavailable' };

export interface RunWorktrees {
  prepare(input: RunWorktreeInput, signal: AbortSignal): Promise<RunWorktreePreparation>;
}
