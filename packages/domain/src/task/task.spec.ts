import { describe, expect, it } from 'vitest';

import { openTask, settleTaskFromSealedRun, type Task, type TaskLifecycle } from './task.js';

function withLifecycle(task: Task, lifecycle: TaskLifecycle, expectedVersion: number): Task {
  return { ...task, lifecycle, expectedVersion };
}

describe('Task aggregate creation', () => {
  it('opens version zero with one immutable revision reference', () => {
    const task = openTask({
      taskId: '4df838a8-5109-49fd-bdad-805880a3ecee',
      ownerAid: 'EMstL6Th90iB6MpQkPjKN2ii7a5XcvA_PCHWHrAAD-l4',
      label: 'repair-parser',
      harnessLineageId: 'd9cb18e4-f4f8-4378-a852-353eef083d91',
      revisionSaid: 'EBfdvKtgC60KC1LAH66yo7DXCz41YVx8N6RDwUpnwz8I',
      commandId: '97e16745-4b76-4de3-9ae5-a183496e73e8',
      createdAt: '2026-09-24T14:15:16.123Z',
    });

    expect(task).toEqual({
      taskId: '4df838a8-5109-49fd-bdad-805880a3ecee',
      ownerAid: 'EMstL6Th90iB6MpQkPjKN2ii7a5XcvA_PCHWHrAAD-l4',
      label: 'repair-parser',
      harnessLineageId: 'd9cb18e4-f4f8-4378-a852-353eef083d91',
      revision: { said: 'EBfdvKtgC60KC1LAH66yo7DXCz41YVx8N6RDwUpnwz8I' },
      lifecycle: { kind: 'Open' },
      commandId: '97e16745-4b76-4de3-9ae5-a183496e73e8',
      createdAt: '2026-09-24T14:15:16.123Z',
      expectedVersion: 0,
    });
    expect(Object.isFrozen(task)).toBe(true);
    expect(Object.isFrozen(task.revision)).toBe(true);
    expect(Object.isFrozen(task.lifecycle)).toBe(true);
  });
});

