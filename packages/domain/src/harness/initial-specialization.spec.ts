import { describe, expect, it } from 'vitest';

import { acceptInitialSpecialization } from './initial-specialization.js';

const awaiting = {
  kind: 'AwaitingRunAdmission' as const,
  harnessLineageId: 'lineage-1',
  harnessRevisionSaid: 'EHarness',
};

describe('initial Harness specialization', () => {
  it('accepts H1 inception once and reconciles only the exact same Run binding', () => {
    const input = {
      harnessLineageId: 'lineage-1',
      harnessRevisionSaid: 'EHarness',
      runId: 'run-1',
      acceptedAt: '2026-09-24T20:00:00.000Z',
      purpose: {
        kind: 'PreparedCompatibilityCalibration' as const,
        campaignId: 'campaign-1',
        ordinal: 1 as const,
      },
    };

    const accepted = acceptInitialSpecialization(awaiting, input);
    expect(accepted).toEqual({
      kind: 'Accepted',
      activation: {
        kind: 'InitialSpecializationAccepted',
        harnessLineageId: input.harnessLineageId,
        harnessRevisionSaid: input.harnessRevisionSaid,
        runId: input.runId,
        acceptedAt: input.acceptedAt,
      },
    });
    if (accepted.kind !== 'Accepted') {
      return;
    }
    expect(acceptInitialSpecialization(accepted.activation, input)).toEqual({
      kind: 'Equivalent',
      activation: accepted.activation,
    });
    expect(
      acceptInitialSpecialization(accepted.activation, { ...input, runId: 'another-run' }),
    ).toEqual({ kind: 'IncumbentConflict', incumbent: accepted.activation });

    expect(
      acceptInitialSpecialization(accepted.activation, {
        ...input,
        runId: 'run-2',
        acceptedAt: '2026-09-24T20:10:00.000Z',
        purpose: {
          kind: 'PreparedCompatibilityCalibration',
          campaignId: 'campaign-1',
          ordinal: 2,
        },
      }),
    ).toEqual({ kind: 'IncumbentConfirmed', activation: accepted.activation });
    expect(
      acceptInitialSpecialization(accepted.activation, {
        ...input,
        harnessRevisionSaid: 'EAnotherHarness',
        runId: 'run-2',
        purpose: {
          kind: 'PreparedCompatibilityCalibration',
          campaignId: 'campaign-1',
          ordinal: 2,
        },
      }),
    ).toEqual({ kind: 'IncumbentConflict', incumbent: accepted.activation });
    expect(
      acceptInitialSpecialization(accepted.activation, {
        ...input,
        runId: 'run-retained',
        acceptedAt: '2026-09-24T21:00:00.000Z',
        purpose: { kind: 'Retained' },
      }),
    ).toEqual({ kind: 'IncumbentConfirmed', activation: accepted.activation });
  });

  it('rejects an inception input for a different immutable H1 binding', () => {
    expect(
      acceptInitialSpecialization(awaiting, {
        harnessLineageId: 'lineage-1',
        harnessRevisionSaid: 'EOtherHarness',
        runId: 'run-1',
        acceptedAt: '2026-09-24T20:00:00.000Z',
        purpose: {
          kind: 'PreparedCompatibilityCalibration',
          campaignId: 'campaign-1',
          ordinal: 1,
        },
      }),
    ).toEqual({ kind: 'HarnessBindingConflict' });
  });

  it('requires the first calibration Run before later calibration or retained admission', () => {
    const binding = {
      harnessLineageId: 'lineage-1',
      harnessRevisionSaid: 'EHarness',
      runId: 'run-2',
      acceptedAt: '2026-09-24T20:10:00.000Z',
    };

    expect(
      acceptInitialSpecialization(awaiting, {
        ...binding,
        purpose: {
          kind: 'PreparedCompatibilityCalibration',
          campaignId: 'campaign-1',
          ordinal: 2,
        },
      }),
    ).toEqual({ kind: 'InitialCalibrationRequired' });
    expect(
      acceptInitialSpecialization(awaiting, { ...binding, purpose: { kind: 'Retained' } }),
    ).toEqual({ kind: 'InitialCalibrationRequired' });
  });
});
