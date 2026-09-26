import type {
  ComparisonAllocation,
  ComparisonSlot,
  EvaluationExecutionBinding,
  EvaluationLeaseReceipt,
} from '@devrandom/domain';
import type {
  EvidenceArtifact,
  EvidenceArtifactMediaType,
  EvaluationEvidenceEvent,
  EvaluationManifest,
  ProtectedEvaluationArtifact,
} from '@devrandom/protocol';
import type { AssistantMessage, TranscriptContext } from '@earendil-works/pi-ai';

import type { ToolGatewayOutcome, ToolGatewayProposal } from '../../tool-gateway/tool-gateway.js';

/** The hosted reservation is distinct from the retained Run and has its own lease. */
export interface EvaluationAdmission {
  admit(input: {
    readonly commandId: string;
    readonly fingerprint: string;
    readonly taskId: string;
    readonly taskRevisionSaid: string;
    readonly originRunId: string;
    readonly retainedCheckpointSaid: string;
    readonly retainedSealSaid: string;
    readonly expectedActiveRevisionSaid: string;
    readonly personalAgentAid: string;
    readonly taskMandateSaid: string;
    readonly policySaid: string;
    readonly executionProfileSaid: string;
    readonly sourceInventorySaid: string;
    readonly allocation: ComparisonAllocation;
  }): Promise<
    | {
        readonly kind: 'Admitted';
        readonly evaluationId: string;
        readonly version: number;
        readonly lease: EvaluationLeaseReceipt;
        readonly evidenceStreamId: string;
        readonly reservationSaid: string;
      }
    | {
        readonly kind: 'Blocked';
        readonly gate: 'Profile' | 'Source' | 'Authority' | 'Budget' | 'Qualification' | 'Evidence';
      }
    | { readonly kind: 'Conflict' }
    | { readonly kind: 'Unavailable' }
  >;
}

export interface EvaluationLease {
  inspect(
    binding: EvaluationExecutionBinding,
  ): Promise<
    | { readonly kind: 'Held'; readonly expiresAt: string }
    | { readonly kind: 'Lost' }
    | { readonly kind: 'Unavailable' }
  >;
}

/** Only the trusted parent owns this conversation; a worker can request an effect. */
export interface EvaluationToolGateway {
  propose(
    binding: EvaluationExecutionBinding,
    proposal: ToolGatewayProposal,
    signal: AbortSignal,
  ): Promise<ToolGatewayOutcome>;
}

/** Only the trusted parent resolves provider credentials, reserves spend and records usage. */
export interface EvaluationModelInference {
  complete(input: {
    readonly binding: EvaluationExecutionBinding;
    readonly requestOrdinal: number;
    readonly modelProfileSaid: string;
    readonly context: TranscriptContext;
    readonly maximumOutputTokens: number;
    readonly signal: AbortSignal;
  }): Promise<
    | {
        readonly kind: 'Completed';
        readonly message: AssistantMessage;
        readonly usageEventSaid: string;
        /** Exact provider charge, only after trusted-parent ConcentrateUsage.consume verifies the response. */
        readonly verifiedSpendMicroUsd: number;
      }
    | {
        readonly kind:
          'UnknownUsage' | 'BudgetExhausted' | 'LeaseLost' | 'Unavailable' | 'Interrupted';
      }
  >;
}

export interface TrialExecution {
  run(input: {
    readonly binding: EvaluationExecutionBinding;
    readonly manifest: EvaluationManifest;
    readonly slot: ComparisonSlot;
    readonly cleanSourceSaid: string;
    readonly reviewedBehaviorSaid: string;
    readonly modelProfileSaid: string;
    readonly containerProfileSaid: string;
    readonly signal: AbortSignal;
  }): Promise<
    | {
        readonly kind: 'Stopped';
        readonly capturedSourceSaid: string;
        readonly evidenceHeadSaid: string;
        readonly providerUsageEventSaids: readonly string[];
        readonly cleanupReceiptSaid: string;
      }
    | {
        readonly kind: 'Invalid';
        readonly reason:
          | 'Interrupted'
          | 'UnknownUsage'
          | 'ProfileDrift'
          | 'CleanupUnconfirmed'
          | 'CaptureFailed'
          | 'EvidenceUnavailable';
        readonly evidenceHeadSaid?: string;
      }
  >;
}

