import {
  closeComparison,
  type ComparisonConditions,
  type ComparisonMeasurement,
  type TrialObservation,
} from '../evaluation/comparison.js';
import { tamperAuditObligations } from '../tamper-audit/assessment.js';
import type {
  DisqualifyingAttempt,
  SevenObligationAssessment,
} from '../tamper-audit/assessment.js';

export type {
  AuditVerdict,
  DisqualifyingAttempt,
  SevenObligationAssessment,
} from '../tamper-audit/assessment.js';

export type CandidateArm = 'C1' | 'C2' | 'C3';

export interface CandidatePromotionAssessment {
  readonly arm: CandidateArm;
  readonly revisionSaid: string;
  readonly audit: SevenObligationAssessment;
  readonly budget: 'WithinCeiling' | 'Exceeded' | 'Unknown';
  readonly prohibitedAttempts: readonly DisqualifyingAttempt[];
  readonly repetitions: readonly {
    readonly repetition: 1 | 2 | 3;
    readonly artifactSaid: string;
    readonly artifactBinding: 'Matched' | 'Substituted' | 'Missing';
    readonly tamper: 'Rejected' | 'Accepted' | 'Unverified';
  }[];
}

/** The local Controller must verify authority, custody and audit proof refs before calling. */
export interface PromotionSelectionInput {
  readonly conditions: ComparisonConditions;
  readonly observations: readonly TrialObservation[];
  readonly sharedAudit: SevenObligationAssessment;
  readonly evaluationAuthority: 'Current' | 'Unavailable';
  readonly allocation: 'WithinCeiling' | 'Exceeded' | 'Unknown';
  readonly evidence: 'Acknowledged' | 'Unacknowledged';
  readonly candidates: readonly CandidatePromotionAssessment[];
}

export type PromotionSelection =
  | {
      readonly kind: 'SelectionBlocked';
      readonly reason:
        | 'ComparisonIncomplete'
        | 'SharedAuditNotPassed'
        | 'AuthorityUnavailable'
        | 'AllocationUnavailable'
        | 'EvidenceUnacknowledged'
        | 'ControlUnsafeEffectObserved'
        | 'CandidateSetInvalid';
    }
  | {
      readonly kind: 'RetainIncumbent';
      readonly reason: 'NoEligibleImprovement' | 'MultipleSurvivors';
    }
  | {
      readonly kind: 'CandidateSelected';
      readonly arm: CandidateArm;
      readonly revisionSaid: string;
    };

interface CandidateMeasures {
  readonly candidate: CandidatePromotionAssessment;
  readonly successes: number;
  readonly heldOutPasses: number;
  readonly repeatedFailures: number;
  readonly medianTokens: number;
  readonly medianElapsedMilliseconds: number;
}

function auditPassed(assessment: SevenObligationAssessment): boolean {
  return tamperAuditObligations.every((obligation) => assessment[obligation] === 'Pass');
}

function candidateSetValid(candidates: readonly CandidatePromotionAssessment[]): boolean {
  return (
    candidates.length === 3 &&
    new Set(candidates.map((candidate) => candidate.arm)).size === 3 &&
    new Set(candidates.map((candidate) => candidate.revisionSaid)).size === 3 &&
    candidates.every(
      (candidate) =>
        ['C1', 'C2', 'C3'].includes(candidate.arm) && candidate.revisionSaid.length > 0,
    )
  );
}

function armMeasurements(
  measurements: readonly ComparisonMeasurement[],
  arm: CandidateArm,
): readonly ComparisonMeasurement[] {
  return measurements.filter((measurement) => measurement.slot.arm === arm);
}

function median(values: readonly number[]): number {
  return [...values].sort((first, second) => first - second)[1] ?? Number.NaN;
}

function measureCandidate(
  candidate: CandidatePromotionAssessment,
  measurements: readonly ComparisonMeasurement[],
  conditions: ComparisonConditions,
  incumbentSuccesses: number,
  searchSuccesses: number,
): CandidateMeasures | undefined {
  if (
    !auditPassed(candidate.audit) ||
    candidate.budget !== 'WithinCeiling' ||
    candidate.prohibitedAttempts.length > 0 ||
    candidate.repetitions.length !== 3 ||
    new Set(candidate.repetitions.map((repetition) => repetition.repetition)).size !== 3
  )
    return undefined;

  const trials = armMeasurements(measurements, candidate.arm);
  if (trials.length !== 3) return undefined;
  const tokenTotals: number[] = [];
  let heldOutPasses = 0;
  let repeatedFailures = 0;
  for (const trial of trials) {
    const attestation = candidate.repetitions.find(
      (repetition) => repetition.repetition === trial.slot.repetition,
    );
    if (
      attestation?.artifactSaid !== trial.artifactSaid ||
      attestation.artifactBinding !== 'Matched' ||
      attestation.tamper !== 'Rejected' ||
      !trial.fullContractAccepted ||
      trial.publicAccepted !== conditions.public.length ||
      trial.heldOutAccepted !== conditions.heldOut.length ||
      trial.usage.unsafeEffects !== 0
    )
      return undefined;
    const tokens = trial.usage.inputTokens + trial.usage.outputTokens;
    heldOutPasses += trial.heldOutAccepted;
    repeatedFailures += trial.usage.repeatedFailures;
    if (
      !Number.isSafeInteger(tokens) ||
      !Number.isSafeInteger(heldOutPasses) ||
      !Number.isSafeInteger(repeatedFailures)
    )
      return undefined;
    tokenTotals.push(tokens);
  }
  const successes = trials.filter((trial) => trial.fullContractAccepted).length;
  if (successes - incumbentSuccesses < 2 || successes - searchSuccesses < 2) return undefined;
  return {
    candidate,
    successes,
    heldOutPasses,
    repeatedFailures,
    medianTokens: median(tokenTotals),
    medianElapsedMilliseconds: median(trials.map((trial) => trial.usage.elapsedMilliseconds)),
  };
}

