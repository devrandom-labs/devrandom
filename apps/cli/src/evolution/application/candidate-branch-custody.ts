import type { EvidenceArtifact } from '@devrandom/protocol';

export type CandidateArm = 'C1' | 'C2' | 'C3';

export interface ExactCandidateArtifact {
  readonly artifact: EvidenceArtifact;
  readonly bytes: Uint8Array;
}

export interface ReviewedCandidateTreatment {
  readonly arm: CandidateArm;
  readonly successorRevisionSaid: string;
  readonly configuration: ExactCandidateArtifact;
  readonly implementation?: ExactCandidateArtifact;
}

export interface CandidateBranchCommand {
  readonly repositoryDirectory: string;
  readonly stateRoot: string;
  readonly h1Repository: {
    readonly objectFormat: 'sha1' | 'sha256';
    readonly commit: string;
    readonly tree: string;
  };
  readonly h0Said: string;
  readonly candidates: readonly ReviewedCandidateTreatment[];
  readonly signal: AbortSignal;
}

export interface CandidateBranchReceipt {
  readonly arm: CandidateArm;
  readonly branch: string;
  readonly directory: string;
  readonly parentCommit: string;
  readonly commit: string;
  readonly tree: string;
}

export type CandidateBranchDisposition =
  | {
      readonly kind: 'Branched' | 'Reconciled';
      readonly readiness: 'AwaitingRuntimeBinding';
      readonly branches: readonly CandidateBranchReceipt[];
    }
  | {
      readonly kind: 'Partial';
      readonly reason: 'GitUnavailable' | 'CustodyConflict';
      readonly branches: readonly CandidateBranchReceipt[];
    }
  | {
      readonly kind: 'Blocked';
      readonly reason: 'Input' | 'Repository' | 'Artifact' | 'CustodyConflict' | 'GitUnavailable';
    };

/** One purposeful conversation: establish and reconcile immutable treatment siblings. */
export interface CandidateBranchCustody {
  branchSiblings(command: CandidateBranchCommand): Promise<CandidateBranchDisposition>;
}
