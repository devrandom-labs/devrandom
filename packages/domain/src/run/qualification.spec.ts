import { describe, expect, it } from 'vitest';

import type { Run } from './run.js';
import { assessFailureQualification, type SealedRunObservation } from './qualification.js';

const category = {
  version: 1 as const,
  taskId: 'task-1',
  taskRevisionSaid: 'revision-1',
  harnessRevisionSaid: 'h1',
  currentCommandSaid: 'current',
  tamperCommandSaid: 'tamper',
  legacyCommandSaid: 'legacy',
  legacyObservedExitCode: 101 as const,
};

function observation(ordinal: number, excluded = false): SealedRunObservation {
  const suffix = String(ordinal);
  const checkpointSaid = `checkpoint-${suffix}`;
  return {
    run: {
      binding: {
        runId: `run-${suffix}`,
        ownerAid: 'user',
        taskId: category.taskId,
        taskRevisionSaid: category.taskRevisionSaid,
        harnessLineageId: 'lineage',
        personalAgentAid: 'agent',
        governorAid: 'governor',
        taskMandateSaid: 'task-mandate',
        promotionMandateSaid: 'promotion-mandate',
        initialHarnessRevisionSaid: 'h1',
        purpose: { kind: 'PreparedCompatibilityCalibration', campaignId: 'campaign', ordinal },
        repository: { objectFormat: 'sha1', commit: 'commit', tree: 'tree' },
      },
      lifecycle: {
        kind: 'Ended',
        outcome: excluded
          ? { kind: 'CalibrationExcluded', checkpointSaid, reason: 'ProviderUnavailable' }
          : { kind: 'CalibrationConfirmed', checkpointSaid, category },
      },
      submissionVerification: { kind: excluded ? 'NotSubmitted' : 'Rejected' },
    } as Run,
    incarnationId: `incarnation-${suffix}`,
    worktreeId: `worktree-${suffix}`,
    executionProfileSaid: 'profile',
    seal: {
      kind: 'Acknowledged',
      runId: `run-${suffix}`,
      checkpointSaid,
      evidenceHeadSaid: `head-${suffix}`,
      sealSaid: `seal-${suffix}`,
      artifactSaids: [`artifact-${suffix}`],
    },
  };
}

function retained(): SealedRunObservation {
  const base = observation(6);
  return {
    ...base,
    run: {
      ...base.run,
      binding: { ...base.run.binding, purpose: { kind: 'Retained' } },
      lifecycle: {
        kind: 'Active',
        phase: {
          kind: 'Blocked',
          reason: 'HarnessCompatibilityFailure',
          checkpointSaid: 'checkpoint-6',
        },
      },
      submissionVerification: { kind: 'Rejected' },
    },
  };
}

function input() {
  return {
    task: {
      taskId: category.taskId,
      ownerAid: 'user',
      harnessLineageId: 'lineage',
      revision: { said: category.taskRevisionSaid },
      lifecycle: { kind: 'Open' as const },
    },
    calibrations: [1, 2, 3, 4, 5].map((ordinal) => observation(ordinal, ordinal === 5)),
    retained: retained(),
    retainedFailure: { runId: 'run-6', eventSaid: 'failure-event-6', category },
  };
}

function calibration(record: ReturnType<typeof input>, index: number): SealedRunObservation {
  const value = record.calibrations[index];
  if (value === undefined) throw new Error('Missing fixture calibration');
  return value;
}

