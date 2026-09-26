import { decodeEvaluationClosure, type EvaluationClosure } from '@devrandom/protocol';

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
  close(input: {
    readonly ownerAid: string;
    readonly expectedEvaluationVersion: number;
    readonly closure: EvaluationClosure;
  }): Promise<Exclude<EvaluationClosureOutcome, { kind: 'Denied' }>>;
}

export async function closeEvaluation(
  input: {
    readonly ownerAid: string;
    readonly expectedEvaluationVersion: number;
    readonly closure: EvaluationClosure;
  },
  dependencies: {
    readonly authority: EvaluationClosureAuthority;
    readonly closures: EvaluationClosures;
  },
): Promise<EvaluationClosureOutcome> {
  if (
    decodeEvaluationClosure(input.closure).kind !== 'Accepted' ||
    !Number.isSafeInteger(input.expectedEvaluationVersion) ||
    input.expectedEvaluationVersion < 1
  )
    return { kind: 'Incomplete' };
  const authority = await dependencies.authority.verify({
    ownerAid: input.ownerAid,
    closure: input.closure,
  });
  if (authority.kind === 'Denied') return { kind: 'Denied' };
  if (authority.kind === 'Unavailable') return { kind: 'Unavailable' };
  return dependencies.closures.close(input);
}
