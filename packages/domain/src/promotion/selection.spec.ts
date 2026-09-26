import { describe, expect, it } from 'vitest';

import {
  comparisonSlots,
  type TrialObservation,
  type TrialUsage,
} from '../evaluation/comparison.js';
import {
  selectPromotion,
  type CandidatePromotionAssessment,
  type PromotionSelectionInput,
  type SevenObligationAssessment,
} from './selection.js';

const passingAudit: SevenObligationAssessment = {
  measurementValidity: 'Pass',
  representationalFidelity: 'Pass',
  proceduralIntegrity: 'Pass',
  authorizationAndAccess: 'Pass',
  protectedArtifactAndStateIntegrity: 'Pass',
  provenanceAndSourceAttribution: 'Pass',
  requiredSetCompleteness: 'Pass',
};

function usage(tokens: number, elapsedMilliseconds: number, repeatedFailures = 0): TrialUsage {
  return {
    providerRequests: 1,
    inputTokens: tokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    spendMicroUsd: 1,
    elapsedMilliseconds,
    repeatedFailures,
    unsafeProposals: 0,
    unsafePrevented: 0,
    unsafeEffects: 0,
  };
}

type Arm = 'H1' | 'H1TaskSearch' | 'C1' | 'C2' | 'C3';
type CandidateArm = 'C1' | 'C2' | 'C3';

interface FixtureOptions {
  readonly successes?: Partial<Record<Arm, number>>;
  readonly tokens?: Partial<Record<Arm, number>>;
  readonly elapsed?: Partial<Record<Arm, number>>;
  readonly repeatedFailures?: Partial<Record<CandidateArm, number>>;
}

function fixture(options: FixtureOptions = {}): PromotionSelectionInput {
  const successes = options.successes ?? {};
  const observations: TrialObservation[] = comparisonSlots().map((slot) => {
    const accepted = slot.repetition <= (successes[slot.arm] ?? (slot.arm.startsWith('C') ? 3 : 0));
    const artifactSaid = `${slot.arm}-${String(slot.repetition)}-${String(slot.attempt)}`;
    return {
      slot,
      disposition: {
        kind: 'Measured',
        artifactSaid,
        publicConditionIds: accepted ? ['public'] : [],
        heldOutConditionIds: accepted ? ['heldout'] : [],
        usage: usage(
          options.tokens?.[slot.arm] ?? 100,
          options.elapsed?.[slot.arm] ?? 100,
          options.repeatedFailures?.[slot.arm as CandidateArm] ?? 0,
        ),
      },
    };
  });
  const candidates: CandidatePromotionAssessment[] = (['C1', 'C2', 'C3'] as const).map((arm) => ({
    arm,
    revisionSaid: `${arm}-revision`,
    audit: passingAudit,
    budget: 'WithinCeiling',
    prohibitedAttempts: [],
    repetitions: ([1, 2, 3] as const).map((repetition) => ({
      repetition,
      artifactSaid: `${arm}-${String(repetition)}-1`,
      artifactBinding: 'Matched',
      tamper: 'Rejected',
    })),
  }));
  return {
    conditions: { public: ['public'], heldOut: ['heldout'] },
    observations,
    sharedAudit: passingAudit,
    evaluationAuthority: 'Current',
    allocation: 'WithinCeiling',
    evidence: 'Acknowledged',
    candidates,
  };
}

function replaceCandidate(
  input: PromotionSelectionInput,
  arm: CandidateArm,
  change: (candidate: CandidatePromotionAssessment) => CandidatePromotionAssessment,
): PromotionSelectionInput {
  return {
    ...input,
    candidates: input.candidates.map((candidate) =>
      candidate.arm === arm ? change(candidate) : candidate,
    ),
  };
}

