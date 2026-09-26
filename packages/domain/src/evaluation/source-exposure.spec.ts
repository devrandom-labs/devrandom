import { describe, expect, it } from 'vitest';

import { assessSourceExposure } from './source-exposure.js';

const rights = {
  ownerAid: 'owner',
  taskId: 'task',
  taskRevisionSaid: 'revision',
  repositoryResourceSaid: 'repository',
  allowedCorpusSaid: 'corpus',
  mandate: { kind: 'AuthorizedExperience' as const, mandateSaid: 'mandate' },
};

const source = {
  kind: 'AnalogousEpisode' as const,
  ownerAid: 'owner',
  repositoryResourceSaid: 'repository',
  corpusSaid: 'corpus',
  rawEvidenceSaid: 'raw',
  disclosure: 'AuthorizedAnalogy' as const,
};

describe('evolution source exposure', () => {
  it('requires the exact authorized owner, repository, corpus and disclosure class', () => {
    expect(assessSourceExposure(rights, source)).toEqual({ kind: 'Allowed' });
    expect(assessSourceExposure(rights, { ...source, ownerAid: 'other' })).toEqual({
      kind: 'Denied',
      reason: 'OwnerMismatch',
    });
    expect(assessSourceExposure(rights, { ...source, corpusSaid: 'other' })).toEqual({
      kind: 'Denied',
      reason: 'CorpusMismatch',
    });
    expect(assessSourceExposure(rights, { ...source, disclosure: 'Protected' })).toEqual({
      kind: 'Denied',
      reason: 'DisclosureDenied',
    });
  });

  it('does not treat RepositoryContentOnly as memory authority', () => {
    expect(
      assessSourceExposure({ ...rights, mandate: { kind: 'RepositoryContentOnly' } }, source),
    ).toEqual({ kind: 'Denied', reason: 'ExperienceNotAuthorized' });
  });

  it('permits exact repository evidence without admitting historical memory', () => {
    expect(
      assessSourceExposure(
        { ...rights, mandate: { kind: 'RepositoryContentOnly' } },
        {
          kind: 'Repository',
          taskId: 'task',
          taskRevisionSaid: 'revision',
          repositoryResourceSaid: 'repository',
        },
      ),
    ).toEqual({ kind: 'Allowed' });
  });
});
