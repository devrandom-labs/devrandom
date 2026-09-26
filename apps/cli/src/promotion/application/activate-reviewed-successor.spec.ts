import { taskEvaluationBudgetCeilings } from '@devrandom/domain';
import { prepareTaskCommandV2 } from '@devrandom/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
  preparedRepositoryFixture,
  taskProjectionFixture,
  taskSourceFixture,
} from '../../../test/task-source-fixture.js';
import { activateReviewedSuccessor } from './activate-reviewed-successor.js';

const said = (letter: string) => `E${letter.repeat(43)}`;

function task() {
  const source = taskSourceFixture();
  const prepared = prepareTaskCommandV2(
    {
      ...source,
      version: 2,
      constraints: {
        ...source.constraints,
        dataPolicy: 'RepositoryAndAuthorizedTaskExperience',
        experience: {
          corpusSaid: said('c'),
          repositoryResourceSaid: said('r'),
          disclosure: 'AuthorizedAnalogy',
        },
      },
      requestedCapabilities: [...source.requestedCapabilities, 'ReadTaskMemory'],
      budgets: { ...taskEvaluationBudgetCeilings },
    },
    '97e16745-4b76-4de3-9ae5-a183496e73e8',
    preparedRepositoryFixture,
  );
  if (prepared.kind !== 'Prepared') throw new Error('v2 Task fixture rejected');
  return {
    ...taskProjectionFixture(),
    revision: prepared.command.revision,
    revisionSaid: prepared.command.revision.d,
  };
}

describe('public governed promotion admission', () => {
  it('refuses a stale or cross-Task active pointer before reading evidence or signing', async () => {
    const currentTask = task();
    const inspectEvidence = vi.fn(() => Promise.resolve({ kind: 'Incomplete' as const }));
    const pointer = {
      version: 1 as const,
      kind: 'Initial' as const,
      taskId: currentTask.taskId,
      taskRevisionSaid: said('z'),
      harnessLineageId: currentTask.harnessLineageId,
      activeRevisionSaid: said('h'),
      pointerVersion: 1 as const,
    };
    const input = {
      task: currentTask,
      commandId: '6eb93221-1ad0-4555-9aa3-b2ff2ed541a6',
      closureSaid: said('e'),
      governorAid: said('g'),
    };
    const ports = {
      pointer: { inspect: () => Promise.resolve({ kind: 'Observed' as const, pointer }) },
      authorization: {
        evidence: { inspect: inspectEvidence },
        authority: { verify: () => Promise.reject(new Error('must not authorize')) },
        agent: { sign: () => Promise.reject(new Error('must not sign')) },
        governor: { sign: () => Promise.reject(new Error('must not sign')) },
        commands: {
          inspect: () => Promise.reject(new Error('must not inspect command')),
          stage: () => Promise.reject(new Error('must not stage command')),
        },
        hosted: { commit: () => Promise.reject(new Error('must not commit')) },
        routing: { activate: () => Promise.reject(new Error('must not route')) },
      },
    };
    expect(await activateReviewedSuccessor(input, ports)).toEqual({
      kind: 'Blocked',
      reason: 'PointerMismatch',
    });
    expect(inspectEvidence).not.toHaveBeenCalled();
    expect(
      await activateReviewedSuccessor(input, {
        ...ports,
        pointer: {
          inspect: () =>
            Promise.resolve({
              kind: 'Observed' as const,
              pointer: { ...pointer, taskRevisionSaid: currentTask.revisionSaid },
            }),
        },
      }),
    ).toEqual({ kind: 'Blocked', reason: 'EvidenceIncomplete' });
    expect(inspectEvidence).toHaveBeenCalledOnce();
  });
});
