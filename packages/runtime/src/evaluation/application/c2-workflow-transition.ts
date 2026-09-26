import type { EvaluationExecutionBinding, ComparisonSlot } from '@devrandom/domain';
import { prepareEvidenceArtifact, type EvaluationManifest } from '@devrandom/protocol';
import type { ToolGatewayProposal } from '../../tool-gateway/tool-gateway.js';

/** A parent-owned conversation. Its implementation must exact-read the reviewed C2
 * Git treatment and the qualified Q/H0 window, then perform scoped retrieval,
 * exact raw read and independent choice recalculation before returning Prepared. */
export interface C2WorkflowTransition {
  prepare(input: {
    readonly binding: EvaluationExecutionBinding;
    readonly manifest: EvaluationManifest;
    readonly slot: ComparisonSlot;
    readonly successorRevisionSaid: string;
    readonly candidateCommit: string;
    readonly candidateTree: string;
    readonly signal: AbortSignal;
  }): Promise<
    | {
        readonly kind: 'Prepared';
        readonly manifestSaid: string;
        readonly successorRevisionSaid: string;
        readonly hypothesisSaid: string;
        readonly sourceInventorySaid: string;
        readonly failureWindowSaid: string;
        readonly queryReceiptSaid: string;
        readonly readReceiptSaid: string;
        readonly sourceEvidenceSaid: string;
        readonly withSourceChoiceSaid: string;
        readonly withSourceAction: string;
        readonly withoutSource:
          | { readonly kind: 'Chosen'; readonly action: string; readonly sourceChoiceSaid: string }
          | { readonly kind: 'Unsupported'; readonly sourceSpecificTo: string };
        /** Parent-reviewed bounded context, never raw or protected source bytes. */
        readonly contextText: string;
      }
    | { readonly kind: 'Blocked' }
  >;
}

/** The parent checks current SubmitResult authority without allowing its effect yet. */
export interface C2ProvisionalSubmissionAuthority {
  authorize(input: {
    readonly binding: EvaluationExecutionBinding;
    readonly proposal: ToolGatewayProposal;
    readonly signal: AbortSignal;
  }): Promise<{ readonly kind: 'Authorized' } | { readonly kind: 'Denied' }>;
}

/** Called only after the provisional proposal has stopped all compartment writers
 * and SourceCustody has frozen the exact source. The original public conditions,
 * native build and verifier are required; child claims are not a verdict. */
export interface C2StoppedSubmissionVerification {
  verify(input: {
    readonly binding: EvaluationExecutionBinding;
    readonly manifest: EvaluationManifest;
    readonly slot: ComparisonSlot;
    readonly successorRevisionSaid: string;
    readonly proposedArtifactSaids: readonly string[];
    readonly proposalEventSaid: string;
    readonly capturedSourceSaid: string;
    readonly signal: AbortSignal;
  }): Promise<
    | {
        readonly kind: 'Verified';
        readonly capturedSourceSaid: string;
        readonly proposalEventSaid: string;
        readonly publicVerifierReceiptSaid: string;
        readonly receiptBytes: Uint8Array;
      }
    | {
        readonly kind: 'Failed';
        readonly capturedSourceSaid: string;
        readonly proposalEventSaid: string;
        readonly publicVerifierReceiptSaid: string;
        readonly receiptBytes: Uint8Array;
      }
    | { readonly kind: 'Unavailable' }
  >;
}

/** A complete original-public failure is a valid negative observation; absent
 * or identity-swapped proof is not a trial outcome. */
export function assessC2PublicSubmission(
  expected: { readonly capturedSourceSaid: string; readonly proposalEventSaid: string },
  verification: Awaited<ReturnType<C2StoppedSubmissionVerification['verify']>>,
):
  | {
      readonly kind: 'Verified' | 'Negative';
      readonly receiptSaid: string;
      readonly bytes: Uint8Array;
    }
  | { readonly kind: 'Invalid' } {
  if (
    verification.kind === 'Unavailable' ||
    verification.capturedSourceSaid !== expected.capturedSourceSaid ||
    verification.proposalEventSaid !== expected.proposalEventSaid ||
    !(verification.receiptBytes instanceof Uint8Array)
  )
    return { kind: 'Invalid' };
  const prepared = prepareEvidenceArtifact(verification.receiptBytes, 'application/json');
  if (
    prepared.kind !== 'Prepared' ||
    prepared.artifact.d !== verification.publicVerifierReceiptSaid
  )
    return { kind: 'Invalid' };
  return {
    kind: verification.kind === 'Verified' ? 'Verified' : 'Negative',
    receiptSaid: prepared.artifact.d,
    bytes: Uint8Array.from(verification.receiptBytes),
  };
}