describe('Task settlement from an agent-sealed Run', () => {
  const revisionSaid = 'EBfdvKtgC60KC1LAH66yo7DXCz41YVx8N6RDwUpnwz8I';

  function task(): Task {
    return openTask({
      taskId: '4df838a8-5109-49fd-bdad-805880a3ecee',
      ownerAid: 'EMstL6Th90iB6MpQkPjKN2ii7a5XcvA_PCHWHrAAD-l4',
      label: 'repair-parser',
      harnessLineageId: 'd9cb18e4-f4f8-4378-a852-353eef083d91',
      revisionSaid,
      commandId: '97e16745-4b76-4de3-9ae5-a183496e73e8',
      createdAt: '2026-09-24T14:15:16.123Z',
    });
  }

  it('completes an open exact revision only for a sealed accepted submission', () => {
    const current = task();
    const outcome = settleTaskFromSealedRun(current, {
      taskRevisionSaid: revisionSaid,
      expectedTaskVersion: 0,
      lifecycle: {
        kind: 'Ended',
        outcome: { kind: 'Submitted', checkpointSaid: `E${'c'.repeat(43)}` },
      },
      submissionVerification: { kind: 'Accepted' },
    });

    expect(outcome).toEqual({
      kind: 'Settled',
      task: {
        ...current,
        lifecycle: { kind: 'Completed' },
        expectedVersion: 1,
      },
    });
  });

  it.each([
    {
      name: 'blocked',
      lifecycle: {
        kind: 'Active' as const,
        phase: {
          kind: 'Blocked' as const,
          reason: 'HarnessCompatibilityFailure' as const,
          checkpointSaid: `E${'c'.repeat(43)}`,
        },
      },
      submissionVerification: { kind: 'NotSubmitted' as const },
    },
    {
      name: 'rejected submission',
      lifecycle: {
        kind: 'Active' as const,
        phase: {
          kind: 'Blocked' as const,
          reason: 'DependencyUnavailable' as const,
          checkpointSaid: `E${'c'.repeat(43)}`,
        },
      },
      submissionVerification: { kind: 'Rejected' as const },
    },
    {
      name: 'non-submitted ending',
      lifecycle: {
        kind: 'Ended' as const,
        outcome: {
          kind: 'Failed' as const,
          failure: 'ProviderUnrecoverableFailure' as const,
          checkpointSaid: `E${'c'.repeat(43)}`,
        },
      },
      submissionVerification: { kind: 'NotSubmitted' as const },
    },
    {
      name: 'confirmed calibration',
      lifecycle: {
        kind: 'Ended' as const,
        outcome: {
          kind: 'CalibrationConfirmed' as const,
          checkpointSaid: `E${'c'.repeat(43)}`,
          category: {
            version: 1 as const,
            taskId: '4df838a8-5109-49fd-bdad-805880a3ecee',
            taskRevisionSaid: revisionSaid,
            harnessRevisionSaid: `E${'h'.repeat(43)}`,
            currentCommandSaid: `E${'i'.repeat(43)}`,
            tamperCommandSaid: `E${'j'.repeat(43)}`,
            legacyCommandSaid: `E${'k'.repeat(43)}`,
            legacyObservedExitCode: 101 as const,
          },
        },
      },
      submissionVerification: { kind: 'Rejected' as const },
    },
    {
      name: 'excluded calibration',
      lifecycle: {
        kind: 'Ended' as const,
        outcome: {
          kind: 'CalibrationExcluded' as const,
          checkpointSaid: `E${'c'.repeat(43)}`,
          reason: 'ProviderUnavailable' as const,
        },
      },
      submissionVerification: { kind: 'NotSubmitted' as const },
    },
    {
      name: 'rejected passing calibration',
      lifecycle: {
        kind: 'Ended' as const,
        outcome: {
          kind: 'CalibrationRejected' as const,
          checkpointSaid: `E${'c'.repeat(43)}`,
          reason: 'H1Passed' as const,
        },
      },
      submissionVerification: { kind: 'Accepted' as const },
    },
  ])(
    'leaves an open Task unchanged for a sealed $name Run',
    ({ lifecycle, submissionVerification }) => {
      const current = task();

      expect(
        settleTaskFromSealedRun(current, {
          taskRevisionSaid: revisionSaid,
          expectedTaskVersion: 0,
          lifecycle,
          submissionVerification,
        }),
      ).toEqual({ kind: 'Settled', task: current });
    },
  );

  it('reconciles an exact completion retry and rejects conflicting lifecycle, revision, or version', () => {
    const current = task();
    const completed = withLifecycle(current, { kind: 'Completed' }, 1);
    const accepted = {
      taskRevisionSaid: revisionSaid,
      expectedTaskVersion: 0,
      lifecycle: {
        kind: 'Ended' as const,
        outcome: { kind: 'Submitted' as const, checkpointSaid: `E${'c'.repeat(43)}` },
      },
      submissionVerification: { kind: 'Accepted' as const },
    };

    expect(settleTaskFromSealedRun(completed, accepted)).toEqual({
      kind: 'Equivalent',
      task: completed,
    });
    expect(
      settleTaskFromSealedRun(withLifecycle(current, { kind: 'Cancelled' }, 1), {
        ...accepted,
        expectedTaskVersion: 1,
      }),
    ).toEqual({ kind: 'TaskLifecycleConflict', lifecycle: 'Cancelled' });
    expect(
      settleTaskFromSealedRun(current, {
        ...accepted,
        taskRevisionSaid: `E${'x'.repeat(43)}`,
      }),
    ).toEqual({ kind: 'TaskRevisionConflict' });
    expect(settleTaskFromSealedRun(current, { ...accepted, expectedTaskVersion: 3 })).toEqual({
      kind: 'TaskVersionConflict',
      currentVersion: 0,
    });
  });

  it('rejects an incoherent accepted verification without changing the Task', () => {
    const current = task();

    expect(
      settleTaskFromSealedRun(current, {
        taskRevisionSaid: revisionSaid,
        expectedTaskVersion: 0,
        lifecycle: {
          kind: 'Active',
          phase: {
            kind: 'Blocked',
            reason: 'HarnessCompatibilityFailure',
            checkpointSaid: `E${'c'.repeat(43)}`,
          },
        },
        submissionVerification: { kind: 'Accepted' },
      }),
    ).toEqual({ kind: 'RunDispositionInvalid' });
  });
});