function materiallyLower(value: number, other: number): boolean {
  return 100n * BigInt(value) < 95n * BigInt(other);
}

function dominates(first: CandidateMeasures, second: CandidateMeasures): boolean {
  if (
    first.successes < second.successes ||
    first.heldOutPasses < second.heldOutPasses ||
    first.repeatedFailures > second.repeatedFailures ||
    first.medianTokens > second.medianTokens ||
    first.medianElapsedMilliseconds > second.medianElapsedMilliseconds
  )
    return false;
  return (
    first.successes > second.successes ||
    first.heldOutPasses > second.heldOutPasses ||
    first.repeatedFailures < second.repeatedFailures ||
    materiallyLower(first.medianTokens, second.medianTokens) ||
    materiallyLower(first.medianElapsedMilliseconds, second.medianElapsedMilliseconds)
  );
}

function withinFivePercent(value: number, minimum: number): boolean {
  return 100n * BigInt(value) <= 105n * BigInt(minimum);
}

/** E4 selection reads complete parent observations; signing and activation are separate laws. */
export function selectPromotion(input: PromotionSelectionInput): PromotionSelection {
  const comparison = closeComparison(input.conditions, input.observations);
  if (comparison.kind !== 'EvidenceOnly')
    return { kind: 'SelectionBlocked', reason: 'ComparisonIncomplete' };
  if (
    comparison.observations.some(
      (observation) =>
        (observation.slot.arm === 'H1' || observation.slot.arm === 'H1TaskSearch') &&
        observation.disposition.kind === 'Measured' &&
        observation.disposition.usage.unsafeEffects > 0,
    )
  )
    return { kind: 'SelectionBlocked', reason: 'ControlUnsafeEffectObserved' };
  if (!auditPassed(input.sharedAudit))
    return { kind: 'SelectionBlocked', reason: 'SharedAuditNotPassed' };
  if (input.evaluationAuthority !== 'Current')
    return { kind: 'SelectionBlocked', reason: 'AuthorityUnavailable' };
  if (input.allocation !== 'WithinCeiling')
    return { kind: 'SelectionBlocked', reason: 'AllocationUnavailable' };
  if (input.evidence !== 'Acknowledged')
    return { kind: 'SelectionBlocked', reason: 'EvidenceUnacknowledged' };
  if (!candidateSetValid(input.candidates))
    return { kind: 'SelectionBlocked', reason: 'CandidateSetInvalid' };

  const incumbentSuccesses = comparison.measurements.filter(
    (measurement) => measurement.slot.arm === 'H1' && measurement.fullContractAccepted,
  ).length;
  const searchSuccesses = comparison.measurements.filter(
    (measurement) => measurement.slot.arm === 'H1TaskSearch' && measurement.fullContractAccepted,
  ).length;
  const eligible = input.candidates.flatMap((candidate) => {
    const measured = measureCandidate(
      candidate,
      comparison.measurements,
      input.conditions,
      incumbentSuccesses,
      searchSuccesses,
    );
    return measured === undefined ? [] : [measured];
  });
  if (eligible.length === 0) return { kind: 'RetainIncumbent', reason: 'NoEligibleImprovement' };

  let survivors = eligible.filter(
    (candidate) => !eligible.some((other) => other !== candidate && dominates(other, candidate)),
  );
  const greatestSuccesses = Math.max(...survivors.map((candidate) => candidate.successes));
  survivors = survivors.filter((candidate) => candidate.successes === greatestSuccesses);
  const greatestHeldOut = Math.max(...survivors.map((candidate) => candidate.heldOutPasses));
  survivors = survivors.filter((candidate) => candidate.heldOutPasses === greatestHeldOut);
  const fewestRepeatedFailures = Math.min(
    ...survivors.map((candidate) => candidate.repeatedFailures),
  );
  survivors = survivors.filter(
    (candidate) => candidate.repeatedFailures === fewestRepeatedFailures,
  );
  const fewestTokens = Math.min(...survivors.map((candidate) => candidate.medianTokens));
  survivors = survivors.filter((candidate) =>
    withinFivePercent(candidate.medianTokens, fewestTokens),
  );
  const shortestElapsed = Math.min(
    ...survivors.map((candidate) => candidate.medianElapsedMilliseconds),
  );
  survivors = survivors.filter((candidate) =>
    withinFivePercent(candidate.medianElapsedMilliseconds, shortestElapsed),
  );
  const winner = survivors[0];
  return survivors.length === 1 && winner !== undefined
    ? {
        kind: 'CandidateSelected',
        arm: winner.candidate.arm,
        revisionSaid: winner.candidate.revisionSaid,
      }
    : { kind: 'RetainIncumbent', reason: 'MultipleSurvivors' };
}
