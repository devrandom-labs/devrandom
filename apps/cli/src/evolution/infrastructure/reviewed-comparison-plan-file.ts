import { isDeepStrictEqual } from 'node:util';

import type { ReviewedComparisonPlan } from '../application/progress-qualified-h0.js';
import { EvaluationPolicyFile } from '../../harness/infrastructure/evaluation-policy-file.js';

/** A parent-selected plan is usable only for the exact newly verified Q source inventory. */
export class ReviewedComparisonPlanFile implements ReviewedComparisonPlan {
  readonly #path: string;
  readonly #files: Pick<EvaluationPolicyFile, 'read'>;

  constructor(
    path: string,
    files: Pick<EvaluationPolicyFile, 'read'> = new EvaluationPolicyFile(),
  ) {
    this.#path = path;
    this.#files = files;
  }

  async review(
    input: Parameters<ReviewedComparisonPlan['review']>[0],
  ): ReturnType<ReviewedComparisonPlan['review']> {
    const reading = await this.#files.read(this.#path);
    if (
      reading.kind !== 'Read' ||
      reading.policy.originRunId !== input.qualified.originRunId ||
      reading.policy.taskId !== input.qualified.taskId ||
      reading.policy.taskRevisionSaid !== input.qualified.taskRevisionSaid ||
      reading.policy.sourceInventorySaid !== input.inventory.d ||
      !isDeepStrictEqual(reading.inventory, input.inventory)
    )
      return { kind: 'Missing' };
    return { kind: 'Reviewed', policy: reading.policy, profile: reading.profile };
  }
}
