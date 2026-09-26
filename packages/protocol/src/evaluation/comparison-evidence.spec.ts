import { describe, expect, it } from 'vitest';

import {
  decodeComparisonMeasurementEvidence,
  decodeTrialObservationEvidence,
  prepareComparisonMeasurementEvidence,
  prepareTrialObservationEvidence,
} from './comparison-evidence.js';

const said = (character: string): string => `E${character.repeat(43)}`;
const evaluationId = '81d7f67f-d2f9-4fae-87cc-ac827de6f0d1';
const slot = { arm: 'H1' as const, repetition: 1 as const, attempt: 1 as const };
const usage = {
  providerRequests: 1,
  inputTokens: 100,
  outputTokens: 10,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  spendMicroUsd: 100,
  elapsedMilliseconds: 1000,
  repeatedFailures: 0,
  unsafeProposals: 0,
  unsafePrevented: 0,
  unsafeEffects: 0,
};
const observation = {
  version: 1 as const,
  kind: 'TrialObservationEvidence' as const,
  evaluationId,
  manifestSaid: said('m'),
  harnessRevisionSaid: said('h'),
  observation: {
    slot,
    disposition: {
      kind: 'Measured' as const,
      artifactSaid: said('a'),
      publicConditionIds: ['cesr-current'],
      heldOutConditionIds: [said('p')],
      usage,
    },
  },
  capturedSourceSaid: said('s'),
  trialEvidenceHeadSaid: said('t'),
  trialCleanupReceiptSaid: said('u'),
  publicObservations: [
    { conditionId: 'cesr-current', rawObservationSaid: said('v'), verdict: 'Pass' as const },
  ],
  protectedObservationSaid: said('w'),
  protectedVerdict: 'Pass' as const,
  protectedCleanupReceiptSaid: said('x'),
  providerUsageEventSaids: [said('y')],
};

describe('typed E3 comparison evidence artifacts', () => {
  it('binds a measured slot and exact raw observation references to canonical bytes', () => {
    const prepared = prepareTrialObservationEvidence(observation);
    if (prepared.kind !== 'Prepared') throw new Error(prepared.reason);
    expect(decodeTrialObservationEvidence(prepared.artifact, prepared.bytes)).toEqual({
      kind: 'Accepted',
      evidence: observation,
      artifact: prepared.artifact,
      bytes: prepared.bytes,
    });
    expect(
      decodeTrialObservationEvidence(prepared.artifact, new TextEncoder().encode('{}')).kind,
    ).toBe('Rejected');
    expect(
      prepareTrialObservationEvidence({
        ...observation,
        publicObservations: [{ ...observation.publicObservations[0], conditionId: 'other' }],
      }).kind,
    ).toBe('Rejected');
  });

  it('binds a measurement to its selected observation artifact', () => {
    const observed = prepareTrialObservationEvidence(observation);
    if (observed.kind !== 'Prepared') throw new Error(observed.reason);
    const measurement = {
      version: 1 as const,
      kind: 'ComparisonMeasurementEvidence' as const,
      evaluationId,
      manifestSaid: said('m'),
      harnessRevisionSaid: said('h'),
      measurement: {
        slot,
        artifactSaid: said('a'),
        fullContractAccepted: true,
        publicAccepted: 1,
        heldOutAccepted: 1,
        usage,
      },
      sourceObservationSaids: [observed.artifact.d],
    };
    const prepared = prepareComparisonMeasurementEvidence(measurement);
    if (prepared.kind !== 'Prepared') throw new Error(prepared.reason);
    expect(decodeComparisonMeasurementEvidence(prepared.artifact, prepared.bytes)).toEqual({
      kind: 'Accepted',
      evidence: measurement,
      artifact: prepared.artifact,
      bytes: prepared.bytes,
    });
    expect(
      prepareComparisonMeasurementEvidence({ ...measurement, sourceObservationSaids: [] }).kind,
    ).toBe('Rejected');
  });
});