describe('qualified failure admission', () => {
  it('accepts exactly four identical confirmed clean failures, one sealed exclusion, and a new sealed retained failure', () => {
    expect(assessFailureQualification(input())).toEqual({
      kind: 'Qualified',
      campaignId: 'campaign',
      retainedRunId: 'run-6',
      failure: category,
    });
  });

  it('rejects a passed or unsealed calibration before any evaluation', () => {
    const passed = input();
    passed.calibrations[1] = {
      ...calibration(passed, 1),
      run: {
        ...calibration(passed, 1).run,
        lifecycle: {
          kind: 'Ended',
          outcome: {
            kind: 'CalibrationRejected',
            checkpointSaid: 'checkpoint-2',
            reason: 'H1Passed',
          },
        },
        submissionVerification: { kind: 'Accepted' },
      },
    };
    expect(assessFailureQualification(passed)).toEqual({
      kind: 'Rejected',
      reason: 'CalibrationRejected',
    });
    const unsealed = input();
    unsealed.calibrations[0] = {
      ...calibration(unsealed, 0),
      seal: { ...calibration(unsealed, 0).seal, sealSaid: '' },
    };
    expect(assessFailureQualification(unsealed)).toEqual({
      kind: 'Rejected',
      reason: 'SealUnavailable',
    });
  });

  it('rejects substituted profile, identity, category, ordinal, or retained status', () => {
    const profile = input();
    profile.retained = { ...profile.retained, executionProfileSaid: 'other-profile' };
    expect(assessFailureQualification(profile)).toEqual({
      kind: 'Rejected',
      reason: 'ExecutionBindingMismatch',
    });
    const duplicate = input();
    duplicate.retained = {
      ...duplicate.retained,
      worktreeId: calibration(duplicate, 0).worktreeId,
    };
    expect(assessFailureQualification(duplicate)).toEqual({
      kind: 'Rejected',
      reason: 'IdentityReused',
    });
    const changed = input();
    changed.calibrations[2] = {
      ...calibration(changed, 2),
      run: {
        ...calibration(changed, 2).run,
        lifecycle: {
          kind: 'Ended',
          outcome: {
            kind: 'CalibrationConfirmed',
            checkpointSaid: 'checkpoint-3',
            category: { ...category, legacyCommandSaid: 'changed' },
          },
        },
      },
    };
    expect(assessFailureQualification(changed)).toEqual({
      kind: 'Rejected',
      reason: 'FailureCategoryMismatch',
    });
    const ordinal = input();
    ordinal.calibrations[1] = {
      ...calibration(ordinal, 1),
      run: {
        ...calibration(ordinal, 1).run,
        binding: {
          ...calibration(ordinal, 1).run.binding,
          purpose: { kind: 'PreparedCompatibilityCalibration', campaignId: 'campaign', ordinal: 1 },
        },
      },
    };
    expect(assessFailureQualification(ordinal)).toEqual({
      kind: 'Rejected',
      reason: 'CampaignMismatch',
    });
    const submitted = input();
    submitted.retained = {
      ...submitted.retained,
      run: {
        ...submitted.retained.run,
        lifecycle: {
          kind: 'Ended',
          outcome: { kind: 'Submitted', checkpointSaid: 'checkpoint-6' },
        },
        submissionVerification: { kind: 'Accepted' },
      },
    };
    expect(assessFailureQualification(submitted)).toEqual({
      kind: 'Rejected',
      reason: 'RetainedRunUnavailable',
    });
  });

  it('rejects a retained Run whose verified raw failure differs from the calibration category', () => {
    const wrongRun = input();
    wrongRun.retainedFailure = { ...wrongRun.retainedFailure, runId: 'run-5' };
    expect(assessFailureQualification(wrongRun)).toEqual({
      kind: 'Rejected',
      reason: 'RetainedFailureMismatch',
    });
    const wrongCategory = input();
    wrongCategory.retainedFailure = {
      ...wrongCategory.retainedFailure,
      category: { ...category, legacyCommandSaid: 'different-legacy-check' },
    };
    expect(assessFailureQualification(wrongCategory)).toEqual({
      kind: 'Rejected',
      reason: 'RetainedFailureMismatch',
    });
    const missingEvent = input();
    missingEvent.retainedFailure = { ...missingEvent.retainedFailure, eventSaid: '' };
    expect(assessFailureQualification(missingEvent)).toEqual({
      kind: 'Rejected',
      reason: 'RetainedFailureMismatch',
    });
  });
});
