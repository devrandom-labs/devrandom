import type { WorkAccessScope } from '@devrandom/protocol';

import type { WorkAccessAttempt, WorkAccessCommand } from '../domain/work-access.js';

export interface StoredWorkAccessAttempt {
  readonly revision: number;
  readonly commandFingerprint: string;
  readonly attempt: WorkAccessAttempt;
}

export type WorkAccessAttemptCreation =
  | { readonly kind: 'AttemptCreated'; readonly stored: StoredWorkAccessAttempt }
  | { readonly kind: 'ExistingAttempt'; readonly stored: StoredWorkAccessAttempt }
  | { readonly kind: 'CommandConflict' }
  | { readonly kind: 'AttemptCapacityExceeded' };

export type WorkAccessCommandReconciliation =
  | { readonly kind: 'NoAttempt' }
  | { readonly kind: 'ExistingAttempt'; readonly stored: StoredWorkAccessAttempt }
  | { readonly kind: 'CommandConflict' };

export type WorkAccessAttemptLookup =
  | { readonly kind: 'AttemptFound'; readonly stored: StoredWorkAccessAttempt }
  | { readonly kind: 'AttemptNotFound' };

export type WorkAccessAttemptCommit =
  | { readonly kind: 'AttemptCommitted'; readonly stored: StoredWorkAccessAttempt }
  | { readonly kind: 'ConcurrentlyModified' }
  | { readonly kind: 'ProofResponseReplayed' }
  | { readonly kind: 'GrantCapacityExceeded' };

export type GrantAuthorization =
  | {
      readonly kind: 'GrantAuthorized';
      readonly stored: StoredWorkAccessAttempt;
      readonly remainingRequests: number;
    }
  | { readonly kind: 'GrantNotFound' }
  | { readonly kind: 'GrantExpired' }
  | { readonly kind: 'GrantExhausted' }
  | { readonly kind: 'GrantReleased' }
  | { readonly kind: 'GrantRevoked'; readonly reason: 'SecurityIncident' }
  | { readonly kind: 'GrantScopeRejected' }
  | { readonly kind: 'GrantAuthorizationConflict' };

export interface WorkAccessAttempts {
  reconcileCommand(
    command: WorkAccessCommand,
    commandFingerprint: string,
  ): Promise<WorkAccessCommandReconciliation>;
  create(
    attempt: WorkAccessAttempt,
    commandFingerprint: string,
  ): Promise<WorkAccessAttemptCreation>;
  retrieve(attemptId: string): Promise<StoredWorkAccessAttempt | undefined>;
  retrieveAuthorized(attemptId: string, grantSecretHash: string): Promise<WorkAccessAttemptLookup>;
  commit(
    current: StoredWorkAccessAttempt,
    next: WorkAccessAttempt,
  ): Promise<WorkAccessAttemptCommit>;
  authorizeGrant(input: {
    readonly grantSecretHash: string;
    readonly scope: WorkAccessScope;
    readonly observedAt: string;
  }): Promise<GrantAuthorization>;
  verify(): Promise<void>;
}
