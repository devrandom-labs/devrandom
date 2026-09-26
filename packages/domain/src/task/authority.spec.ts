import { describe, expect, it } from 'vitest';

import {
  taskBudgetCeilings,
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
