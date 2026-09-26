import { describe, expect, it } from 'vitest';

import { taskBudgetCeilings } from '../task/authority.js';
import { createRun } from './run.js';
import { acquireFirstRunLease, renewRunLease, runLeasePolicy } from './lease.js';

function unleasedRun() {
  const outcome = createRun({
    runId: 'run-1',
    ownerAid: 'EUser',
    taskId: 'task-1',
    taskRevisionSaid: 'ETask',
    harnessLineageId: 'lineage-1',
    personalAgentAid: 'EAgent',
    taskMandateSaid: 'ETaskMandate',
    governorAid: 'EGovernor',
    promotionMandateSaid: 'EPromotionMandate',
    initialHarnessRevisionSaid: 'EHarness',
    purpose: { kind: 'Retained' },
    initialSpecialization: {
      kind: 'InitialSpecializationAccepted',
      harnessLineageId: 'lineage-1',
      harnessRevisionSaid: 'EHarness',
      runId: 'calibration-run-1',
      acceptedAt: '2026-09-24T19:00:00.000Z',
    },
    repository: { objectFormat: 'sha1' as const, commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
    commandId: 'command-1',
    admissionExchangeSaid: 'EAdmission',
    evidenceStreamId: 'stream-1',
    budget: taskBudgetCeilings,
    acceptedAt: '2026-09-24T20:00:00.000Z',
  });
  if (outcome.kind !== 'Created') {
    throw new Error('expected a valid Run fixture');
  }
  return outcome.run;
}

describe('first Run incarnation lease', () => {
  it('uses server time, increments the Run version, and reconciles without extending expiry', () => {
    expect(runLeasePolicy).toEqual({
      leaseSeconds: 45,
      renewalSeconds: 15,
      clientSafetyMarginSeconds: 5,
    });
    const acquired = acquireFirstRunLease(unleasedRun(), {
      incarnationId: 'incarnation-1',
      expectedRunVersion: 0,
      serverTime: '2026-09-24T20:00:00.000Z',
    });
    expect(acquired).toMatchObject({
      kind: 'Acquired',
      run: {
        version: 1,
        lease: {
          kind: 'Held',
          incarnationId: 'incarnation-1',
          acquiredAt: '2026-09-24T20:00:00.000Z',
          expiresAt: '2026-09-24T20:00:45.000Z',
          lastChange: { kind: 'Acquired', fromRunVersion: 0 },
        },
      },
    });
    if (acquired.kind !== 'Acquired') {
      return;
    }
    expect(
      acquireFirstRunLease(acquired.run, {
        incarnationId: 'incarnation-1',
        expectedRunVersion: 0,
        serverTime: '2026-09-24T20:00:10.000Z',
      }),
    ).toEqual({ kind: 'Equivalent', run: acquired.run });
  });

  it('rejects a competing, stale, or post-expiry acquisition', () => {
    const acquired = acquireFirstRunLease(unleasedRun(), {
      incarnationId: 'incarnation-1',
      expectedRunVersion: 0,
      serverTime: '2026-09-24T20:00:00.000Z',
    });
    if (acquired.kind !== 'Acquired') {
      throw new Error('expected a first lease');
    }
    expect(
      acquireFirstRunLease(acquired.run, {
        incarnationId: 'incarnation-2',
        expectedRunVersion: 1,
        serverTime: '2026-09-24T20:00:10.000Z',
      }),
    ).toMatchObject({ kind: 'LeaseConflict', incarnationId: 'incarnation-1' });
    expect(
      acquireFirstRunLease(unleasedRun(), {
        incarnationId: 'incarnation-1',
        expectedRunVersion: 1,
        serverTime: '2026-09-24T20:00:00.000Z',
      }),
    ).toEqual({ kind: 'VersionConflict', currentVersion: 0 });
    expect(
      acquireFirstRunLease(acquired.run, {
        incarnationId: 'incarnation-1',
        expectedRunVersion: 0,
        serverTime: '2026-09-24T20:00:45.000Z',
      }),
    ).toEqual({ kind: 'LaterResumeRequired', expiredAt: '2026-09-24T20:00:45.000Z' });
  });
});

describe('held Run incarnation lease renewal', () => {
  it('extends only the exact held incarnation from the expected version and reconciles a retry', () => {
    const acquired = acquireFirstRunLease(unleasedRun(), {
      incarnationId: 'incarnation-1',
      expectedRunVersion: 0,
      serverTime: '2026-09-24T20:00:00.000Z',
    });
    if (acquired.kind !== 'Acquired') {
      throw new Error('expected a first lease');
    }

    const renewed = renewRunLease(acquired.run, {
      incarnationId: 'incarnation-1',
      expectedRunVersion: 1,
      serverTime: '2026-09-24T20:00:15.000Z',
    });

    expect(renewed).toMatchObject({
      kind: 'Renewed',
      run: {
        version: 2,
        lease: {
          kind: 'Held',
          incarnationId: 'incarnation-1',
          acquiredAt: '2026-09-24T20:00:00.000Z',
          expiresAt: '2026-09-24T20:01:00.000Z',
          lastChange: { kind: 'Renewed', fromRunVersion: 1 },
        },
      },
    });
    if (renewed.kind !== 'Renewed') {
      throw new Error('expected a renewed lease');
    }
    expect(
      renewRunLease(renewed.run, {
        incarnationId: 'incarnation-1',
        expectedRunVersion: 1,
        serverTime: '2026-09-24T20:00:20.000Z',
      }),
    ).toEqual({ kind: 'Equivalent', run: renewed.run });
  });

  it('rejects the wrong incarnation, a stale version, and renewal at expiry', () => {
    const acquired = acquireFirstRunLease(unleasedRun(), {
      incarnationId: 'incarnation-1',
      expectedRunVersion: 0,
      serverTime: '2026-09-24T20:00:00.000Z',
    });
    if (acquired.kind !== 'Acquired') {
      throw new Error('expected a first lease');
    }

    expect(
      renewRunLease(acquired.run, {
        incarnationId: 'incarnation-2',
        expectedRunVersion: 1,
        serverTime: '2026-09-24T20:00:15.000Z',
      }),
    ).toMatchObject({ kind: 'LeaseConflict', incarnationId: 'incarnation-1' });
    expect(
      renewRunLease(acquired.run, {
        incarnationId: 'incarnation-1',
        expectedRunVersion: 0,
        serverTime: '2026-09-24T20:00:15.000Z',
      }),
    ).toEqual({ kind: 'VersionConflict', currentVersion: 1 });
    expect(
      renewRunLease(acquired.run, {
        incarnationId: 'incarnation-1',
        expectedRunVersion: 1,
        serverTime: '2026-09-24T20:00:45.000Z',
      }),
    ).toEqual({ kind: 'LeaseExpired', expiredAt: '2026-09-24T20:00:45.000Z' });
  });
});
