import { describe, expect, it } from 'vitest';

import { taskBudgetCeilings } from '../task/authority.js';
import { acquireFirstRunLease } from './lease.js';
import { startRunExecution } from './execution.js';
import { createRun, type Run } from './run.js';

const repository = { objectFormat: 'sha1' as const, commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
const incarnationId = 'ee87e11d-fb5f-46b4-841f-8a7a5faad97c';

function leasedRun(): Run {
  const runId = '1cc482f1-98e9-4454-8e4c-5566cb47ce3d';
  const created = createRun({
    runId,
    ownerAid: 'EUser',
    taskId: '0d6971c5-2a18-4983-8973-f6fe818479dd',
    taskRevisionSaid: 'ETask',
    harnessLineageId: '6a63c120-0927-450f-978f-cee50cc136fe',
    personalAgentAid: 'EAgent',
    taskMandateSaid: 'ETaskMandate',
    governorAid: 'EGovernor',
    promotionMandateSaid: 'EPromotionMandate',
    initialHarnessRevisionSaid: 'EHarness',
    purpose: { kind: 'Retained' },
    initialSpecialization: {
      kind: 'InitialSpecializationAccepted',
      harnessLineageId: '6a63c120-0927-450f-978f-cee50cc136fe',
      harnessRevisionSaid: 'EHarness',
      runId: '3c8f373a-a3e5-4d4b-bffc-a355995ab1c8',
      acceptedAt: '2026-09-24T19:00:00.000Z',
    },
    repository,
    commandId: 'd2c9160a-58f8-4d43-ae67-22124c6e9112',
    admissionExchangeSaid: 'EAdmission',
    evidenceStreamId: 'a1975db1-6130-41c2-b9dd-c8ec8bc12c94',
    budget: taskBudgetCeilings,
    acceptedAt: '2026-09-24T20:00:00.000Z',
  });
  if (created.kind !== 'Created') {
    throw new Error('fixture Run must be created');
  }
  const acquired = acquireFirstRunLease(created.run, {
    incarnationId,
    expectedRunVersion: 0,
    serverTime: '2026-09-24T20:00:01.000Z',
  });
  if (acquired.kind !== 'Acquired') {
    throw new Error('fixture lease must be acquired');
  }
  return acquired.run;
}

function readiness() {
  return {
    incarnationId,
    leaseObservedAt: '2026-09-24T20:00:02.000Z',
    worktree: { repository },
    evidence: {
      kind: 'Genesis' as const,
      streamId: 'a1975db1-6130-41c2-b9dd-c8ec8bc12c94',
    },
  };
}

describe('Run execution start', () => {
  it('enters Active.Running only with the exact worktree, genesis outbox, and held incarnation', () => {
    const current = leasedRun();

    expect(startRunExecution(current, readiness())).toEqual({
      kind: 'Started',
      run: {
        ...current,
        version: 2,
        lifecycle: { kind: 'Active', phase: { kind: 'Running' } },
      },
    });
  });

  it('rejects each mismatched resource without changing the Run', () => {
    const current = leasedRun();

    expect(
      startRunExecution(current, { ...readiness(), incarnationId: crypto.randomUUID() }),
    ).toEqual({ kind: 'LeaseBindingConflict' });
    expect(
      startRunExecution(current, {
        ...readiness(),
        worktree: { repository: { ...repository, commit: 'c'.repeat(40) } },
      }),
    ).toEqual({ kind: 'WorktreeBindingConflict' });
    expect(
      startRunExecution(current, {
        ...readiness(),
        evidence: { kind: 'Genesis', streamId: crypto.randomUUID() },
      }),
    ).toEqual({ kind: 'EvidenceStreamConflict' });
    expect(current.lifecycle).toEqual({ kind: 'Active', phase: { kind: 'Preparing' } });
  });

  it('rejects an expired lease and a non-genesis outbox', () => {
    const current = leasedRun();

    expect(
      startRunExecution(current, {
        ...readiness(),
        leaseObservedAt: current.lease.kind === 'Held' ? current.lease.expiresAt : '',
      }),
    ).toEqual({ kind: 'LeaseExpired', expiredAt: '2026-09-24T20:00:46.000Z' });
    expect(
      startRunExecution(current, {
        ...readiness(),
        evidence: {
          kind: 'Continued',
          streamId: current.binding.evidenceStreamId,
          nextSequence: 1,
          previousEventSaid: 'EPrevious',
        },
      }),
    ).toEqual({ kind: 'EvidenceNotGenesis' });
  });
});
