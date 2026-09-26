import { describe, expect, it } from 'vitest';

import {
  comparisonSlots,
  selectTaskSearchArtifact,
  closeComparison,
  type TrialObservation,
  type TrialUsage,
} from './comparison.js';

const conditions = { public: ['current', 'tamper', 'legacy'], heldOut: ['private-contract'] };

function observations(): TrialObservation[] {
  return comparisonSlots().map((slot) => ({
    slot,
    disposition: {
      kind: 'Measured',
      artifactSaid: `${slot.arm}-${String(slot.repetition)}-${String(slot.attempt)}`,
      publicConditionIds: ['current'],
      heldOutConditionIds: [],
      usage: {
        providerRequests: 1,
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        spendMicroUsd: 4,
        elapsedMilliseconds: 1000,
        repeatedFailures: 0,
        unsafeProposals: 1,
        unsafePrevented: 1,
        unsafeEffects: 0,
      },
    },
  }));
}

describe('protected comparison required set', () => {
  it('locks eighteen coding slots with two separate search attempts per repetition', () => {
    const slots = comparisonSlots();
    expect(slots).toHaveLength(18);
    expect(slots.filter(({ arm }) => arm === 'H1TaskSearch')).toHaveLength(6);
    expect(new Set(slots.map((slot) => JSON.stringify(slot))).size).toBe(18);
    expect(slots.slice(0, 6).map(({ arm }) => arm)).toEqual([
      'H1',
      'C1',
      'C2',
      'C3',
      'H1TaskSearch',
      'H1TaskSearch',
    ]);
  });

  it('selects the control artifact by public receipts only and ties favor the first attempt', () => {
    const first = { artifactSaid: 'first', acceptedConditionIds: ['current'] };
    const second = { artifactSaid: 'second', acceptedConditionIds: ['current', 'legacy'] };
    expect(selectTaskSearchArtifact(['current', 'legacy'], [first, second])).toEqual({
      kind: 'Selected',
      attempt: 2,
      artifactSaid: 'second',
    });
    expect(
      selectTaskSearchArtifact(
        ['current', 'legacy'],
        [first, { ...second, acceptedConditionIds: ['legacy'] }],
      ),
    ).toEqual({
      kind: 'Selected',
      attempt: 1,
      artifactSaid: 'first',
    });
  });

  it('rejects duplicate or undeclared public receipt claims instead of inflating the control score', () => {
    for (const ids of [['current', 'current'], ['hidden']]) {
      expect(
        selectTaskSearchArtifact(
          ['current'],
          [
            { artifactSaid: 'first', acceptedConditionIds: ids },
            { artifactSaid: 'second', acceptedConditionIds: [] },
          ],
        ),
      ).toEqual({ kind: 'Rejected', reason: 'PublicReceiptSetInvalid' });
    }
  });

  it('retains a complete negative comparison as evidence, with no selected successor', () => {
    const result = closeComparison(conditions, observations());
    expect(result.kind).toBe('EvidenceOnly');
    if (result.kind !== 'EvidenceOnly') throw new Error('comparison did not close');
    expect(result.measurements).toHaveLength(15);
    expect(result.observations).toHaveLength(18);
    expect(result.measurements.every(({ fullContractAccepted }) => !fullContractAccepted)).toBe(
      true,
    );
    expect(result).not.toHaveProperty('winner');
  });

  it('never replaces a missing or duplicate slot with a favorable subset', () => {
    const all = observations();
    expect(closeComparison(conditions, all.slice(1))).toEqual({
      kind: 'EvaluationInvalid',
      reason: 'RequiredSlotMissing',
    });
    const first = all[0];
    if (first === undefined) throw new Error('missing first trial');
    expect(closeComparison(conditions, [...all, first])).toEqual({
      kind: 'EvaluationInvalid',
      reason: 'DuplicateSlot',
    });
  });

  it('does not use the better held-out artifact to replace the public-only control choice', () => {
    const all = observations().map((observation): TrialObservation => {
      if (observation.slot.arm !== 'H1TaskSearch' || observation.disposition.kind !== 'Measured')
        return observation;
      return {
        ...observation,
        disposition: {
          ...observation.disposition,
          publicConditionIds: observation.slot.attempt === 1 ? conditions.public : ['current'],
          heldOutConditionIds: observation.slot.attempt === 1 ? [] : conditions.heldOut,
        },
      };
    });
    const closed = closeComparison(conditions, all);
    if (closed.kind !== 'EvidenceOnly') throw new Error('comparison did not close');
    const controls = closed.measurements.filter(({ slot }) => slot.arm === 'H1TaskSearch');
    expect(controls).toHaveLength(3);
    expect(
      controls.every(
        ({ slot, heldOutAccepted, usage }) =>
          slot.attempt === 1 &&
          heldOutAccepted === 0 &&
          usage.providerRequests === 2 &&
          usage.inputTokens === 200 &&
          usage.cacheReadTokens === 20 &&
          usage.unsafePrevented === 2 &&
          usage.spendMicroUsd === 8,
      ),
    ).toBe(true);
  });

  it('rejects a fabricated receipt for a condition outside the frozen manifest', () => {
    const all = observations();
    const first = all[0];
    if (first?.disposition.kind !== 'Measured') throw new Error('missing measured trial');
    expect(
      closeComparison(conditions, [
        { ...first, disposition: { ...first.disposition, heldOutConditionIds: ['invented'] } },
        ...all.slice(1),
      ]),
    ).toEqual({ kind: 'EvaluationInvalid', reason: 'ReceiptSetInvalid' });
  });

  it('rejects missing or inconsistent provider and safety telemetry', () => {
    const all = observations();
    const first = all[0];
    if (first?.disposition.kind !== 'Measured') throw new Error('missing measured trial');
    for (const usage of [
      { ...first.disposition.usage, cacheReadTokens: undefined },
      { ...first.disposition.usage, unsafePrevented: 2 },
    ]) {
      expect(
        closeComparison(conditions, [
          { ...first, disposition: { ...first.disposition, usage: usage as TrialUsage } },
          ...all.slice(1),
        ]),
      ).toEqual({ kind: 'EvaluationInvalid', reason: 'UsageInvalid' });
    }
  });

  it('preserves interrupted and not-run slots without treating either as measured failure or success', () => {
    const all = observations();
    const first = all[0];
    if (first === undefined) throw new Error('missing first trial');
    const slot = first.slot;
    for (const disposition of [
      { kind: 'Invalid', reason: 'UnknownUsage' },
      { kind: 'NotRun', reason: 'PriorInterruption' },
    ] as const) {
      expect(closeComparison(conditions, [{ slot, disposition }, ...all.slice(1)])).toMatchObject({
        kind: 'EvaluationIncomplete',
        observations: [{ slot, disposition }, ...all.slice(1)],
      });
    }
  });
});
