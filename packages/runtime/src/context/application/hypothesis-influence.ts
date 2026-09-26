import {
  decodeEvaluationSourceInventory,
  decodeEvolutionHypothesis,
  type EvaluationSourceInventory,
  type EvolutionHypothesis,
} from '@devrandom/protocol';

import { reviewAnalogyInfluence, type AnalogyInfluenceReview } from './verified-context.js';

/** These identities come from exact reads of the qualified retained Run and its sealed stream. */
export interface QualifiedFailureEvidence {
  readonly taskId: string;
  readonly taskRevisionSaid: string;
  readonly originRunId: string;
  readonly retainedCheckpointSaid: string;
  readonly retainedSealSaid: string;
  readonly parentRevisionSaid: string;
  readonly personalAgentAid: string;
  readonly failureEventSaid: string;
  readonly failureRawEvidenceSaid: string;
}

export type HypothesisInfluenceReview =
  | {
      readonly kind: 'Influenced';
      readonly hypothesisSaid: string;
      readonly review: Extract<AnalogyInfluenceReview, { readonly kind: 'Influenced' }>;
    }
  | {
      readonly kind: 'Blocked';
      readonly reason:
        | 'HypothesisInvalid'
        | 'FailureBinding'
        | 'SourceBinding'
        | 'NoCausalInfluence'
        | 'ReviewBlocked';
      readonly gate?: Extract<AnalogyInfluenceReview, { readonly kind: 'Blocked' }>['reason'];
    };

/** The H0 claim fixes the public choice before the parent performs causal replay. */
export async function reviewEvolutionHypothesisInfluence(
  input: {
    readonly hypothesis: EvolutionHypothesis;
    readonly inventory: EvaluationSourceInventory;
    readonly retained: QualifiedFailureEvidence;
  },
  ports: Parameters<typeof reviewAnalogyInfluence>[1],
): Promise<HypothesisInfluenceReview> {
  const decoded = decodeEvolutionHypothesis(input.hypothesis);
  if (decoded.kind !== 'Accepted') return { kind: 'Blocked', reason: 'HypothesisInvalid' };
  const { hypothesis, retained } = input;
  if (
    hypothesis.taskId !== retained.taskId ||
    hypothesis.taskRevisionSaid !== retained.taskRevisionSaid ||
    hypothesis.originRunId !== retained.originRunId ||
    hypothesis.retainedCheckpointSaid !== retained.retainedCheckpointSaid ||
    hypothesis.retainedSealSaid !== retained.retainedSealSaid ||
    hypothesis.parentRevisionSaid !== retained.parentRevisionSaid ||
    hypothesis.personalAgentAid !== retained.personalAgentAid ||
    hypothesis.failure.eventSaid !== retained.failureEventSaid ||
    hypothesis.failure.rawEvidenceSaid !== retained.failureRawEvidenceSaid
  )
    return { kind: 'Blocked', reason: 'FailureBinding' };
  const inventory = decodeEvaluationSourceInventory(input.inventory);
  if (
    inventory.kind !== 'Accepted' ||
    hypothesis.sourceInventorySaid !== inventory.inventory.d ||
    inventory.inventory.taskId !== hypothesis.taskId ||
    inventory.inventory.taskRevisionSaid !== hypothesis.taskRevisionSaid ||
    !inventory.inventory.sources.some(
      (source) =>
        source.episodeSaid === hypothesis.source.episodeSaid &&
        source.rawEvidenceSaid === hypothesis.source.rawEvidenceSaid,
    )
  )
    return { kind: 'Blocked', reason: 'SourceBinding' };

  const review = await reviewAnalogyInfluence(
    {
      inventory: inventory.inventory,
      targetEpisodeSaid: hypothesis.source.episodeSaid,
      publicFailureWindowSaid: hypothesis.publicReplay.failureWindowSaid,
      configurationSaid: hypothesis.publicReplay.configurationSaid,
      nonTreatmentInputsSaid: hypothesis.publicReplay.nonTreatmentInputsSaid,
      failureQuery: hypothesis.publicReplay.failureQuery,
      reviewedAction: hypothesis.publicReplay.predictedAction,
      reviewedSourceChoiceSaid: hypothesis.publicReplay.predictedSourceChoiceSaid,
    },
    ports,
  );
  if (review.kind === 'Blocked')
    return { kind: 'Blocked', reason: 'ReviewBlocked', gate: review.reason };
  if (review.kind === 'NotInfluenced') return { kind: 'Blocked', reason: 'NoCausalInfluence' };
  if (
    review.source.episodeSaid !== hypothesis.source.episodeSaid ||
    review.source.rawEvidenceSaid !== hypothesis.source.rawEvidenceSaid
  )
    return { kind: 'Blocked', reason: 'SourceBinding' };
  return { kind: 'Influenced', hypothesisSaid: hypothesis.d, review };
}
