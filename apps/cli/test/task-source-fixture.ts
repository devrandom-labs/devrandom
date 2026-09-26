import {
  prepareTaskCommand,
  taskBudgetCeilings,
  type PreparedRepository,
  type PreparedTaskCommand,
  type TaskProjection,
  type TaskSourceCommand,
} from '@devrandom/protocol';

export const preparedRepositoryFixture: PreparedRepository = {
  objectFormat: 'sha1',
  commit: '1111111111111111111111111111111111111111',
  tree: '2222222222222222222222222222222222222222',
};

export function taskSourceFixture(): TaskSourceCommand {
  return {
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
      protectedPaths: ['secrets/local.json'],
      prohibitedEffects: ['CredentialAccess'],
      dataPolicy: 'RepositoryContentOnly',
    },
    requestedCapabilities: ['ReadRepository', 'RunTests', 'SubmitResult'],
    unavailableCapabilities: ['EditRepository'],
    budgets: { ...taskBudgetCeilings },
    expiresAt: '2026-09-24T22:00:00.000Z',
    evolutionClasses: ['C1'],
    checkpointExpectations: [{ kind: 'completionCondition', completionConditionId: 'public-test' }],
  };
}

export function preparedTaskCommandFixture(): PreparedTaskCommand {
  const prepared = prepareTaskCommand(
    taskSourceFixture(),
    '97e16745-4b76-4de3-9ae5-a183496e73e8',
    preparedRepositoryFixture,
  );
  if (prepared.kind !== 'Prepared') {
    throw new Error(`expected Task command fixture to prepare: ${prepared.reason}`);
  }
  return prepared.command;
}

export function taskProjectionFixture(
  prepared: PreparedTaskCommand = preparedTaskCommandFixture(),
): TaskProjection {
  return {
    version: 1,
    taskId: '4df838a8-5109-49fd-bdad-805880a3ecee',
    ownerAid: 'EMstL6Th90iB6MpQkPjKN2ii7a5XcvA_PCHWHrAAD-l4',
    label: prepared.label,
    harnessLineageId: 'd9cb18e4-f4f8-4378-a852-353eef083d91',
    revisionSaid: prepared.revision.d,
    lifecycle: { kind: 'Open' },
    commandId: prepared.commandId,
    createdAt: '2026-09-24T18:00:00.000Z',
    expectedVersion: 0,
    revision: prepared.revision,
  };
}
