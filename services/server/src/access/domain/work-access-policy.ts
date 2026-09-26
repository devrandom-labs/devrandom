import { createHash } from 'node:crypto';

import { taskBudgetCeilings } from '@devrandom/domain';

export interface WorkAccessPolicy {
  readonly version: 'work-access-policy/1';
  readonly attemptLifetimeSeconds: number;
  readonly grantLifetimeSeconds: number;
  readonly nonterminalAttemptsPerUserClient: number;
  readonly activeGrantsPerUserClient: number;
  readonly publicAttemptsPerLoopbackMinute: number;
  readonly globalNonterminalAttempts: number;
  readonly requestsPerGrant: number;
  readonly tasksPerUser: number;
  readonly runsPerUser: number;
  readonly activeRunsPerUser: number;
  readonly hostedTasks: number;
  readonly hostedRuns: number;
  readonly activeHostedRuns: number;
  readonly ordinaryRequestBytes: number;
  readonly evidenceBatchBytes: number;
  readonly artifactRequestBytes: number;
  readonly evidenceAndArtifactsPerRunBytes: number;
  readonly acceptedEvidenceAndArtifactsBytes: number;
  readonly runWallTimeSeconds: number;
  readonly providerRequests: number;
  readonly providerInputTokens: number;
  readonly providerOutputTokens: number;
  readonly toolProposals: number;
  readonly childCommandSeconds: number;
  readonly oneChildCommandSeconds: number;
  readonly changedFiles: number;
  readonly changedWorktreeBytes: number;
  readonly providerSpendMicroUsd: number;
}

export interface WorkAccessPolicyManifest {
  readonly version: 'work-access-policy/1';
  readonly fingerprint: string;
  readonly grantLifetimeSeconds: number;
}

export const workAccessPolicy: WorkAccessPolicy = Object.freeze({
  version: 'work-access-policy/1',
  attemptLifetimeSeconds: taskBudgetCeilings.workAccessAttemptLifetimeSeconds,
  grantLifetimeSeconds: taskBudgetCeilings.workAccessGrantLifetimeSeconds,
  nonterminalAttemptsPerUserClient: taskBudgetCeilings.nonterminalAttemptsPerUserClient,
  activeGrantsPerUserClient: taskBudgetCeilings.activeGrantsPerUserClient,
  publicAttemptsPerLoopbackMinute:
    taskBudgetCeilings.publicAttemptCreationsPerMinutePerLoopbackSource,
  globalNonterminalAttempts: taskBudgetCeilings.nonterminalAttemptsGlobally,
  requestsPerGrant: taskBudgetCeilings.requestsPerGrant,
  tasksPerUser: taskBudgetCeilings.tasksPerAdmittedUser,
  runsPerUser: taskBudgetCeilings.runsPerAdmittedUser,
  activeRunsPerUser: taskBudgetCeilings.activeRunsPerAdmittedUser,
  hostedTasks: taskBudgetCeilings.hostedWorkTasksGlobally,
  hostedRuns: taskBudgetCeilings.hostedWorkRunsGlobally,
  activeHostedRuns: taskBudgetCeilings.activeHostedWorkRunsGlobally,
  ordinaryRequestBytes: taskBudgetCeilings.ordinaryJsonRequestBodyBytes,
  evidenceBatchBytes: taskBudgetCeilings.evidenceBatchBodyBytes,
  artifactRequestBytes: taskBudgetCeilings.artifactRequestBodyBytes,
  evidenceAndArtifactsPerRunBytes: taskBudgetCeilings.evidencePlusArtifactsPerRunBytes,
  acceptedEvidenceAndArtifactsBytes: taskBudgetCeilings.acceptedEvidencePlusArtifactsGloballyBytes,
  runWallTimeSeconds: taskBudgetCeilings.runWallTimeSeconds,
  providerRequests: taskBudgetCeilings.providerRequests,
  providerInputTokens: taskBudgetCeilings.providerInputTokens,
  providerOutputTokens: taskBudgetCeilings.providerOutputTokens,
  toolProposals: taskBudgetCeilings.toolProposals,
  childCommandSeconds: taskBudgetCeilings.aggregateChildCommandTimeSeconds,
  oneChildCommandSeconds: taskBudgetCeilings.oneChildCommandTimeSeconds,
  changedFiles: taskBudgetCeilings.changedFiles,
  changedWorktreeBytes: taskBudgetCeilings.changedWorktreeBytes,
  providerSpendMicroUsd: taskBudgetCeilings.providerSpendMicroUsd,
});

