/** Frozen demo schedule: three repetitions, four single attempts and two search attempts. */
export interface ComparisonSlot {
  readonly arm: 'H1' | 'C1' | 'C2' | 'C3' | 'H1TaskSearch';
  readonly repetition: 1 | 2 | 3;
  readonly attempt: 1 | 2;
}

export interface ComparisonConditions {
  readonly public: readonly string[];
  readonly heldOut: readonly string[];
}

export interface TrialUsage {
  readonly providerRequests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly spendMicroUsd: number;
  readonly elapsedMilliseconds: number;
  readonly repeatedFailures: number;
  readonly unsafeProposals: number;
  readonly unsafePrevented: number;
  readonly unsafeEffects: number;
}

const usageFields = [
  'providerRequests',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'spendMicroUsd',
  'elapsedMilliseconds',
  'repeatedFailures',
  'unsafeProposals',
  'unsafePrevented',
  'unsafeEffects',
] as const satisfies readonly (keyof TrialUsage)[];

function validUsage(usage: TrialUsage): boolean {
  return (
    usageFields.every((field) => Number.isSafeInteger(usage[field]) && usage[field] >= 0) &&
    usage.unsafePrevented + usage.unsafeEffects <= usage.unsafeProposals
  );
}

export interface MeasuredTrial {
  readonly kind: 'Measured';
  readonly artifactSaid: string;
  readonly publicConditionIds: readonly string[];
  readonly heldOutConditionIds: readonly string[];
  readonly usage: TrialUsage;
}

export interface TrialObservation {
  readonly slot: ComparisonSlot;
  readonly disposition:
    | MeasuredTrial
    | {
        readonly kind: 'Invalid';
        readonly reason:
          | 'UnknownUsage'
          | 'ProfileDrift'
          | 'MissingArtifact'
          | 'Interrupted'
          | 'CleanupUnconfirmed';
      }
    | {
        readonly kind: 'NotRun';
        readonly reason: 'PriorInterruption' | 'AuthorityUnavailable' | 'BudgetUnavailable';
      };
}

export interface PublicTaskSearchArtifact {
  readonly artifactSaid: string;
  readonly acceptedConditionIds: readonly string[];
}

export type TaskSearchSelection =
  | { readonly kind: 'Selected'; readonly attempt: 1 | 2; readonly artifactSaid: string }
  | { readonly kind: 'Rejected'; readonly reason: 'PublicReceiptSetInvalid' };

export interface ComparisonMeasurement {
  readonly slot: ComparisonSlot;
  readonly artifactSaid: string;
  readonly fullContractAccepted: boolean;
  readonly publicAccepted: number;
  readonly heldOutAccepted: number;
  /** Search cost includes both attempts, including the unselected artifact. */
  readonly usage: TrialUsage;
}

export type ComparisonClosure =
  | {
      readonly kind: 'EvidenceOnly';
      readonly observations: readonly TrialObservation[];
      readonly measurements: readonly ComparisonMeasurement[];
    }
  | { readonly kind: 'EvaluationIncomplete'; readonly observations: readonly TrialObservation[] }
  | {
      readonly kind: 'EvaluationInvalid';
      readonly reason:
        | 'RequiredSlotMissing'
        | 'DuplicateSlot'
        | 'UnexpectedSlot'
        | 'ConditionSetInvalid'
        | 'ReceiptSetInvalid'
        | 'UsageInvalid'
        | 'ArtifactMissing';
    };

export function comparisonSlots(): readonly ComparisonSlot[] {
  const slots: ComparisonSlot[] = [];
  for (const repetition of [1, 2, 3] as const) {
    for (const arm of ['H1', 'C1', 'C2', 'C3'] as const) {
      slots.push({ arm, repetition, attempt: 1 });
    }
    slots.push({ arm: 'H1TaskSearch', repetition, attempt: 1 });
    slots.push({ arm: 'H1TaskSearch', repetition, attempt: 2 });
  }
  return slots;
}

function uniqueNonempty(values: readonly string[]): boolean {
  return values.every((value) => value.length > 0) && new Set(values).size === values.length;
}

function validReceipts(required: readonly string[], accepted: readonly string[]): boolean {
  return uniqueNonempty(accepted) && accepted.every((value) => required.includes(value));
}

/** This conversation intentionally has no held-out observations or scores as inputs. */
export function selectTaskSearchArtifact(
  requiredPublicConditions: readonly string[],
  attempts: readonly [PublicTaskSearchArtifact, PublicTaskSearchArtifact],
): TaskSearchSelection {
  if (
    requiredPublicConditions.length === 0 ||
    !uniqueNonempty(requiredPublicConditions) ||
    attempts.some(
      (attempt) =>
        attempt.artifactSaid.length === 0 ||
        !validReceipts(requiredPublicConditions, attempt.acceptedConditionIds),
    )
  ) {
    return { kind: 'Rejected', reason: 'PublicReceiptSetInvalid' };
  }
  const attempt =
    attempts[1].acceptedConditionIds.length > attempts[0].acceptedConditionIds.length ? 2 : 1;
  return { kind: 'Selected', attempt, artifactSaid: attempts[attempt - 1]?.artifactSaid ?? '' };
}

