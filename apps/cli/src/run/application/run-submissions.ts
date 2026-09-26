import type {
  PreparedCompatibilityFailureInput,
  PreparedCompatibilityFailures,
} from './prepared-compatibility.js';
import type {
  RetainedSubmittedVerification,
  SubmittedResultVerification,
  SubmittedResultVerificationInput,
  SubmittedResultVerificationOutcome,
} from './public-task-verification.js';

export type RunSubmissionVerificationOutcome =
  | SubmittedResultVerificationOutcome
  | ({ readonly kind: 'CompatibilityFailure' } & Omit<
      Extract<RetainedSubmittedVerification, { readonly kind: 'Rejected' }>,
      'kind'
    >);

export interface RunSubmissionVerification {
  verify(
    input: SubmittedResultVerificationInput,
    signal: AbortSignal,
  ): Promise<RunSubmissionVerificationOutcome>;
}

export type SubmittedVerificationTransfer =
  | { readonly kind: 'Transferred'; readonly verification: RetainedSubmittedVerification }
  | { readonly kind: 'NoSubmission' }
  | { readonly kind: 'AlreadyTransferred' };

export interface SubmittedVerificationCustody {
  transferSubmittedVerification(): SubmittedVerificationTransfer;
}

type SubmittedVerificationRetention =
  | { readonly kind: 'NoSubmission' }
  | { readonly kind: 'Retained'; readonly verification: RetainedSubmittedVerification }
  | { readonly kind: 'Transferred' };

export interface RunSubmissionsDependencies extends Omit<
  PreparedCompatibilityFailureInput,
  'verification'
> {
  readonly verification: SubmittedResultVerification;
  readonly compatibility: PreparedCompatibilityFailures;
}

/** Owns submission adjudication and receipt custody until Run settlement. */
export class RunSubmissions implements RunSubmissionVerification, SubmittedVerificationCustody {
  readonly #dependencies: RunSubmissionsDependencies;
  #retention: SubmittedVerificationRetention = { kind: 'NoSubmission' };

  constructor(dependencies: RunSubmissionsDependencies) {
    this.#dependencies = dependencies;
  }

  async verify(
    input: SubmittedResultVerificationInput,
    signal: AbortSignal,
  ): Promise<RunSubmissionVerificationOutcome> {
    if (this.#retention.kind === 'Transferred') return { kind: 'EvidenceIntegrityFailure' };
    const verification = await this.#dependencies.verification.verify(input, signal);
    if (
      verification.kind === 'DependencyUnavailable' ||
      verification.kind === 'ArtifactUnavailable' ||
      verification.kind === 'EvidenceIntegrityFailure'
    )
      return verification;
    this.#retention = { kind: 'Retained', verification };
    if (verification.kind !== 'Rejected') return verification;
    const classification = this.#dependencies.compatibility.classify({
      task: this.#dependencies.task,
      harness: this.#dependencies.harness,
      run: this.#dependencies.run,
      verification,
    });
    switch (classification.kind) {
      case 'Confirmed':
        return { ...verification, kind: 'CompatibilityFailure' };
      case 'NotConfirmed':
        return verification;
      case 'SecretDetected':
      case 'InfrastructureFailure': {
        const blocked = {
          ...verification,
          kind: 'Blocked' as const,
          reason:
            classification.kind === 'SecretDetected'
              ? ('SecretDetected' as const)
              : classification.reason,
        };
        this.#retention = { kind: 'Retained', verification: blocked };
        return blocked;
      }
    }
  }

  transferSubmittedVerification(): SubmittedVerificationTransfer {
    switch (this.#retention.kind) {
      case 'NoSubmission':
        return { kind: 'NoSubmission' };
      case 'Transferred':
        return { kind: 'AlreadyTransferred' };
      case 'Retained': {
        const verification = this.#retention.verification;
        this.#retention = { kind: 'Transferred' };
        return { kind: 'Transferred', verification };
      }
    }
  }
}