/** Build scripts and the produced executable are untrusted; both run outside the parent. */
export interface TaskArtifactConstruction {
  build(input: {
    readonly capturedSourceSaid: string;
    readonly reviewedRecipeSaid: string;
    readonly toolchainSaid: string;
    readonly containerProfileSaid: string;
    readonly signal: AbortSignal;
  }): Promise<
    | {
        readonly kind: 'Frozen';
        readonly executableSaid: string;
        readonly sourceSaid: string;
        readonly buildReceiptSaid: string;
        readonly cleanupReceiptSaid: string;
      }
    | {
        readonly kind: 'BuildFailed';
        readonly buildReceiptSaid: string;
        readonly cleanupReceiptSaid: string;
      }
    | {
        readonly kind: 'Invalid';
        readonly reason:
          | 'UnsafeSource'
          | 'ProfileDrift'
          | 'CleanupUnconfirmed'
          | 'Interrupted'
          | 'EvidenceUnavailable';
      }
  >;
}

/** This is the fixture's parse_receipt_stream API, observed from frozen executable bytes. */
export interface ReceiptObservation {
  observe(input: {
    readonly executableSaid: string;
    readonly stimulus: Uint8Array;
    readonly stimulusSaid: string;
    readonly caseScope: 'Public' | 'Protected';
    readonly signal: AbortSignal;
  }): Promise<
    | {
        readonly kind: 'Observed';
        readonly executableSaid: string;
        readonly observation:
          | {
              readonly kind: 'Parsed';
              readonly receipts: readonly {
                readonly version: 'Legacy' | 'Current';
                readonly payload: string;
              }[];
            }
          | {
              readonly kind: 'Rejected';
              readonly error: 'InvalidFrame' | 'InvalidPayload' | 'UnsupportedVersion';
            };
        readonly rawObservationSaid: string;
        readonly cleanupReceiptSaid: string;
      }
    | {
        readonly kind: 'Invalid';
        readonly reason:
          | 'ExecutableMismatch'
          | 'ProfileDrift'
          | 'CleanupUnconfirmed'
          | 'Interrupted'
          | 'EvidenceUnavailable';
      }
  >;
}

/** The E3 chain cannot append to the predecessor's sealed Run stream. */
export interface EvaluationEvidence {
  record(
    event: EvaluationEvidenceEvent,
  ): Promise<
    | { readonly kind: 'Recorded'; readonly sequence: number; readonly headSaid: string }
    | { readonly kind: 'Conflict' | 'Gap' | 'QuotaExceeded' | 'Unavailable' }
  >;
  acknowledge(input: {
    readonly evaluationId: string;
    readonly streamId: string;
    readonly fromSequence: number;
    readonly throughSequence: number;
    readonly expectedHeadSaid: string;
  }): Promise<
    | { readonly kind: 'Acknowledged'; readonly throughSequence: number; readonly headSaid: string }
    | { readonly kind: 'Conflict' | 'Gap' | 'Unavailable' }
  >;
}

/** Raw bytes enter durable local custody before an E3 event may reference their SAID. */
export interface EvaluationRawArtifacts {
  record(input: {
    readonly bytes: Uint8Array;
    readonly mediaType: EvidenceArtifactMediaType;
  }): Promise<
    | { readonly kind: 'Stored'; readonly artifact: EvidenceArtifact }
    | { readonly kind: 'TooLarge' | 'Unavailable' | 'Rejected' }
  >;
}

/** Implemented only in the trusted local parent; workers receive neither key nor plaintext. */
export interface ProtectedCaseCustody {
  seal(input: {
    readonly evaluationId: string;
    readonly objectSaid: string;
    readonly purpose: ProtectedEvaluationArtifact['purpose'];
    readonly segment: number;
    readonly plaintext: Uint8Array;
  }): Promise<
    | { readonly kind: 'Sealed'; readonly artifact: ProtectedEvaluationArtifact }
    | { readonly kind: 'Unavailable' | 'NonceExhausted' | 'Rejected' }
  >;
  open(input: {
    readonly artifact: ProtectedEvaluationArtifact;
    readonly evaluationId: string;
    readonly objectSaid: string;
    readonly purpose: ProtectedEvaluationArtifact['purpose'];
    readonly segment: number;
  }): Promise<
    | { readonly kind: 'Opened'; readonly plaintext: Uint8Array }
    | { readonly kind: 'Rejected' | 'KeyUnavailable' | 'Corrupt' }
  >;
}
