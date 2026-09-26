import { describe, expect, it } from 'vitest';

import { taskBudgetCeilings } from '../task/authority.js';
import { continueRun, type RunContinuationInput } from './continuation.js';
import { acquireFirstRunLease } from './lease.js';
import { createRun } from './run.js';

function pausedRun() {
  const created = createRun({
    runId: 'run-1',
    ownerAid: 'EUser',
    taskId: 'task-1',
    taskRevisionSaid: 'ETask',
    harnessLineageId: 'lineage-1',
    personalAgentAid: 'EAgent',
    taskMandateSaid: 'ETaskMandate',
    governorAid: 'EGovernor',
    promotionMandateSaid: 'EPromotionMandate',
    initialHarnessRevisionSaid: 'EH1',
    purpose: { kind: 'Retained' as const },
    initialSpecialization: {
      kind: 'InitialSpecializationAccepted' as const,
      harnessLineageId: 'lineage-1',
      harnessRevisionSaid: 'EH1',
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
  if (created.kind !== 'Created') throw new Error('run fixture');
  const acquired = acquireFirstRunLease(created.run, {
    incarnationId: 'incarnation-1',
    expectedRunVersion: 0,
    serverTime: '2026-09-24T20:00:00.000Z',
  });
  if (acquired.kind !== 'Acquired') throw new Error('lease fixture');
  return {
    ...acquired.run,
    version: 3,
    lifecycle: {
      kind: 'Active' as const,
      phase: {
        kind: 'Blocked' as const,
        reason: 'CheckpointPause' as const,
        checkpointSaid: 'ECheckpoint',
      },
    },
    consumedBudget: { ...acquired.run.consumedBudget, providerRequests: 1 },
  };
}

function input(): RunContinuationInput {
  return {
    expectedRunVersion: 3,
    serverTime: '2026-09-24T20:00:46.000Z',
    predecessor: {
      incarnationId: 'incarnation-1',
      evidenceStreamId: 'stream-1',
      checkpointSaid: 'ECheckpoint',
    },
    successor: {
      segmentSaid: 'ESegment',
      incarnationId: 'incarnation-2',
      evidenceStreamId: 'stream-2',
      harnessRevisionSaid: 'EH2',
    },
    activation: {
      pointerVersion: 2,
      activeRevisionSaid: 'EH2',
      decisionReceiptSaid: 'EActivation',
    },
    effects: 'Settled',
  };
}

describe('same-Run replacement incarnation', () => {
  it('admits committed H2 from the original sealed compatibility failure without replacing Run identity or budget', () => {
    const paused = pausedRun();
    const blocked = {
      ...paused,
      lifecycle: {
        kind: 'Active' as const,
        phase: {
          kind: 'Blocked' as const,
          reason: 'HarnessCompatibilityFailure' as const,
          checkpointSaid: 'ECheckpoint',
        },
      },
    };
    expect(continueRun(blocked, input())).toMatchObject({
      kind: 'Admitted',
      run: {
        binding: blocked.binding,
        consumedBudget: blocked.consumedBudget,
        currentExecution: { harnessRevisionSaid: 'EH2' },
      },
    });
    expect(
      continueRun(blocked, {
        ...input(),
        activation: { ...input().activation, activeRevisionSaid: 'EH1' },
      }),
    ).toEqual({ kind: 'ActivationConflict' });
  });

  it('preserves Task/Run/agent and consumed budget while binding H2 to a new stream', () => {
    const original = pausedRun();
    const admitted = continueRun(original, input());
    expect(admitted).toMatchObject({
      kind: 'Admitted',
      run: {
        version: 4,
        binding: original.binding,
        consumedBudget: original.consumedBudget,
        lifecycle: { kind: 'Active', phase: { kind: 'Preparing' } },
        lease: {
          incarnationId: 'incarnation-2',
          expiresAt: '2026-09-24T20:01:31.000Z',
          lastChange: { kind: 'Replaced', fromRunVersion: 3, segmentSaid: 'ESegment' },
        },
        currentExecution: {
          segmentSaid: 'ESegment',
          evidenceStreamId: 'stream-2',
          harnessRevisionSaid: 'EH2',
        },
      },
    });
    if (admitted.kind !== 'Admitted') throw new Error('continuation fixture');
    expect(continueRun(admitted.run, input())).toEqual({ kind: 'Equivalent', run: admitted.run });
  });

  it('rejects a live predecessor, unpaused or terminal Run, stale checkpoint and unresolved effects', () => {
    const run = pausedRun();
    expect(continueRun(run, { ...input(), serverTime: '2026-09-24T20:00:44.000Z' })).toEqual({
      kind: 'LeaseStillHeld',
    });
    expect(
      continueRun(run, {
        ...input(),
        predecessor: { ...input().predecessor, checkpointSaid: 'EWrong' },
      }),
    ).toEqual({ kind: 'CheckpointConflict' });
    expect(continueRun(run, { ...input(), effects: 'Unresolved' })).toEqual({
      kind: 'UnresolvedEffects',
    });
    expect(
      continueRun({ ...run, lifecycle: { kind: 'Active', phase: { kind: 'Running' } } }, input()),
    ).toEqual({ kind: 'RunNotPaused' });
    expect(
      continueRun(
        {
          ...run,
          lifecycle: {
            kind: 'Ended',
            outcome: { kind: 'Cancelled', checkpointSaid: 'ECheckpoint' },
          },
        },
        input(),
      ),
    ).toEqual({ kind: 'RunNotPaused' });
  });

  it('admits a second H2 incarnation only from its own later sealed pause', () => {
    const first = continueRun(pausedRun(), input());
    if (first.kind !== 'Admitted') throw new Error('first continuation fixture');
    const pausedSuccessor = {
      ...first.run,
      version: 6,
      lifecycle: {
        kind: 'Active' as const,
        phase: {
          kind: 'Blocked' as const,
          reason: 'CheckpointPause' as const,
          checkpointSaid: 'ECheckpoint2',
        },
      },
    };
    const next = {
      ...input(),
      expectedRunVersion: 6,
      serverTime: '2026-09-24T20:01:32.000Z',
      predecessor: {
        incarnationId: 'incarnation-2',
        evidenceStreamId: 'stream-2',
        checkpointSaid: 'ECheckpoint2',
      },
      successor: {
        segmentSaid: 'ESegment2',
        incarnationId: 'incarnation-3',
        evidenceStreamId: 'stream-3',
        harnessRevisionSaid: 'EH2',
      },
    };
    expect(continueRun(pausedSuccessor, next)).toMatchObject({
      kind: 'Admitted',
      run: {
        binding: first.run.binding,
        currentExecution: { evidenceStreamId: 'stream-3', harnessRevisionSaid: 'EH2' },
      },
    });
    expect(
      continueRun(pausedSuccessor, {
        ...next,
        predecessor: { ...next.predecessor, evidenceStreamId: 'stream-1' },
      }),
    ).toEqual({ kind: 'LeaseConflict' });
  });
});
