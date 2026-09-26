import {
  prepareTaskCommand,
  type PreparedTaskCommand,
  type TaskSourceCommand,
} from '@devrandom/protocol';

export const taskOwnerAid = `E${'a'.repeat(43)}`;
export const taskCredentialSaid = `E${'b'.repeat(43)}`;

const budgets = Object.freeze({
  workAccessAttemptLifetimeSeconds: 300,
  workAccessGrantLifetimeSeconds: 1_800,
  nonterminalAttemptsPerUserClient: 2,
  activeGrantsPerUserClient: 2,
  publicAttemptCreationsPerMinutePerLoopbackSource: 20,
  nonterminalAttemptsGlobally: 32,
  requestsPerGrant: 2_000,
  tasksPerAdmittedUser: 4,
  runsPerAdmittedUser: 4,
  activeRunsPerAdmittedUser: 1,
  hostedWorkTasksGlobally: 16,
  hostedWorkRunsGlobally: 16,
  activeHostedWorkRunsGlobally: 1,
  ordinaryJsonRequestBodyBytes: 262_144,
  evidenceBatchBodyBytes: 262_144,
  artifactRequestBodyBytes: 589_824,
  evidencePlusArtifactsPerRunBytes: 67_108_864,
  acceptedEvidencePlusArtifactsGloballyBytes: 268_435_456,
  runWallTimeSeconds: 3_600,
  providerRequests: 50,
  providerInputTokens: 500_000,
  providerOutputTokens: 100_000,
  toolProposals: 500,
  aggregateChildCommandTimeSeconds: 1_800,
  oneChildCommandTimeSeconds: 300,
  changedFiles: 256,
  changedWorktreeBytes: 16_777_216,
  providerSpendMicroUsd: 5_000_000,
});

export function taskCommandFixture(
  expiresAt = '2026-09-24T14:00:00.000Z',
  commandId = '11111111-1111-4111-8111-111111111111',
  label = 'compatibility-fix',
  objective = 'Make the selected public condition pass.',
  toolCommands?: TaskSourceCommand['toolCommands'],
): PreparedTaskCommand {
  const source: TaskSourceCommand = {
    version: 1,
    label,
    title: 'Repair the compatibility fixture',
    objective,
    repository: { kind: 'currentHead' },
    deliverables: [{ kind: 'repositoryFile', id: 'implementation', path: 'src/index.ts' }],
    completionConditions: [
      {
        id: 'public-check',
        argv: ['just', 'test'],
        timeoutSeconds: 300,
        expected: { kind: 'exitCode', code: 0 },
      },
    ],
    ...(toolCommands === undefined ? {} : { toolCommands }),
    constraints: {
      protectedPaths: ['.devrandom'],
      prohibitedEffects: ['NetworkAccess'],
      dataPolicy: 'RepositoryContentOnly',
    },
    requestedCapabilities: [
      'ReadRepository',
      'EditRepository',
      'RunTests',
      ...new Set((toolCommands ?? []).map((command) => command.capability)),
    ],
    unavailableCapabilities: [],
    budgets,
    expiresAt,
    evolutionClasses: ['C1'],
    checkpointExpectations: [
      { kind: 'deliverable', deliverableId: 'implementation' },
      { kind: 'completionCondition', completionConditionId: 'public-check' },
    ],
  };
  const preparation = prepareTaskCommand(source, commandId, {
    objectFormat: 'sha1',
    commit: '1'.repeat(40),
    tree: '2'.repeat(40),
  });
  if (preparation.kind === 'Rejected') {
    throw new Error(`Task fixture was rejected: ${preparation.reason}`);
  }
  return preparation.command;
}
