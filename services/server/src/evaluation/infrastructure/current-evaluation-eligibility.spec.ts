import type { Db } from 'mongodb';
import { describe, expect, it, vi } from 'vitest';
import { prepareEvaluationSourceInventory } from '@devrandom/protocol';

import type { EvaluationEligibility } from '../application/admit-evaluation.js';
import type { CurrentEvaluationSourceScopes } from './current-evaluation-source-scopes.js';
import { CurrentEvaluationEligibility } from './current-evaluation-eligibility.js';
import { evaluationCollectionNames } from './mongo-evaluation-reservations.js';

const said = (letter: string): string => `E${letter.repeat(43)}`;
const ownerAid = said('o');
const taskId = '4df838a8-5109-49fd-bdad-805880a3ecee';
const originRunId = '1cc482f1-98e9-4454-8e4c-5566cb47ce3d';

describe('current Evaluation qualification gate', () => {
  it('withholds a qualified reservation until every currently authorized source is indexed from exact raw bytes', async () => {
    const inventory = prepareEvaluationSourceInventory({
      taskId,
      taskRevisionSaid: said('t'),
      ownerAid,
      repositoryResourceSaid: said('r'),
      corpusSaid: said('c'),
      experienceMandateSaid: said('m'),
      sources: [
        {
          episodeSaid: said('x'),
          rawEvidenceSaid: said('y'),
          ownerAid,
          repositoryResourceSaid: said('r'),
          corpusSaid: said('c'),
          disclosure: 'AuthorizedAnalogy',
        },
      ],
    });
    if (inventory.kind !== 'Prepared') throw new Error('source inventory fixture rejected');
    const command = {
      taskId,
      taskRevisionSaid: said('t'),
      sourceInventorySaid: inventory.inventory.d,
      taskMandateSaid: said('m'),
      executionProfileSaid: said('e'),
      originRunId,
      retainedCheckpointSaid: said('p'),
      retainedSealSaid: said('s'),
      expectedActiveRevisionSaid: said('h'),
      personalAgentAid: said('a'),
    } as Parameters<EvaluationEligibility['inspect']>[0]['command'];
    const scope = {
      ownerAid,
      taskId,
      taskRevisionSaid: command.taskRevisionSaid,
      repositoryResourceSaid: said('r'),
      allowedCorpusSaid: said('c'),
      mandate: { kind: 'AuthorizedExperience' as const, mandateSaid: said('m') },
    };
    const sources = {
      inspectInventory: () =>
        Promise.resolve({
          kind: 'Authorized',
          personalAgentAid: command.personalAgentAid,
          verifiedMandateCeiling: budget,
          scope,
        }),
    } as unknown as CurrentEvaluationSourceScopes;
    const database = {
      collection(name: string) {
        if (name !== evaluationCollectionNames.preparations)
          throw new Error(`Unexpected collection ${name}`);
        return {
          findOne: () =>
            Promise.resolve({
              command: { taskRevisionSaid: command.taskRevisionSaid },
              executionProfile: { d: command.executionProfileSaid },
              sourceInventory: inventory.inventory,
            }),
        };
      },
    } as unknown as Db;
    let admission: 'Admitted' | 'Denied' | 'Unavailable' = 'Unavailable';
    const experience = {
      admitSource: vi.fn(() => Promise.resolve(admission)),
    };
    const eligibility = new CurrentEvaluationEligibility(
      database,
      sources,
      { assess: () => Promise.resolve({ kind: 'Qualified' }) },
      { inspect: () => Promise.resolve({ kind: 'Available', remaining: budget }) },
      experience,
    );
    await expect(eligibility.inspect({ ownerAid, command })).resolves.toEqual({
      kind: 'Unavailable',
    });
    expect(experience.admitSource).toHaveBeenCalledWith({
      ownerAid,
      inventory: inventory.inventory,
      episodeSaid: said('x'),
      rawEvidenceSaid: said('y'),
      scope,
    });
    admission = 'Admitted';
    await expect(eligibility.inspect({ ownerAid, command })).resolves.toMatchObject({
      kind: 'Eligible',
    });
    admission = 'Denied';
    await expect(eligibility.inspect({ ownerAid, command })).resolves.toEqual({
      kind: 'Blocked',
      gate: 'Source',
    });
  });

  it('admits only the verified residual under the current mandate ceiling after six-Run qualification', async () => {
    const command = {
      taskId,
      taskRevisionSaid: said('t'),
      sourceInventorySaid: said('i'),
      taskMandateSaid: said('m'),
      executionProfileSaid: said('e'),
      originRunId,
      retainedCheckpointSaid: said('p'),
      retainedSealSaid: said('s'),
      expectedActiveRevisionSaid: said('h'),
      personalAgentAid: said('a'),
    } as Parameters<EvaluationEligibility['inspect']>[0]['command'];
    let sourceAgentAid = command.personalAgentAid;
    const sources = {
      inspectInventory: () =>
        Promise.resolve({
          kind: 'Authorized',
          personalAgentAid: sourceAgentAid,
          verifiedMandateCeiling: { ...budget, providerRequests: 50 },
          scope: {
            taskRevisionSaid: command.taskRevisionSaid,
            mandate: { kind: 'AuthorizedExperience', mandateSaid: command.taskMandateSaid },
          },
        }),
    } as unknown as CurrentEvaluationSourceScopes;
    const database = {
      collection: (name: string) => ({
        findOne: () =>
          Promise.resolve(
            name === evaluationCollectionNames.preparations
              ? {
                  command: { taskRevisionSaid: command.taskRevisionSaid },
                  executionProfile: {
                    d: command.executionProfileSaid,
                    sourceGitCommit: 'a'.repeat(40),
                    sourceGitTree: 'b'.repeat(40),
                  },
                }
              : null,
          ),
      }),
    } as unknown as Db;
    const qualification = { assess: vi.fn().mockResolvedValue({ kind: 'Qualified' }) };
    const residual = {
      inspect: vi.fn().mockResolvedValue({ kind: 'Available', remaining: budget }),
    };
    const eligibility = new CurrentEvaluationEligibility(
      database,
      sources,
      qualification,
      residual,
    );

    await expect(eligibility.inspect({ ownerAid, command })).resolves.toEqual({
      kind: 'Eligible',
      remaining: budget,
      verifiedMandateCeiling: { ...budget, providerRequests: 50 },
    });
    expect(qualification.assess).toHaveBeenCalledWith(
      expect.objectContaining({ ownerAid, taskId, retainedRunId: originRunId }),
    );
    expect(residual.inspect).toHaveBeenCalledWith({
      ownerAid,
      taskId,
      taskRevisionSaid: command.taskRevisionSaid,
      verifiedMandateCeiling: { ...budget, providerRequests: 50 },
    });
    sourceAgentAid = said('x');
    await expect(eligibility.inspect({ ownerAid, command })).resolves.toEqual({
      kind: 'Blocked',
      gate: 'Authority',
    });
  });
});

const budget = {
  providerRequests: 20,
  providerInputTokens: 100,
  providerOutputTokens: 100,
  providerSpendMicroUsd: 100,
  runWallTimeSeconds: 100,
  toolProposals: 100,
  aggregateChildCommandTimeSeconds: 100,
  changedFiles: 100,
  changedWorktreeBytes: 100,
  evidencePlusArtifactsPerRunBytes: 100,
};
