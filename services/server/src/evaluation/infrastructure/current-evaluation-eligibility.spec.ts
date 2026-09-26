import type { Db } from 'mongodb';
import { describe, expect, it, vi } from 'vitest';

import type { EvaluationEligibility } from '../application/admit-evaluation.js';
import type { CurrentEvaluationSourceScopes } from './current-evaluation-source-scopes.js';
import { CurrentEvaluationEligibility } from './current-evaluation-eligibility.js';
import { evaluationCollectionNames } from './mongo-evaluation-reservations.js';

const said = (letter: string): string => `E${letter.repeat(43)}`;
const ownerAid = said('o');
const taskId = '4df838a8-5109-49fd-bdad-805880a3ecee';
const originRunId = '1cc482f1-98e9-4454-8e4c-5566cb47ce3d';

describe('current Evaluation qualification gate', () => {
  it('keeps a verified six-Run qualification behind the independent residual Budget gate', async () => {
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
    const sources = {
      inspectInventory: () =>
        Promise.resolve({
          kind: 'Authorized',
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
    const eligibility = new CurrentEvaluationEligibility(database, sources, qualification);

    await expect(eligibility.inspect({ ownerAid, command })).resolves.toEqual({
      kind: 'Blocked',
      gate: 'Budget',
    });
    expect(qualification.assess).toHaveBeenCalledWith(
      expect.objectContaining({ ownerAid, taskId, retainedRunId: originRunId }),
    );
  });
});
