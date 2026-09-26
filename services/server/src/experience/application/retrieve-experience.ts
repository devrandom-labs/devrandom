import type { EvolutionSourceScope } from '@devrandom/domain';
import { experienceQuerySchema } from '@devrandom/protocol';
import type Type from 'typebox';
import Value from 'typebox/value';

export type ExperienceQuery = Type.Static<typeof experienceQuerySchema>;
export type ExperienceRetrievalOutcome =
  | {
      readonly kind: 'Retrieved';
      readonly sources: readonly {
        readonly episodeSaid: string;
        readonly rawEvidenceSaid: string;
        readonly score: number;
      }[];
      readonly queryReceiptSaid: string;
      readonly chargedMicroUsd: number;
    }
  | { readonly kind: 'Denied' | 'Unavailable' | 'IndexNotReady' | 'Irrelevant' };

export interface ExperienceScopes {
  inspect(input: {
    readonly ownerAid: string;
    readonly taskId: string;
    readonly sourceInventorySaid: string;
  }): Promise<
    | { readonly kind: 'Authorized'; readonly scope: EvolutionSourceScope }
    | { readonly kind: 'Denied' | 'Unavailable' }
  >;
}

/** Only the server adapter may embed text and query Atlas; callers supply no vector. */
export interface AnalogousExperience {
  retrieve(input: {
    readonly ownerAid: string;
    readonly query: ExperienceQuery;
    readonly scope: EvolutionSourceScope;
  }): Promise<ExperienceRetrievalOutcome>;
}

export async function retrieveExperience(
  input: { readonly ownerAid: string; readonly query: unknown },
  dependencies: { readonly scopes: ExperienceScopes; readonly experience: AnalogousExperience },
): Promise<ExperienceRetrievalOutcome> {
  if (!Value.Check(experienceQuerySchema, input.query) || input.ownerAid.length === 0)
    return { kind: 'Denied' };
  const authorization = await dependencies.scopes.inspect({
    ownerAid: input.ownerAid,
    taskId: input.query.taskId,
    sourceInventorySaid: input.query.sourceInventorySaid,
  });
  if (authorization.kind !== 'Authorized') return authorization;
  if (
    authorization.scope.ownerAid !== input.ownerAid ||
    authorization.scope.taskId !== input.query.taskId ||
    authorization.scope.mandate.kind !== 'AuthorizedExperience'
  )
    return { kind: 'Denied' };
  return dependencies.experience.retrieve({
    ownerAid: input.ownerAid,
    query: input.query,
    scope: authorization.scope,
  });
}
