import {
  decodeEvaluationClosure,
  decodeEvaluationClosureEvidenceIndex,
  decodeEvidenceArtifact,
  type EvidenceArtifact,
  type EvaluationClosure,
} from '@devrandom/protocol';

/** Raw signed-index custody is separate from the accepted Evaluation event stream. */
export interface EvaluationClosureIndexCustody {
  readonly artifact: EvidenceArtifact;
  readonly bytes: Uint8Array;
}

export type EvaluationClosureOutcome =
  | { readonly kind: 'Closed' | 'AlreadyClosed'; readonly closureSaid: string }
  | { readonly kind: 'Conflict' | 'Incomplete' | 'Denied' | 'Unavailable' };

/** A closure SAID alone is not an agent signature or a locked-M authority check. */
export interface EvaluationClosureAuthority {
  verify(input: {
    readonly ownerAid: string;
    readonly closure: EvaluationClosure;
  }): Promise<{ readonly kind: 'Authorized' | 'Denied' | 'Unavailable' }>;
}

export interface EvaluationClosures {
  reconcile(input: {
    readonly ownerAid: string;
    readonly closure: EvaluationClosure;
    readonly evidenceIndex: EvaluationClosureIndexCustody;
  }): Promise<
    | { readonly kind: 'AlreadyClosed'; readonly closureSaid: string }
    | { readonly kind: 'NotFound' | 'Conflict' | 'Unavailable' }
  >;
  close(input: {
    readonly ownerAid: string;
    readonly expectedEvaluationVersion: number;
    readonly closure: EvaluationClosure;
    readonly evidenceIndex: EvaluationClosureIndexCustody;
  }): Promise<Exclude<EvaluationClosureOutcome, { kind: 'Denied' }>>;
}

export async function closeEvaluation(
  input: {
    readonly ownerAid: string;
    readonly expectedEvaluationVersion: number;
    readonly closure: EvaluationClosure;
    readonly evidenceIndex: EvaluationClosureIndexCustody;
  },
  dependencies: {
    readonly authority: EvaluationClosureAuthority;
    readonly closures: EvaluationClosures;
  },
): Promise<EvaluationClosureOutcome> {
  if (
    decodeEvaluationClosure(input.closure).kind !== 'Accepted' ||
    !Number.isSafeInteger(input.expectedEvaluationVersion) ||
    input.expectedEvaluationVersion < 1 ||
    input.evidenceIndex.bytes.byteLength > 128 * 1_024 ||
    input.evidenceIndex.artifact.d !== input.closure.evidenceIndexSaid ||
    decodeEvidenceArtifact(input.evidenceIndex.artifact, input.evidenceIndex.bytes).kind !==
      'Accepted' ||
    decodeEvaluationClosureEvidenceIndex(input.evidenceIndex.artifact, input.evidenceIndex.bytes)
      .kind !== 'Accepted'
  )
    return { kind: 'Incomplete' };
  const prior = await dependencies.closures.reconcile({
    ownerAid: input.ownerAid,
    closure: input.closure,
    evidenceIndex: input.evidenceIndex,
  });
  if (prior.kind === 'AlreadyClosed') return prior;
  if (prior.kind === 'Conflict' || prior.kind === 'Unavailable') return { kind: prior.kind };
  const authority = await dependencies.authority.verify({
    ownerAid: input.ownerAid,
    closure: input.closure,
  });
  if (authority.kind === 'Denied') return { kind: 'Denied' };
  if (authority.kind === 'Unavailable') return { kind: 'Unavailable' };
  return dependencies.closures.close(input);
}
