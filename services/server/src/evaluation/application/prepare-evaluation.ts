import { assessSourceExposure, type EvolutionSourceScope } from '@devrandom/domain';
import {
  decodeEvaluationExecutionProfile,
  decodeEvaluationSourceInventory,
  evaluationPreparationCommandSchema,
} from '@devrandom/protocol';
import type Type from 'typebox';
import Value from 'typebox/value';

export type EvaluationPreparationCommand = Type.Static<typeof evaluationPreparationCommandSchema>;

/** Resolved from current Task and Mandate authority, never the prepared inventory. */
export interface EvaluationPreparationScopes {
  inspect(input: {
    readonly ownerAid: string;
    readonly taskId: string;
  }): Promise<
    | { readonly kind: 'Authorized'; readonly scope: EvolutionSourceScope }
    | { readonly kind: 'Denied' | 'Unavailable' }
  >;
}

export interface EvaluationPreparationStorage {
  store(input: {
    readonly ownerAid: string;
    readonly command: EvaluationPreparationCommand;
  }): Promise<'Prepared' | 'AlreadyPrepared' | 'Rejected' | 'Conflict' | 'Unavailable'>;
}

export interface EvaluationPreparations {
  prepare(input: {
    readonly ownerAid: string;
    readonly command: EvaluationPreparationCommand;
  }): Promise<'Prepared' | 'AlreadyPrepared' | 'Rejected' | 'Conflict' | 'Unavailable'>;
}

export async function prepareEvaluation(
  input: { readonly ownerAid: string; readonly command: unknown },
  dependencies: {
    readonly scopes: EvaluationPreparationScopes;
    readonly storage: EvaluationPreparationStorage;
  },
): Promise<'Prepared' | 'AlreadyPrepared' | 'Rejected' | 'Conflict' | 'Unavailable'> {
  if (!Value.Check(evaluationPreparationCommandSchema, input.command)) return 'Rejected';
  const { sourceInventory, executionProfile } = input.command;
  if (
    decodeEvaluationSourceInventory(sourceInventory).kind !== 'Accepted' ||
    decodeEvaluationExecutionProfile(executionProfile).kind !== 'Accepted' ||
    sourceInventory.ownerAid !== input.ownerAid ||
    sourceInventory.taskId !== input.command.taskId ||
    sourceInventory.taskRevisionSaid !== input.command.taskRevisionSaid
  )
    return 'Rejected';
  const authority = await dependencies.scopes.inspect({
    ownerAid: input.ownerAid,
    taskId: input.command.taskId,
  });
  if (authority.kind !== 'Authorized')
    return authority.kind === 'Unavailable' ? 'Unavailable' : 'Rejected';
  const scope = authority.scope;
  if (
    scope.ownerAid !== input.ownerAid ||
    scope.taskId !== input.command.taskId ||
    scope.taskRevisionSaid !== input.command.taskRevisionSaid ||
    scope.repositoryResourceSaid !== sourceInventory.repositoryResourceSaid ||
    scope.allowedCorpusSaid !== sourceInventory.corpusSaid ||
    scope.mandate.kind !== 'AuthorizedExperience' ||
    scope.mandate.mandateSaid !== sourceInventory.experienceMandateSaid ||
    sourceInventory.sources.some(
      (source) =>
        assessSourceExposure(scope, { kind: 'AnalogousEpisode', ...source }).kind !== 'Allowed',
    )
  )
    return 'Rejected';
  return dependencies.storage.store({ ownerAid: input.ownerAid, command: input.command });
}
