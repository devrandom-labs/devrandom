import { describe, expect, it } from 'vitest';

import type { EvaluationAllowance } from './allocation.js';
import { assessResidualEvaluationAllowance } from './residual-allowance.js';

function allowance(amount: number): EvaluationAllowance {
  return {
    providerRequests: amount,
    providerInputTokens: amount,
    providerOutputTokens: amount,
    providerSpendMicroUsd: amount,
    runWallTimeSeconds: amount,
    toolProposals: amount,
    aggregateChildCommandTimeSeconds: amount,
    changedFiles: amount,
    changedWorktreeBytes: amount,
    evidencePlusArtifactsPerRunBytes: amount,
  };
}

describe('reconciled evaluation allowance', () => {
  it('takes the narrower Task and mandate ceiling and subtracts Q and held reservations once', () => {
    expect(
      assessResidualEvaluationAllowance({
        taskCeiling: allowance(20),
        mandateCeiling: allowance(18),
        debits: [{ sourceId: 'qualified-runs', kind: 'Settled', consumed: allowance(4) }],
        reservations: [{ sourceId: 'other-evaluation', reserved: allowance(6) }],
      }),
    ).toEqual({ kind: 'Available', remaining: allowance(8) });
  });

  it('fails closed on unresolved spend, duplicate sources, invalid amounts or overspend', () => {
    const base = { taskCeiling: allowance(20), mandateCeiling: allowance(20) };
    expect(
      assessResidualEvaluationAllowance({
        ...base,
        debits: [{ sourceId: 'run-1', kind: 'Unresolved' }],
        reservations: [],
      }),
    ).toEqual({ kind: 'Unavailable', reason: 'UnresolvedSpend' });
    expect(
      assessResidualEvaluationAllowance({
        ...base,
        debits: [{ sourceId: 'run-1', kind: 'Settled', consumed: allowance(2) }],
        reservations: [{ sourceId: 'run-1', reserved: allowance(2) }],
      }),
    ).toEqual({ kind: 'Unavailable', reason: 'DuplicateSource' });
    expect(
      assessResidualEvaluationAllowance({
        ...base,
        debits: [],
        reservations: [{ sourceId: 'evaluation', reserved: allowance(Number.NaN) }],
      }),
    ).toEqual({ kind: 'Unavailable', reason: 'InvalidAmount' });
    expect(
      assessResidualEvaluationAllowance({
        ...base,
        debits: [{ sourceId: 'run-1', kind: 'Settled', consumed: allowance(21) }],
        reservations: [],
      }),
    ).toEqual({ kind: 'Unavailable', reason: 'CeilingExceeded', budget: 'providerRequests' });
  });
});
