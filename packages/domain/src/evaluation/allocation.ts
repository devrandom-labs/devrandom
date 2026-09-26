import type { TaskBudgets } from '../task/authority.js';

export const evaluationConsumables = [
  'providerRequests',
  'providerInputTokens',
  'providerOutputTokens',
  'providerSpendMicroUsd',
  'runWallTimeSeconds',
  'toolProposals',
  'aggregateChildCommandTimeSeconds',
  'changedFiles',
  'changedWorktreeBytes',
  'evidencePlusArtifactsPerRunBytes',
] as const;
export type EvaluationConsumable = (typeof evaluationConsumables)[number];
export type EvaluationAllowance = Pick<TaskBudgets, EvaluationConsumable>;
export interface ComparisonAllocation {
  readonly diagnosis: EvaluationAllowance;
  readonly perEntry: EvaluationAllowance;
  readonly finalization: EvaluationAllowance;
}
export type ComparisonAllocationAssessment =
  | {
      readonly kind: 'Fits';
      readonly total: EvaluationAllowance;
      readonly searchAttempt: EvaluationAllowance;
    }
  | {
      readonly kind: 'InsufficientAllocation';
      readonly budget: EvaluationConsumable;
      readonly required: number;
      readonly remaining: number;
    }
  | { readonly kind: 'ControlCannotRun'; readonly budget: EvaluationConsumable }
  | { readonly kind: 'AllocationInvalid' };

/** Checks residual authority; the hosted admission transaction must reserve the returned total. */
export function assessComparisonAllocation(
  allocation: ComparisonAllocation,
  remaining: EvaluationAllowance,
): ComparisonAllocationAssessment {
  const total = { ...allocation.diagnosis };
  const searchAttempt = { ...allocation.perEntry };
  for (const budget of evaluationConsumables) {
    const values = [
      allocation.diagnosis[budget],
      allocation.perEntry[budget],
      allocation.finalization[budget],
      remaining[budget],
    ];
    if (values.some((value) => !Number.isSafeInteger(value) || value < 0))
      return { kind: 'AllocationInvalid' };
    total[budget] =
      allocation.diagnosis[budget] +
      15 * allocation.perEntry[budget] +
      allocation.finalization[budget];
    if (!Number.isSafeInteger(total[budget])) return { kind: 'AllocationInvalid' };
    searchAttempt[budget] = Math.floor(allocation.perEntry[budget] / 2);
  }
  for (const budget of evaluationConsumables) {
    if (searchAttempt[budget] === 0) return { kind: 'ControlCannotRun', budget };
    if (total[budget] > remaining[budget])
      return {
        kind: 'InsufficientAllocation',
        budget,
        required: total[budget],
        remaining: remaining[budget],
      };
  }
  return { kind: 'Fits', total, searchAttempt };
}
