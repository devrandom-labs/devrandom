import type { EvaluationExecutionBinding } from '@devrandom/domain';

/** Trusted current accepted-prefix allowance. Its inspection is read-only; the trial relay
 * writes the single durable EvaluationBudgetDebited event for an authorized proposal. */
export interface CurrentEvaluationProposalCapacity {
  inspect(
    binding: EvaluationExecutionBinding,
  ): Promise<{ readonly kind: 'Available' | 'Exhausted' | 'Unavailable' }>;
}
