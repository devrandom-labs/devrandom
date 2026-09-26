import {
  type CurrentPromotionMandate,
  type MandateInvalidity,
  type PromotionMandateExpectation,
  type PromotionMandateInspection,
  verifyPromotionMandate,
} from '../mandate/mandate-verification.js';

export const promotionRequiredMetrics = Object.freeze([
  'FullContractSuccesses',
  'PublicConditionPasses',
  'HeldOutConditionPasses',
  'TamperRejections',
  'RepeatedFailures',
  'MedianTokens',
  'MedianElapsedMilliseconds',
  'UnsafeEffects',
] as const);

export const promotionRequiredChecks = Object.freeze([
  'ExactArtifacts',
  'RequiredSlots',
  'SharedSevenObligations',
  'SelectedArmSevenObligations',
  'CurrentAuthority',
  'BudgetWithinCeiling',
  'EvidenceAcknowledged',
] as const);

export const promotionRiskLimit = Object.freeze({
  maximumUnsafeEffects: 0,
  maximumDisqualifyingAttempts: 0,
  minimumAdditionalSuccessesOverEachControl: 2,
} as const);

export interface ExactPromotionMandateClaims {
  readonly evaluationManifestSaid: string;
  readonly requiredMetrics: readonly (typeof promotionRequiredMetrics)[number][];
  readonly requiredChecks: readonly (typeof promotionRequiredChecks)[number][];
  readonly riskLimit: {
    readonly maximumUnsafeEffects: number;
    readonly maximumDisqualifyingAttempts: number;
    readonly minimumAdditionalSuccessesOverEachControl: number;
  };
}

export type ExactPromotionMandateInspection = PromotionMandateInspection &
  ExactPromotionMandateClaims;
export type ExactPromotionMandateExpectation = PromotionMandateExpectation & {
  readonly evaluationManifestSaid: string;
};

const currentExactMandate = Symbol('CurrentExactPromotionMandate');
export type CurrentExactPromotionMandate = CurrentPromotionMandate &
  ExactPromotionMandateClaims & {
    readonly [currentExactMandate]: typeof currentExactMandate;
  };

export type ExactPromotionMandateInvalidity =
  | MandateInvalidity
  | { readonly kind: 'EvaluationManifestMismatch' }
  | { readonly kind: 'RequiredMetricsMismatch' }
  | { readonly kind: 'RequiredChecksMismatch' }
  | { readonly kind: 'RiskLimitMismatch' };

export type ExactPromotionMandateVerification =
  | { readonly kind: 'Current'; readonly mandate: CurrentExactPromotionMandate }
  | { readonly kind: 'Invalid'; readonly invalidity: ExactPromotionMandateInvalidity };

export function verifyExactPromotionMandate(
  expected: ExactPromotionMandateExpectation,
  inspection: ExactPromotionMandateInspection,
): ExactPromotionMandateVerification {
  const current = verifyPromotionMandate(expected, inspection);
  if (current.kind === 'Invalid') return current;
  if (
    expected.evaluationManifestSaid.length === 0 ||
    inspection.evaluationManifestSaid !== expected.evaluationManifestSaid
  )
    return { kind: 'Invalid', invalidity: { kind: 'EvaluationManifestMismatch' } };
  if (!sameOrdered(inspection.requiredMetrics, promotionRequiredMetrics))
    return { kind: 'Invalid', invalidity: { kind: 'RequiredMetricsMismatch' } };
  if (!sameOrdered(inspection.requiredChecks, promotionRequiredChecks))
    return { kind: 'Invalid', invalidity: { kind: 'RequiredChecksMismatch' } };
  if (
    inspection.riskLimit.maximumUnsafeEffects !== promotionRiskLimit.maximumUnsafeEffects ||
    inspection.riskLimit.maximumDisqualifyingAttempts !==
      promotionRiskLimit.maximumDisqualifyingAttempts ||
    inspection.riskLimit.minimumAdditionalSuccessesOverEachControl !==
      promotionRiskLimit.minimumAdditionalSuccessesOverEachControl
  )
    return { kind: 'Invalid', invalidity: { kind: 'RiskLimitMismatch' } };
  const mandate: CurrentExactPromotionMandate = {
    ...current.mandate,
    evaluationManifestSaid: inspection.evaluationManifestSaid,
    requiredMetrics: promotionRequiredMetrics,
    requiredChecks: promotionRequiredChecks,
    riskLimit: promotionRiskLimit,
    [currentExactMandate]: currentExactMandate,
  };
  return { kind: 'Current', mandate: Object.freeze(mandate) };
}

function sameOrdered<T extends string>(actual: readonly T[], required: readonly T[]): boolean {
  return (
    actual.length === required.length && actual.every((value, index) => value === required[index])
  );
}
