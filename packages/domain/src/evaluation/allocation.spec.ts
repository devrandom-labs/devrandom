import { describe, expect, it } from 'vitest';
import { assessComparisonAllocation, type EvaluationAllowance } from './allocation.js';

const entry: EvaluationAllowance = {
  providerRequests: 2,
  providerInputTokens: 2000,
  providerOutputTokens: 200,
  providerSpendMicroUsd: 200,
  runWallTimeSeconds: 20,
  toolProposals: 20,
  aggregateChildCommandTimeSeconds: 10,
  changedFiles: 2,
  changedWorktreeBytes: 2000,
  evidencePlusArtifactsPerRunBytes: 20000,
};
const zero: EvaluationAllowance = {
  providerRequests: 0,
  providerInputTokens: 0,
  providerOutputTokens: 0,
  providerSpendMicroUsd: 0,
  runWallTimeSeconds: 0,
  toolProposals: 0,
  aggregateChildCommandTimeSeconds: 0,
  changedFiles: 0,
  changedWorktreeBytes: 0,
  evidencePlusArtifactsPerRunBytes: 0,
};
const available: EvaluationAllowance = {
  providerRequests: 32,
  providerInputTokens: 32000,
  providerOutputTokens: 3200,
  providerSpendMicroUsd: 3200,
  runWallTimeSeconds: 320,
  toolProposals: 320,
  aggregateChildCommandTimeSeconds: 160,
  changedFiles: 32,
  changedWorktreeBytes: 32000,
  evidencePlusArtifactsPerRunBytes: 320000,
};

describe('comparison allocation within existing authority', () => {
  it('accounts D plus fifteen B plus F, including both half-budget search attempts', () => {
    const assessment = assessComparisonAllocation(
      { diagnosis: entry, perEntry: entry, finalization: zero },
      available,
    );
    expect(assessment).toMatchObject({
      kind: 'Fits',
      total: available,
      searchAttempt: { providerRequests: 1, providerInputTokens: 1000, changedFiles: 1 },
    });
    expect(available.providerRequests).toBe(32);
  });

  it('rejects an otherwise affordable batch when prior or unresolved work leaves too few requests', () => {
    expect(
      assessComparisonAllocation(
        { diagnosis: entry, perEntry: entry, finalization: zero },
        { ...available, providerRequests: 31 },
      ),
    ).toEqual({
      kind: 'InsufficientAllocation',
      budget: 'providerRequests',
      required: 32,
      remaining: 31,
    });
  });

  it('refuses a starved task-search control instead of silently changing its two-attempt law', () => {
    expect(
      assessComparisonAllocation(
        { diagnosis: zero, perEntry: { ...entry, providerRequests: 1 }, finalization: zero },
        available,
      ),
    ).toEqual({ kind: 'ControlCannotRun', budget: 'providerRequests' });
  });

  it('rejects invalid or unrepresentable arithmetic rather than resetting or overflowing budgets', () => {
    expect(
      assessComparisonAllocation(
        {
          diagnosis: zero,
          perEntry: { ...entry, providerInputTokens: Number.MAX_SAFE_INTEGER },
          finalization: zero,
        },
        available,
      ).kind,
    ).toBe('AllocationInvalid');
    expect(
      assessComparisonAllocation(
        { diagnosis: zero, perEntry: entry, finalization: zero },
        { ...available, providerRequests: -1 },
      ).kind,
    ).toBe('AllocationInvalid');
  });
});
