import type { WorkAccessRejectionReason } from '@devrandom/protocol';

import type { WorkAccessDependency } from './work-access-dependency.js';

type ChallengeRejectionReason = Exclude<WorkAccessRejectionReason, 'CredentialNotCurrent'>;

export type WorkAccessChallengeIssuance =
  | { readonly kind: 'ChallengeIssued'; readonly words: readonly string[] }
  | { readonly kind: 'ChallengeUnavailable'; readonly dependency: WorkAccessDependency };

export type WorkAccessChallengeVerificationStart =
  | { readonly kind: 'VerificationOperationStarted'; readonly operationName: string }
  | { readonly kind: 'ChallengeRejected'; readonly reason: ChallengeRejectionReason }
  | { readonly kind: 'ChallengeUnavailable'; readonly dependency: WorkAccessDependency };

export type WorkAccessChallengeObservation =
  | { readonly kind: 'ChallengeVerificationPending' }
  | { readonly kind: 'ChallengeVerified' }
  | { readonly kind: 'ChallengeRejected'; readonly reason: ChallengeRejectionReason }
  | { readonly kind: 'ChallengeUnavailable'; readonly dependency: WorkAccessDependency };

export type WorkAccessChallengeAcknowledgement =
  | { readonly kind: 'ChallengeAcknowledged' }
  | { readonly kind: 'ChallengeRejected'; readonly reason: ChallengeRejectionReason }
  | { readonly kind: 'ChallengeUnavailable'; readonly dependency: WorkAccessDependency };

export type WorkAccessChallengeCleanup =
  | { readonly kind: 'VerificationCleaned' }
  | { readonly kind: 'ChallengeCleanupDeferred'; readonly dependency: WorkAccessDependency };

export interface WorkAccessChallengeProof {
  issue(): Promise<WorkAccessChallengeIssuance>;
  beginVerification(input: {
    readonly attemptId: string;
    readonly sourceAid: string;
    readonly recipientAid: string;
    readonly challengeWords: readonly string[];
    readonly responseSaid: string;
  }): Promise<WorkAccessChallengeVerificationStart>;
  observeVerification(input: {
    readonly attemptId: string;
    readonly sourceAid: string;
    readonly recipientAid: string;
    readonly challengeWords: readonly string[];
    readonly responseSaid: string;
    readonly operationName: string;
  }): Promise<WorkAccessChallengeObservation>;
  acknowledgeResponse(input: {
    readonly sourceAid: string;
    readonly responseSaid: string;
  }): Promise<WorkAccessChallengeAcknowledgement>;
  cleanupVerification(operationName: string): Promise<WorkAccessChallengeCleanup>;
}
