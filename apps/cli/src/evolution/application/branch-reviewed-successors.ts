import { decodeBaselineHarnessRevision, decodeEvolutionHypothesis } from '@devrandom/protocol';
import {
  materializeSuccessor,
  type ExecutableSuccessorDescriptor,
  type ExactTreatmentArtifact,
  type SuccessorPublicReplay,
  type SuccessorTreatmentReview,
} from '@devrandom/runtime';

import type {
  CandidateArm,
  CandidateBranchCustody,
  CandidateBranchDisposition,
} from './candidate-branch-custody.js';

const arms: readonly CandidateArm[] = ['C1', 'C2', 'C3'];

export interface ReviewedSuccessorCandidate {
  readonly arm: CandidateArm;
  readonly successorBytes: Uint8Array;
  readonly configuration: ExactTreatmentArtifact;
  readonly implementation?: ExactTreatmentArtifact;
  readonly replay?: ExactTreatmentArtifact;
}

export interface BranchReviewedSuccessorsInput {
  readonly h1Bytes: Uint8Array;
  readonly h0Bytes: Uint8Array;
  readonly executionProfileSaid: string;
  readonly repositoryDirectory: string;
  readonly stateRoot: string;
  readonly candidates: readonly ReviewedSuccessorCandidate[];
  readonly signal: AbortSignal;
}

export type ReviewedSuccessorBranches =
  | {
      readonly kind: 'Branched' | 'Reconciled';
      readonly readiness: 'AwaitingRuntimeBinding';
      readonly descriptors: readonly ExecutableSuccessorDescriptor[];
      readonly branches: Extract<
        CandidateBranchDisposition,
        { kind: 'Branched' | 'Reconciled' }
      >['branches'];
    }
  | { readonly kind: 'Partial'; readonly reason: 'GitUnavailable' | 'CustodyConflict' }
  | {
      readonly kind: 'Blocked';
      readonly reason: 'H1' | 'H0' | 'CandidateSet' | 'Materialization' | 'Custody';
    };

function canonicalDocument(bytes: Uint8Array, maximumBytes: number): unknown {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > maximumBytes)
    return undefined;
  try {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const document: unknown = JSON.parse(source);
    return JSON.stringify(document) === source ? document : undefined;
  } catch {
    return undefined;
  }
}

/** Trusted parent admission: three reviewed deltas before any Git effect. */
export async function branchReviewedSuccessors(
  input: BranchReviewedSuccessorsInput,
  ports: {
    readonly treatmentReview: SuccessorTreatmentReview;
    readonly publicReplay: SuccessorPublicReplay;
    readonly branches: CandidateBranchCustody;
  },
): Promise<ReviewedSuccessorBranches> {
  const h1Bytes = Uint8Array.from(input.h1Bytes);
  const h0Bytes = Uint8Array.from(input.h0Bytes);
  const candidates = input.candidates.map((candidate) => ({
    arm: candidate.arm,
    successorBytes: Uint8Array.from(candidate.successorBytes),
    configuration: {
      artifact: structuredClone(candidate.configuration.artifact),
      bytes: Uint8Array.from(candidate.configuration.bytes),
    },
    ...(candidate.implementation === undefined
      ? {}
      : {
          implementation: {
            artifact: structuredClone(candidate.implementation.artifact),
            bytes: Uint8Array.from(candidate.implementation.bytes),
          },
        }),
    ...(candidate.replay === undefined
      ? {}
      : {
          replay: {
            artifact: structuredClone(candidate.replay.artifact),
            bytes: Uint8Array.from(candidate.replay.bytes),
          },
        }),
  }));
  const decodedH1 = decodeBaselineHarnessRevision(canonicalDocument(h1Bytes, 512 * 1_024));
  if (decodedH1.kind !== 'Accepted') return { kind: 'Blocked', reason: 'H1' };
  const decodedH0 = decodeEvolutionHypothesis(canonicalDocument(h0Bytes, 16 * 1_024));
  if (decodedH0.kind !== 'Accepted') return { kind: 'Blocked', reason: 'H0' };
  const h1 = decodedH1.revision;
  const h0 = decodedH0.hypothesis;
  if (
    h0.parentRevisionSaid !== h1.d ||
    h0.taskId !== h1.task.taskId ||
    h0.taskRevisionSaid !== h1.task.revisionSaid ||
    h0.personalAgentAid !== h1.authority.personalAgentAid
  )
    return { kind: 'Blocked', reason: 'H0' };
  if (
    input.signal.aborted ||
    candidates.length !== 3 ||
    candidates.some((candidate, index) => candidate.arm !== arms[index])
  )
    return { kind: 'Blocked', reason: 'CandidateSet' };

  const descriptors: ExecutableSuccessorDescriptor[] = [];
  for (const candidate of candidates) {
    const materialized = await materializeSuccessor(
      {
        expected: {
          parentRevisionSaid: h1.d,
          arm: candidate.arm,
          h0Said: h0.d,
          taskRevisionSaid: h1.task.revisionSaid,
          sourceInventorySaid: h0.sourceInventorySaid,
          executionProfileSaid: input.executionProfileSaid,
        },
        h1Bytes,
        successorBytes: candidate.successorBytes,
        configuration: candidate.configuration,
        ...(candidate.implementation === undefined
          ? {}
          : { implementation: candidate.implementation }),
        ...(candidate.replay === undefined ? {} : { replay: candidate.replay }),
      },
      ports,
    );
    if (materialized.kind !== 'Materialized') return { kind: 'Blocked', reason: 'Materialization' };
    descriptors.push(materialized.descriptor);
  }
  const reviewedTreatments = candidates.map((candidate, index) => {
    const descriptor = descriptors[index];
    if (descriptor === undefined) return undefined;
    return {
      arm: candidate.arm,
      successorRevisionSaid: descriptor.successorRevisionSaid,
      configuration: candidate.configuration,
      ...(candidate.implementation === undefined
        ? {}
        : { implementation: candidate.implementation }),
    };
  });
  if (reviewedTreatments.some((candidate) => candidate === undefined))
    return { kind: 'Blocked', reason: 'CandidateSet' };
  const disposition = await ports.branches.branchSiblings({
    repositoryDirectory: input.repositoryDirectory,
    stateRoot: input.stateRoot,
    h1Repository: {
      objectFormat: h1.repository.objectFormat,
      commit: h1.repository.commit,
      tree: h1.repository.tree,
    },
    h0Said: h0.d,
    candidates: reviewedTreatments.filter((candidate) => candidate !== undefined),
    signal: input.signal,
  });
  if (disposition.kind === 'Partial') return { kind: 'Partial', reason: disposition.reason };
  if (disposition.kind === 'Blocked') return { kind: 'Blocked', reason: 'Custody' };
  if (
    disposition.branches.length !== 3 ||
    disposition.branches.some(
      (branch, index) =>
        branch.arm !== arms[index] ||
        branch.parentCommit !== h1.repository.commit ||
        branch.commit === branch.parentCommit ||
        branch.tree === h1.repository.tree,
    )
  )
    return { kind: 'Blocked', reason: 'Custody' };
  return {
    kind: disposition.kind,
    readiness: 'AwaitingRuntimeBinding',
    descriptors,
    branches: disposition.branches,
  };
}
