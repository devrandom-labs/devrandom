export type EvolutionSourceRight =
  | { readonly kind: 'RepositoryContentOnly' }
  | { readonly kind: 'AuthorizedExperience'; readonly mandateSaid: string };

/** Rights are derived from current Task/Mandate verification, never caller command fields. */
export interface EvolutionSourceScope {
  readonly ownerAid: string;
  readonly taskId: string;
  readonly taskRevisionSaid: string;
  readonly repositoryResourceSaid: string;
  readonly allowedCorpusSaid: string;
  readonly mandate: EvolutionSourceRight;
}

export type EvolutionSource =
  | {
      readonly kind: 'Repository';
      readonly taskId: string;
      readonly taskRevisionSaid: string;
      readonly repositoryResourceSaid: string;
    }
  | {
      readonly kind: 'AnalogousEpisode';
      readonly ownerAid: string;
      readonly repositoryResourceSaid: string;
      readonly corpusSaid: string;
      readonly rawEvidenceSaid: string;
      readonly disclosure: 'AuthorizedAnalogy' | 'TaskPrivate' | 'Protected';
    };

export type SourceExposure =
  | { readonly kind: 'Allowed' }
  | {
      readonly kind: 'Denied';
      readonly reason:
        | 'IdentityInvalid'
        | 'TaskMismatch'
        | 'OwnerMismatch'
        | 'ResourceMismatch'
        | 'CorpusMismatch'
        | 'ExperienceNotAuthorized'
        | 'DisclosureDenied';
    };

export function assessSourceExposure(
  scope: EvolutionSourceScope,
  source: EvolutionSource,
): SourceExposure {
  if (
    [scope.ownerAid, scope.taskId, scope.taskRevisionSaid, scope.repositoryResourceSaid].some(
      (value) => value.length === 0,
    )
  )
    return { kind: 'Denied', reason: 'IdentityInvalid' };
  if (source.repositoryResourceSaid !== scope.repositoryResourceSaid)
    return { kind: 'Denied', reason: 'ResourceMismatch' };
  if (source.kind === 'Repository') {
    return source.taskId === scope.taskId && source.taskRevisionSaid === scope.taskRevisionSaid
      ? { kind: 'Allowed' }
      : { kind: 'Denied', reason: 'TaskMismatch' };
  }
  if (scope.mandate.kind !== 'AuthorizedExperience' || scope.mandate.mandateSaid.length === 0)
    return { kind: 'Denied', reason: 'ExperienceNotAuthorized' };
  if (source.ownerAid !== scope.ownerAid) return { kind: 'Denied', reason: 'OwnerMismatch' };
  if (source.corpusSaid !== scope.allowedCorpusSaid || source.rawEvidenceSaid.length === 0)
    return { kind: 'Denied', reason: 'CorpusMismatch' };
  if (source.disclosure !== 'AuthorizedAnalogy')
    return { kind: 'Denied', reason: 'DisclosureDenied' };
  return { kind: 'Allowed' };
}
