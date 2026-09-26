import { describe, expect, it } from 'vitest';

import type {
  PreparedCompatibilityCalibrationOrdinal,
  PreparedCompatibilityFailureCategory,
  Run,
  RunEndedOutcome,
} from '@devrandom/domain';

import { runFixture } from '../test/run-fixture.js';
import { assessRunPurposeAdmission } from './run-purpose-admission.js';

const campaignId = '4dd443a3-d93c-4857-8ede-b08aa3f979c5';

const category: PreparedCompatibilityFailureCategory = {
  version: 1,
  taskId: runFixture().binding.taskId,
  taskRevisionSaid: runFixture().binding.taskRevisionSaid,
  harnessRevisionSaid: runFixture().binding.initialHarnessRevisionSaid,
  currentCommandSaid: `E${'j'.repeat(43)}`,
  tamperCommandSaid: `E${'k'.repeat(43)}`,
  legacyCommandSaid: `E${'l'.repeat(43)}`,
  legacyObservedExitCode: 101,
};

function calibrationRun(
  ordinal: PreparedCompatibilityCalibrationOrdinal,
  outcome: RunEndedOutcome = {
    kind: 'CalibrationConfirmed',
    checkpointSaid: `E${String(ordinal).repeat(43)}`,
    category,
  },
): Run {
  const base = runFixture();
  const firstRunId = '0d8a803b-fead-4f22-99a2-489eb5577f25';
  const runId =
    ordinal === 1 ? firstRunId : `00000000-0000-4000-8000-00000000000${String(ordinal)}`;
  return {
    ...base,
    binding: {
      ...base.binding,
      runId,
      commandId: `10000000-0000-4000-8000-00000000000${String(ordinal)}`,
      evidenceStreamId: `20000000-0000-4000-8000-00000000000${String(ordinal)}`,
      purpose: { kind: 'PreparedCompatibilityCalibration', campaignId, ordinal },
      initialSpecialization: {
        ...base.binding.initialSpecialization,
        runId: firstRunId,
        acceptedAt: '2026-09-24T19:55:00.000Z',
      },
    },
    lifecycle: { kind: 'Ended', outcome },
    submissionVerification: { kind: 'Rejected' },
  };
}

function proposedCalibration(ordinal: PreparedCompatibilityCalibrationOrdinal): Run {
  const prior = calibrationRun(ordinal);
  return {
    ...prior,
    lifecycle: { kind: 'Active', phase: { kind: 'Preparing' } },
    submissionVerification: { kind: 'NotSubmitted' },
  };
}

function retainedRun(): Run {
  const base = runFixture();
  return {
    ...base,
    binding: {
      ...base.binding,
      initialSpecialization: {
        ...base.binding.initialSpecialization,
        runId: '0d8a803b-fead-4f22-99a2-489eb5577f25',
        acceptedAt: '2026-09-24T19:55:00.000Z',
      },
    },
  };
}

describe('Run purpose admission', () => {
  it('admits only the next calibration after every prior ordinal is terminal', () => {
    const first = calibrationRun(1);
    const prior = [first, calibrationRun(2), calibrationRun(3), calibrationRun(4)];

    expect(assessRunPurposeAdmission(prior, proposedCalibration(5))).toEqual({
      kind: 'RunPurposeAdmitted',
    });
    expect(
      assessRunPurposeAdmission(
        [{ ...first, lifecycle: { kind: 'Active', phase: { kind: 'Running' } } }],
        proposedCalibration(2),
      ),
    ).toEqual({ kind: 'PriorCalibrationTerminalRequired', runId: first.binding.runId });
    expect(assessRunPurposeAdmission(prior.slice(0, 3), proposedCalibration(5))).toEqual({
      kind: 'CalibrationOrdinalNotNext',
      nextOrdinal: 4,
    });
  });

  it('admits one retained Run after five calibrations with four identical confirmations', () => {
    const calibrations = [
      calibrationRun(1),
      calibrationRun(2),
      calibrationRun(3),
      calibrationRun(4),
      calibrationRun(5, {
        kind: 'CalibrationExcluded',
        checkpointSaid: `E${'q'.repeat(43)}`,
        reason: 'ProviderUnavailable',
      }),
    ];

    expect(assessRunPurposeAdmission(calibrations, retainedRun())).toEqual({
      kind: 'RunPurposeAdmitted',
    });
  });

  it('keeps retention closed after a rejection or a changed confirmed category', () => {
    const last = calibrationRun(5, {
      kind: 'CalibrationRejected',
      checkpointSaid: `E${'r'.repeat(43)}`,
      reason: 'H1Passed',
    });
    const rejected = [
      calibrationRun(1),
      calibrationRun(2),
      calibrationRun(3),
      calibrationRun(4),
      last,
    ];
    expect(assessRunPurposeAdmission(rejected, retainedRun())).toEqual({
      kind: 'CalibrationCampaignRejected',
      runId: last.binding.runId,
    });

    const changed = {
      ...category,
      currentCommandSaid: `E${'m'.repeat(43)}`,
    };
    const mismatched = [
      calibrationRun(1),
      calibrationRun(2),
      calibrationRun(3),
      calibrationRun(4),
      calibrationRun(5, {
        kind: 'CalibrationConfirmed',
        checkpointSaid: `E${'s'.repeat(43)}`,
        category: changed,
      }),
    ];
    expect(assessRunPurposeAdmission(mismatched, retainedRun())).toEqual({
      kind: 'CalibrationConfirmationCategoryMismatch',
    });
  });

  it('distinguishes an existing active retained Run from its terminal history', () => {
    const active = retainedRun();
    const ended: Run = {
      ...active,
      lifecycle: {
        kind: 'Ended',
        outcome: {
          kind: 'Failed',
          failure: 'LocalStateCorruption',
          checkpointSaid: `E${'t'.repeat(43)}`,
        },
      },
    };

    expect(assessRunPurposeAdmission([active], retainedRun())).toEqual({
      kind: 'ExistingRetainedRunActive',
      runId: active.binding.runId,
    });
    expect(assessRunPurposeAdmission([ended], retainedRun())).toEqual({
      kind: 'ExistingRetainedRunEnded',
      runId: ended.binding.runId,
    });
  });

  it('rejects a later Run whose incumbent H1 acceptance differs', () => {
    const first = calibrationRun(1);
    const second = proposedCalibration(2);
    const changed: Run = {
      ...second,
      binding: {
        ...second.binding,
        initialSpecialization: {
          ...second.binding.initialSpecialization,
          acceptedAt: '2026-09-24T19:56:00.000Z',
        },
      },
    };

    expect(assessRunPurposeAdmission([first], changed)).toEqual({
      kind: 'InitialSpecializationMismatch',
    });
  });
});