function canonicalPolicy(policy: WorkAccessPolicy): string {
  return JSON.stringify({
    acceptedEvidenceAndArtifactsBytes: policy.acceptedEvidenceAndArtifactsBytes,
    activeGrantsPerUserClient: policy.activeGrantsPerUserClient,
    activeHostedRuns: policy.activeHostedRuns,
    activeRunsPerUser: policy.activeRunsPerUser,
    artifactRequestBytes: policy.artifactRequestBytes,
    attemptLifetimeSeconds: policy.attemptLifetimeSeconds,
    changedFiles: policy.changedFiles,
    changedWorktreeBytes: policy.changedWorktreeBytes,
    childCommandSeconds: policy.childCommandSeconds,
    evidenceAndArtifactsPerRunBytes: policy.evidenceAndArtifactsPerRunBytes,
    evidenceBatchBytes: policy.evidenceBatchBytes,
    globalNonterminalAttempts: policy.globalNonterminalAttempts,
    grantLifetimeSeconds: policy.grantLifetimeSeconds,
    hostedRuns: policy.hostedRuns,
    hostedTasks: policy.hostedTasks,
    nonterminalAttemptsPerUserClient: policy.nonterminalAttemptsPerUserClient,
    oneChildCommandSeconds: policy.oneChildCommandSeconds,
    ordinaryRequestBytes: policy.ordinaryRequestBytes,
    providerInputTokens: policy.providerInputTokens,
    providerOutputTokens: policy.providerOutputTokens,
    providerRequests: policy.providerRequests,
    providerSpendMicroUsd: policy.providerSpendMicroUsd,
    publicAttemptsPerLoopbackMinute: policy.publicAttemptsPerLoopbackMinute,
    requestsPerGrant: policy.requestsPerGrant,
    runWallTimeSeconds: policy.runWallTimeSeconds,
    runsPerUser: policy.runsPerUser,
    tasksPerUser: policy.tasksPerUser,
    toolProposals: policy.toolProposals,
    version: policy.version,
  });
}

export function workAccessPolicyForGrantLifetime(grantLifetimeSeconds: number): WorkAccessPolicy {
  if (
    !Number.isSafeInteger(grantLifetimeSeconds) ||
    grantLifetimeSeconds < 1 ||
    grantLifetimeSeconds > workAccessPolicy.grantLifetimeSeconds
  ) {
    throw new Error('Work Access Grant lifetime must be a positive integer at or below policy');
  }
  return grantLifetimeSeconds === workAccessPolicy.grantLifetimeSeconds
    ? workAccessPolicy
    : Object.freeze({ ...workAccessPolicy, grantLifetimeSeconds });
}

export function workAccessPolicyFingerprintFor(policy: WorkAccessPolicy): string {
  return `sha256:${createHash('sha256').update(encodeWorkAccessPolicy(policy)).digest('hex')}`;
}

export const workAccessPolicyFingerprint = workAccessPolicyFingerprintFor(workAccessPolicy);

export function manifestWorkAccessPolicy(policy: WorkAccessPolicy): WorkAccessPolicyManifest {
  return Object.freeze({
    version: policy.version,
    fingerprint: workAccessPolicyFingerprintFor(policy),
    grantLifetimeSeconds: policy.grantLifetimeSeconds,
  });
}

export function encodeWorkAccessPolicy(policy: WorkAccessPolicy): string {
  const effectivePolicy = workAccessPolicyForGrantLifetime(policy.grantLifetimeSeconds);
  const encodedPolicy = canonicalPolicy(policy);
  if (encodedPolicy !== canonicalPolicy(effectivePolicy)) {
    throw new Error('Work Access policy may lower only the grant lifetime');
  }
  return encodedPolicy;
}
