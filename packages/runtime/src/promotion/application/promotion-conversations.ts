import type { CurrentExactPromotionMandate, PromotionSelectionInput } from '@devrandom/domain';
import type {
  ActivationCommitCommand,
  ActivationCommitReceipt,
  EvaluationClosure,
  EvaluationManifest,
  GovernorPromotionDecisionPayload,
  PromotionProposalPayload,
  PromotionSelectionRecord,
} from '@devrandom/protocol';

/** Read only after verifying all 18 raw E3 observations against closure SAIDs, audits, custody and hosted acknowledgement. The selection record must be read back from immutable evidence custody. */
export interface VerifiedPromotionEvidence {
  readonly manifest: EvaluationManifest;
  readonly closure: EvaluationClosure;
  readonly hypothesisSaid: string;
  readonly selectionRecord: PromotionSelectionRecord;
  readonly comparison: PromotionSelectionInput;
}

export interface PromotionEvidenceReading {
  inspect(
    closureSaid: string,
  ): Promise<
    | { readonly kind: 'Verified'; readonly evidence: VerifiedPromotionEvidence }
    | { readonly kind: 'Incomplete' | 'Unavailable' }
  >;
}

/** This conversation includes explicit user confirmation and native v3 ACDC/TEL verification. */
export interface ExactPromotionAuthority {
  verify(input: {
    readonly taskId: string;
    readonly taskRevisionSaid: string;
    readonly harnessLineageId: string;
    readonly ownerAid: string;
    readonly governorAid: string;
    readonly evaluationManifestSaid: string;
    readonly evaluationClosureSaid: string;
  }): Promise<
    | { readonly kind: 'Current'; readonly mandate: CurrentExactPromotionMandate }
    | { readonly kind: 'PendingUserConfirmation' | 'Invalid' | 'Unavailable' }
  >;
}

/** Native EXN signing and read-after-write verification bind the personal-agent AID. */
export interface AgentPromotionSigning {
  sign(proposal: PromotionProposalPayload): Promise<
    | {
        readonly kind: 'Verified';
        readonly exchangeSaid: string;
        readonly sourceAid: string;
        readonly payload: PromotionProposalPayload;
      }
    | { readonly kind: 'Unavailable' }
  >;
}

/** Separate local Governor custody rechecks evidence and exact-M authority before signing. */
export interface GovernorPromotionSigning {
  sign(input: {
    readonly decision: GovernorPromotionDecisionPayload;
    readonly mandate: CurrentExactPromotionMandate;
    readonly evidence: VerifiedPromotionEvidence;
  }): Promise<
    | {
        readonly kind: 'Verified';
        readonly exchangeSaid: string;
        readonly sourceAid: string;
        readonly payload: GovernorPromotionDecisionPayload;
      }
    | { readonly kind: 'Rejected' | 'Unavailable' }
  >;
}

/** The signed exact command is durable before network delivery and reused byte-for-byte on retry. */
export interface PromotionCommands {
  inspect(
    commandId: string,
  ): Promise<
    | { readonly kind: 'Absent' }
    | { readonly kind: 'Staged'; readonly command: ActivationCommitCommand }
    | { readonly kind: 'Unavailable' }
  >;
  stage(command: ActivationCommitCommand): Promise<'Staged' | 'Same' | 'Conflict' | 'Unavailable'>;
}

export interface HostedActivationCommit {
  /**
   * A committed reply is returned only after the adapter verifies the issuer's
   * signed receipt, exact command fingerprint/binding and durable pointer read.
   * A bare HTTP success, unsigned projection or lost response is Unavailable.
   */
  commit(command: ActivationCommitCommand): Promise<ActivationCommitReceipt>;
}

/** The Run Supervisor may realize a successor only with a matching committed receipt. */
export interface CommittedRevisionRouting {
  activate(input: {
    readonly taskId: string;
    readonly revisionSaid: string;
    readonly pointerVersion: number;
    readonly decisionReceiptSaid: string;
  }): Promise<'Routed' | 'Pending'>;
}
