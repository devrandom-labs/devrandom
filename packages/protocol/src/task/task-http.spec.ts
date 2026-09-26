import { Value } from 'typebox/value';
import { describe, expect, it } from 'vitest';

import { prepareTaskCommand, taskBudgetCeilings } from './task-command.js';
import {
  decodeTaskProjection,
  taskLabelParametersSchema,
  taskListQuerySchema,
  taskProblemSchema,
  taskProjectionSchema,
  type TaskProjection,
} from './task-http.js';

function projection(): TaskProjection {
  const preparation = prepareTaskCommand(
    {
      version: 1,
      label: 'repair-parser',
      title: 'Repair the parser',
      objective: 'Make the prepared compatibility fixture pass.',
      repository: { kind: 'currentHead' },
      deliverables: [{ kind: 'repositoryFile', id: 'parser', path: 'src/parser.ts' }],
      completionConditions: [
        {
          id: 'public-test',
          argv: ['just', 'test-public'],
          timeoutSeconds: 120,
          expected: { kind: 'exitCode', code: 0 },
        },
      ],
      constraints: {
        protectedPaths: ['.env'],
        prohibitedEffects: ['CredentialAccess'],
        dataPolicy: 'RepositoryContentOnly',
      },
      requestedCapabilities: ['ReadRepository', 'RunTests'],
      unavailableCapabilities: ['EditRepository'],
      budgets: taskBudgetCeilings,
      expiresAt: '2026-09-24T18:00:00.000Z',
      evolutionClasses: ['C1'],
      checkpointExpectations: [{ kind: 'deliverable', deliverableId: 'parser' }],
    },
    '97e16745-4b76-4de3-9ae5-a183496e73e8',
    {
      objectFormat: 'sha1',
      commit: '1111111111111111111111111111111111111111',
      tree: '2222222222222222222222222222222222222222',
    },
  );
  if (preparation.kind !== 'Prepared') {
    throw new Error(`Task projection fixture was rejected: ${preparation.reason}`);
  }
  return {
    version: 1,
    taskId: '4df838a8-5109-49fd-bdad-805880a3ecee',
    ownerAid: `E${'o'.repeat(43)}`,
    label: preparation.command.label,
    harnessLineageId: '5ebf49b9-df26-4a49-9194-da868f97cf9d',
    revisionSaid: preparation.command.revision.d,
    revision: preparation.command.revision,
    lifecycle: { kind: 'Open' },
    commandId: preparation.command.commandId,
    createdAt: '2026-09-24T14:00:00.000Z',
    expectedVersion: 0,
  };
}

describe('Task HTTP contracts', () => {
  it('bounds list queries and closes label parameters', () => {
    expect(Value.Check(taskListQuerySchema, {})).toBe(true);
    expect(Value.Check(taskListQuerySchema, { limit: 100, cursor: 'opaque-cursor' })).toBe(true);
    expect(Value.Check(taskListQuerySchema, { limit: 101 })).toBe(false);
    expect(Value.Check(taskLabelParametersSchema, { label: 'repair-parser' })).toBe(true);
    expect(
      Value.Check(taskLabelParametersSchema, { label: 'repair-parser', ownerAid: 'untrusted' }),
    ).toBe(false);
  });

  it('admits only the typed Task problem alternatives', () => {
    expect(
      Value.Check(taskProblemSchema, {
        type: 'https://devrandom.example/problems/task-label-conflict',
        title: 'Task label already exists',
        status: 409,
        code: 'TaskLabelConflict',
        correlationId: '4df838a8-5109-49fd-bdad-805880a3ecee',
        label: 'repair-parser',
      }),
    ).toBe(true);
    expect(
      Value.Check(taskProblemSchema, {
        type: 'https://devrandom.example/problems/task-label-conflict',
        title: 'Task label already exists',
        status: 409,
        code: 'TaskLabelConflict',
        correlationId: '4df838a8-5109-49fd-bdad-805880a3ecee',
        label: 'repair-parser',
        metadata: { leaked: true },
      }),
    ).toBe(false);
  });

  it('accepts a projection only when its embedded revision and deadline are valid', () => {
    const task = projection();

    expect(decodeTaskProjection(task)).toEqual({ kind: 'Accepted', projection: task });
  });

  it('rejects an independently valid revision SAID that disagrees with the embedded revision', () => {
    const task = projection();
    const mismatched = { ...task, revisionSaid: `E${'x'.repeat(43)}` };

    expect(Value.Check(taskProjectionSchema, mismatched)).toBe(true);
    expect(decodeTaskProjection(mismatched)).toEqual({
      kind: 'Rejected',
      reason: 'RevisionSaidMismatch',
    });
  });

  it('preserves embedded revision invalidity and rejects an inconsistent deadline', () => {
    const task = projection();
    const invalidRevision = {
      ...task,
      revision: { ...task.revision, objective: 'Changed after SAID assignment.' },
    };

    expect(decodeTaskProjection(invalidRevision)).toEqual({
      kind: 'Rejected',
      reason: 'RevisionInvalid',
      revisionInvalidity: 'SaidMismatch',
    });
    expect(
      decodeTaskProjection({
        ...task,
        createdAt: '2026-09-24T18:00:00.000Z',
      }),
    ).toEqual({ kind: 'Rejected', reason: 'DeadlineInvalid' });
  });

  it.each([
    [{ kind: 'Completed' as const }, 1],
    [{ kind: 'Cancelled' as const }, 7],
  ])(
    'decodes the closed %s lifecycle at its safe aggregate version',
    (lifecycle, expectedVersion) => {
      const task = { ...projection(), lifecycle, expectedVersion };

      expect(Value.Check(taskProjectionSchema, task)).toBe(true);
      expect(decodeTaskProjection(task)).toEqual({ kind: 'Accepted', projection: task });
    },
  );

  it('rejects unsafe, negative, and fractional Task aggregate versions', () => {
    const task = projection();

    expect(Value.Check(taskProjectionSchema, { ...task, expectedVersion: -1 })).toBe(false);
    expect(Value.Check(taskProjectionSchema, { ...task, expectedVersion: 0.5 })).toBe(false);
    expect(
      Value.Check(taskProjectionSchema, {
        ...task,
        expectedVersion: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toBe(false);
  });
});