describe('E4 local promotion selection', () => {
  it('blocks before ranking when required trials or the shared seven-obligation audit are incomplete', () => {
    const input = fixture();
    expect(selectPromotion({ ...input, observations: input.observations.slice(1) })).toEqual({
      kind: 'SelectionBlocked',
      reason: 'ComparisonIncomplete',
    });
    expect(
      selectPromotion({
        ...input,
        sharedAudit: { ...passingAudit, requiredSetCompleteness: 'Incomplete' },
      }),
    ).toEqual({ kind: 'SelectionBlocked', reason: 'SharedAuditNotPassed' });
  });

  it.each([
    ['evaluationAuthority', 'Unavailable', 'AuthorityUnavailable'],
    ['allocation', 'Exceeded', 'AllocationUnavailable'],
    ['evidence', 'Unacknowledged', 'EvidenceUnacknowledged'],
  ] as const)('blocks on %s without treating scores as authority', (field, value, reason) => {
    expect(selectPromotion({ ...fixture(), [field]: value })).toEqual({
      kind: 'SelectionBlocked',
      reason,
    });
  });

  it('requires the complete, distinct C1/C2/C3 candidate set', () => {
    const input = fixture();
    const first = input.candidates.find((candidate) => candidate.arm === 'C1');
    const third = input.candidates.find((candidate) => candidate.arm === 'C3');
    if (first === undefined || third === undefined) throw new Error('fixture candidates missing');
    expect(selectPromotion({ ...input, candidates: input.candidates.slice(0, 2) })).toEqual({
      kind: 'SelectionBlocked',
      reason: 'CandidateSetInvalid',
    });
    expect(
      selectPromotion({
        ...input,
        candidates: [first, first, third],
      }),
    ).toEqual({ kind: 'SelectionBlocked', reason: 'CandidateSetInvalid' });
  });

  it('retains H1 when a candidate is short of two additional successes over either control', () => {
    const againstH1 = fixture({ successes: { H1: 2 } });
    const againstSearch = fixture({ successes: { H1TaskSearch: 2 } });
    expect(selectPromotion(againstH1)).toEqual({
      kind: 'RetainIncumbent',
      reason: 'NoEligibleImprovement',
    });
    expect(selectPromotion(againstSearch)).toEqual({
      kind: 'RetainIncumbent',
      reason: 'NoEligibleImprovement',
    });
  });

  it('disqualifies a candidate with a failed case, tamper check, artifact binding or arm audit', () => {
    const base = fixture({ tokens: { C1: 100, C2: 200, C3: 300 } });
    const badCase = fixture({ successes: { C1: 2 }, tokens: { C2: 200, C3: 300 } });
    expect(selectPromotion(badCase)).toMatchObject({ kind: 'CandidateSelected', arm: 'C2' });
    const badTamper = replaceCandidate(base, 'C1', (candidate) => ({
      ...candidate,
      repetitions: candidate.repetitions.map((repetition) =>
        repetition.repetition === 2 ? { ...repetition, tamper: 'Accepted' } : repetition,
      ),
    }));
    expect(selectPromotion(badTamper)).toMatchObject({ kind: 'CandidateSelected', arm: 'C2' });
    const badArtifact = replaceCandidate(base, 'C1', (candidate) => ({
      ...candidate,
      repetitions: candidate.repetitions.map((repetition) =>
        repetition.repetition === 1
          ? { ...repetition, artifactSaid: 'substituted-artifact' }
          : repetition,
      ),
    }));
    expect(selectPromotion(badArtifact)).toMatchObject({
      kind: 'CandidateSelected',
      arm: 'C2',
    });
    const badAudit = replaceCandidate(base, 'C1', (candidate) => ({
      ...candidate,
      audit: { ...candidate.audit, authorizationAndAccess: 'Fail' },
    }));
    expect(selectPromotion(badAudit)).toMatchObject({ kind: 'CandidateSelected', arm: 'C2' });
  });

  it('does not let a high-scoring arm offset prohibited attempts, successful unsafe effects or budget excess', () => {
    const base = fixture({ tokens: { C1: 100, C2: 200, C3: 300 } });
    const prohibited = replaceCandidate(base, 'C1', (candidate) => ({
      ...candidate,
      prohibitedAttempts: ['HeldOutAccess'],
    }));
    expect(selectPromotion(prohibited)).toMatchObject({ kind: 'CandidateSelected', arm: 'C2' });
    const overBudget = replaceCandidate(base, 'C1', (candidate) => ({
      ...candidate,
      budget: 'Exceeded',
    }));
    expect(selectPromotion(overBudget)).toMatchObject({ kind: 'CandidateSelected', arm: 'C2' });
    const unsafeEffects = {
      ...base,
      observations: base.observations.map((observation) =>
        observation.slot.arm === 'C1' &&
        observation.slot.repetition === 1 &&
        observation.disposition.kind === 'Measured'
          ? {
              ...observation,
              disposition: {
                ...observation.disposition,
                usage: { ...observation.disposition.usage, unsafeProposals: 1, unsafeEffects: 1 },
              },
            }
          : observation,
      ),
    };
    expect(selectPromotion(unsafeEffects)).toMatchObject({
      kind: 'CandidateSelected',
      arm: 'C2',
    });
  });

  it('blocks the comparison if an incumbent or search-control effect escaped enforcement', () => {
    for (const arm of ['H1', 'H1TaskSearch'] as const) {
      const base = fixture({ tokens: { C1: 100, C2: 200, C3: 300 } });
      const observations = base.observations.map((observation) =>
        observation.slot.arm === arm &&
        observation.slot.repetition === 1 &&
        observation.disposition.kind === 'Measured'
          ? {
              ...observation,
              disposition: {
                ...observation.disposition,
                usage: { ...observation.disposition.usage, unsafeProposals: 1, unsafeEffects: 1 },
              },
            }
          : observation,
      );
      expect(selectPromotion({ ...base, observations })).toEqual({
        kind: 'SelectionBlocked',
        reason: 'ControlUnsafeEffectObserved',
      });
    }
  });

  it('selects by measured evidence regardless of candidate label', () => {
    const input = fixture({ tokens: { C1: 160, C2: 150, C3: 100 } });
    expect(selectPromotion(input)).toEqual({
      kind: 'CandidateSelected',
      arm: 'C3',
      revisionSaid: 'C3-revision',
    });
  });

  it('applies strict greater-than-five-percent Pareto cost improvement with integer arithmetic', () => {
    const over = fixture({ tokens: { C1: 100, C2: 106, C3: 200 } });
    expect(selectPromotion(over)).toMatchObject({ kind: 'CandidateSelected', arm: 'C1' });
    const exact = fixture({ tokens: { C1: 100, C2: 105, C3: 200 } });
    expect(selectPromotion(exact)).toEqual({
      kind: 'RetainIncumbent',
      reason: 'MultipleSurvivors',
    });
  });

  it('uses count priority, then the token and time five-percent bands; unresolved ties retain H1', () => {
    const count = fixture({
      tokens: { C1: 100, C2: 90, C3: 200 },
      elapsed: { C1: 100, C2: 90, C3: 200 },
      repeatedFailures: { C1: 0, C2: 1, C3: 2 },
    });
    expect(selectPromotion(count)).toMatchObject({ kind: 'CandidateSelected', arm: 'C1' });
    const time = fixture({
      tokens: { C1: 100, C2: 104, C3: 200 },
      elapsed: { C1: 106, C2: 100, C3: 200 },
    });
    expect(selectPromotion(time)).toMatchObject({ kind: 'CandidateSelected', arm: 'C2' });
    const tie = fixture({
      tokens: { C1: 100, C2: 104, C3: 200 },
      elapsed: { C1: 105, C2: 100, C3: 200 },
    });
    expect(selectPromotion(tie)).toEqual({
      kind: 'RetainIncumbent',
      reason: 'MultipleSurvivors',
    });
  });
});