function slotIdentity(slot: ComparisonSlot): string {
  return `${slot.arm}:${String(slot.repetition)}:${String(slot.attempt)}`;
}

function combineUsage(first: TrialUsage, second: TrialUsage): TrialUsage {
  return {
    providerRequests: first.providerRequests + second.providerRequests,
    inputTokens: first.inputTokens + second.inputTokens,
    outputTokens: first.outputTokens + second.outputTokens,
    cacheReadTokens: first.cacheReadTokens + second.cacheReadTokens,
    cacheWriteTokens: first.cacheWriteTokens + second.cacheWriteTokens,
    spendMicroUsd: first.spendMicroUsd + second.spendMicroUsd,
    elapsedMilliseconds: first.elapsedMilliseconds + second.elapsedMilliseconds,
    repeatedFailures: first.repeatedFailures + second.repeatedFailures,
    unsafeProposals: first.unsafeProposals + second.unsafeProposals,
    unsafePrevented: first.unsafePrevented + second.unsafePrevented,
    unsafeEffects: first.unsafeEffects + second.unsafeEffects,
  };
}

/** Completeness and descriptive measurement only. Promotion and audit are separate owners. */
export function closeComparison(
  conditions: ComparisonConditions,
  observations: readonly TrialObservation[],
): ComparisonClosure {
  if (
    conditions.public.length === 0 ||
    conditions.heldOut.length === 0 ||
    !uniqueNonempty([...conditions.public, ...conditions.heldOut])
  ) {
    return { kind: 'EvaluationInvalid', reason: 'ConditionSetInvalid' };
  }
  const expected = comparisonSlots();
  const bySlot = new Map<string, TrialObservation>();
  for (const observation of observations) {
    const identity = slotIdentity(observation.slot);
    if (!expected.some((slot) => slotIdentity(slot) === identity))
      return { kind: 'EvaluationInvalid', reason: 'UnexpectedSlot' };
    if (bySlot.has(identity)) return { kind: 'EvaluationInvalid', reason: 'DuplicateSlot' };
    bySlot.set(identity, observation);
    const trial = observation.disposition;
    if (trial.kind !== 'Measured') continue;
    if (trial.artifactSaid.length === 0)
      return { kind: 'EvaluationInvalid', reason: 'ArtifactMissing' };
    if (
      !validReceipts(conditions.public, trial.publicConditionIds) ||
      !validReceipts(conditions.heldOut, trial.heldOutConditionIds)
    )
      return { kind: 'EvaluationInvalid', reason: 'ReceiptSetInvalid' };
    if (!validUsage(trial.usage)) return { kind: 'EvaluationInvalid', reason: 'UsageInvalid' };
  }
  if (bySlot.size !== expected.length)
    return { kind: 'EvaluationInvalid', reason: 'RequiredSlotMissing' };
  if (observations.some(({ disposition }) => disposition.kind !== 'Measured'))
    return { kind: 'EvaluationIncomplete', observations };
  const measurements: ComparisonMeasurement[] = [];
  for (const slot of expected) {
    if (slot.attempt === 2) continue;
    const observation = bySlot.get(slotIdentity(slot));
    if (observation?.disposition.kind !== 'Measured')
      return { kind: 'EvaluationIncomplete', observations };
    let trial = observation.disposition;
    let usage = trial.usage;
    let selectedSlot = slot;
    if (slot.arm === 'H1TaskSearch') {
      const secondSlot: ComparisonSlot = { ...slot, attempt: 2 };
      const second = bySlot.get(slotIdentity(secondSlot));
      if (second?.disposition.kind !== 'Measured')
        return { kind: 'EvaluationIncomplete', observations };
      const selection = selectTaskSearchArtifact(conditions.public, [
        { artifactSaid: trial.artifactSaid, acceptedConditionIds: trial.publicConditionIds },
        {
          artifactSaid: second.disposition.artifactSaid,
          acceptedConditionIds: second.disposition.publicConditionIds,
        },
      ]);
      if (selection.kind === 'Rejected')
        return { kind: 'EvaluationInvalid', reason: 'ReceiptSetInvalid' };
      usage = combineUsage(trial.usage, second.disposition.usage);
      if (!validUsage(usage)) return { kind: 'EvaluationInvalid', reason: 'UsageInvalid' };
      if (selection.attempt === 2) {
        trial = second.disposition;
        selectedSlot = secondSlot;
      }
    }
    measurements.push({
      slot: selectedSlot,
      artifactSaid: trial.artifactSaid,
      fullContractAccepted:
        trial.publicConditionIds.length === conditions.public.length &&
        trial.heldOutConditionIds.length === conditions.heldOut.length,
      publicAccepted: trial.publicConditionIds.length,
      heldOutAccepted: trial.heldOutConditionIds.length,
      usage,
    });
  }
  return { kind: 'EvidenceOnly', observations, measurements };
}
