import { describe, expect, it } from 'vitest';

import { taskBudgetCeilings } from '@devrandom/domain';

import {
  workAccessPolicy,
  workAccessPolicyFingerprint,
  workAccessPolicyFingerprintFor,
  workAccessPolicyForGrantLifetime,
} from './work-access-policy.js';

describe('Work Access policy', () => {
  it('maps every hosted-work budget from the domain ceiling and binds the six-Run campaign limit', () => {
    expect(workAccessPolicy).toEqual({
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
      acceptedEvidenceAndArtifactsBytes:
        taskBudgetCeilings.acceptedEvidencePlusArtifactsGloballyBytes,
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
    expect(workAccessPolicyFingerprint).toBe(
      'sha256:08ab60551ef0a7c12ff5adcc693b1302e67e11fab39f2866d2fc662f0939d5fe',
    );
  });

  it('may lower only the grant lifetime while retaining every other policy dimension', () => {
    const lowered = workAccessPolicyForGrantLifetime(45);

    expect(lowered).toEqual({ ...workAccessPolicy, grantLifetimeSeconds: 45 });
    expect(workAccessPolicyFingerprintFor(lowered)).not.toBe(workAccessPolicyFingerprint);
    expect(() => workAccessPolicyForGrantLifetime(1_801)).toThrow(
      'Work Access Grant lifetime must be a positive integer at or below policy',
    );
  });
});
