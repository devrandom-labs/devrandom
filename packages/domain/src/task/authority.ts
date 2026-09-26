export const taskToolCapabilities: readonly [
  'ReadRepository',
  'EditRepository',
  'RunFormatter',
  'RunStaticAnalysis',
  'RunTests',
  'SubmitResult',
] = Object.freeze([
  'ReadRepository',
  'EditRepository',
  'RunFormatter',
  'RunStaticAnalysis',
  'RunTests',
  'SubmitResult',
]);

export type TaskToolCapability = (typeof taskToolCapabilities)[number];

export const taskEvaluationCapabilities = Object.freeze([
  ...taskToolCapabilities,
  'ReadTaskMemory',
] as const);
export type TaskEvaluationCapability = (typeof taskEvaluationCapabilities)[number];

export const taskEvolutionClasses: readonly ['C1', 'C2', 'C3'] = Object.freeze(['C1', 'C2', 'C3']);

export type TaskEvolutionClass = (typeof taskEvolutionClasses)[number];

export const taskBudgetNames: readonly [
  'workAccessAttemptLifetimeSeconds',
  'workAccessGrantLifetimeSeconds',
  'nonterminalAttemptsPerUserClient',
  'activeGrantsPerUserClient',
  'publicAttemptCreationsPerMinutePerLoopbackSource',
  'nonterminalAttemptsGlobally',
  'requestsPerGrant',
  'tasksPerAdmittedUser',
  'runsPerAdmittedUser',
  'activeRunsPerAdmittedUser',
  'hostedWorkTasksGlobally',
  'hostedWorkRunsGlobally',
  'activeHostedWorkRunsGlobally',
  'ordinaryJsonRequestBodyBytes',
  'evidenceBatchBodyBytes',
  'artifactRequestBodyBytes',
  'evidencePlusArtifactsPerRunBytes',
  'acceptedEvidencePlusArtifactsGloballyBytes',
  'runWallTimeSeconds',
  'providerRequests',
  'providerInputTokens',
  'providerOutputTokens',
  'toolProposals',
  'aggregateChildCommandTimeSeconds',
  'oneChildCommandTimeSeconds',
  'changedFiles',
  'changedWorktreeBytes',
  'providerSpendMicroUsd',
] = Object.freeze([
  'workAccessAttemptLifetimeSeconds',
  'workAccessGrantLifetimeSeconds',
  'nonterminalAttemptsPerUserClient',
  'activeGrantsPerUserClient',
  'publicAttemptCreationsPerMinutePerLoopbackSource',
  'nonterminalAttemptsGlobally',
  'requestsPerGrant',
  'tasksPerAdmittedUser',
  'runsPerAdmittedUser',
  'activeRunsPerAdmittedUser',
  'hostedWorkTasksGlobally',
  'hostedWorkRunsGlobally',
  'activeHostedWorkRunsGlobally',
  'ordinaryJsonRequestBodyBytes',
  'evidenceBatchBodyBytes',
  'artifactRequestBodyBytes',
  'evidencePlusArtifactsPerRunBytes',
  'acceptedEvidencePlusArtifactsGloballyBytes',
  'runWallTimeSeconds',
  'providerRequests',
  'providerInputTokens',
  'providerOutputTokens',
  'toolProposals',
  'aggregateChildCommandTimeSeconds',
  'oneChildCommandTimeSeconds',
  'changedFiles',
  'changedWorktreeBytes',
  'providerSpendMicroUsd',
]);

export type TaskBudgetName = (typeof taskBudgetNames)[number];

export interface TaskBudgets {
  readonly workAccessAttemptLifetimeSeconds: number;
  readonly workAccessGrantLifetimeSeconds: number;
  readonly nonterminalAttemptsPerUserClient: number;
  readonly activeGrantsPerUserClient: number;
  readonly publicAttemptCreationsPerMinutePerLoopbackSource: number;
  readonly nonterminalAttemptsGlobally: number;
  readonly requestsPerGrant: number;
  readonly tasksPerAdmittedUser: number;
  readonly runsPerAdmittedUser: number;
  readonly activeRunsPerAdmittedUser: number;
  readonly hostedWorkTasksGlobally: number;
  readonly hostedWorkRunsGlobally: number;
  readonly activeHostedWorkRunsGlobally: number;
  readonly ordinaryJsonRequestBodyBytes: number;
  readonly evidenceBatchBodyBytes: number;
  readonly artifactRequestBodyBytes: number;
  readonly evidencePlusArtifactsPerRunBytes: number;
  readonly acceptedEvidencePlusArtifactsGloballyBytes: number;
  readonly runWallTimeSeconds: number;
  readonly providerRequests: number;
  readonly providerInputTokens: number;
  readonly providerOutputTokens: number;
  readonly toolProposals: number;
  readonly aggregateChildCommandTimeSeconds: number;
  readonly oneChildCommandTimeSeconds: number;
  readonly changedFiles: number;
  readonly changedWorktreeBytes: number;
  readonly providerSpendMicroUsd: number;
}

export const taskBudgetCeilings: Readonly<TaskBudgets> = Object.freeze({
  workAccessAttemptLifetimeSeconds: 300,
  workAccessGrantLifetimeSeconds: 1_800,
  nonterminalAttemptsPerUserClient: 2,
  activeGrantsPerUserClient: 2,
  publicAttemptCreationsPerMinutePerLoopbackSource: 20,
  nonterminalAttemptsGlobally: 32,
  requestsPerGrant: 2_000,
  tasksPerAdmittedUser: 4,
  runsPerAdmittedUser: 6,
  activeRunsPerAdmittedUser: 1,
  hostedWorkTasksGlobally: 16,
  hostedWorkRunsGlobally: 21,
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

/** A new PRD03 Task must opt into these finite ceilings; v1 Tasks retain their signed limits. */
export const taskEvaluationBudgetCeilings: Readonly<TaskBudgets> = Object.freeze({
  ...taskBudgetCeilings,
  runsPerAdmittedUser: 9,
  artifactRequestBodyBytes: 1_048_576,
  evidencePlusArtifactsPerRunBytes: 134_217_728,
  runWallTimeSeconds: 14_400,
  providerRequests: 256,
  providerInputTokens: 2_500_000,
  providerOutputTokens: 500_000,
  toolProposals: 3_000,
  aggregateChildCommandTimeSeconds: 7_200,
  providerSpendMicroUsd: 25_000_000,
});
