import { describe, expect, it } from 'vitest';

import {
  taskBudgetCeilings,
  taskEvaluationBudgetCeilings,
  taskEvaluationCapabilities,
  taskBudgetNames,
  taskEvolutionClasses,
  taskToolCapabilities,
} from './authority.js';

describe('Task authority vocabulary', () => {
  it('owns the closed capability and evolution-class alternatives', () => {
    expect(taskToolCapabilities).toEqual([
      'ReadRepository',
      'EditRepository',
      'RunFormatter',
      'RunStaticAnalysis',
      'RunTests',
      'SubmitResult',
    ]);
    expect(taskEvolutionClasses).toEqual(['C1', 'C2', 'C3']);
    expect(Object.isFrozen(taskToolCapabilities)).toBe(true);
    expect(Object.isFrozen(taskEvolutionClasses)).toBe(true);
  });

  it('preserves PRD02 limits while bounding separately authorized PRD03 evaluations', () => {
    expect(taskBudgetCeilings.providerRequests).toBe(50);
    expect(taskBudgetCeilings.providerSpendMicroUsd).toBe(5_000_000);
    expect(taskEvaluationBudgetCeilings.providerRequests).toBe(256);
    expect(taskEvaluationBudgetCeilings.providerSpendMicroUsd).toBe(25_000_000);
    expect(taskEvaluationCapabilities).toContain('ReadTaskMemory');
    expect(Object.isFrozen(taskEvaluationBudgetCeilings)).toBe(true);
  });

  it('defines one ordered budget product and its immutable hackathon ceiling', () => {
    expect(taskBudgetNames).toHaveLength(28);
    expect(taskBudgetNames[0]).toBe('workAccessAttemptLifetimeSeconds');
    expect(taskBudgetNames[27]).toBe('providerSpendMicroUsd');
    expect(taskBudgetCeilings).toMatchObject({
      tasksPerAdmittedUser: 4,
      hostedWorkTasksGlobally: 16,
      providerSpendMicroUsd: 5_000_000,
    });
    expect(Object.isFrozen(taskBudgetNames)).toBe(true);
    expect(Object.isFrozen(taskBudgetCeilings)).toBe(true);
  });
});

it('authorizes eight v2 Run slots without changing any other ceiling or v1 slot', () => {
  expect(taskBudgetCeilings.runsPerAdmittedUser).toBe(6);
  expect(taskEvaluationBudgetCeilings).toEqual({
    ...taskBudgetCeilings,
    runsPerAdmittedUser: 8,
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
});
