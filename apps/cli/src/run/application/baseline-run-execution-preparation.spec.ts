import { acquireFirstRunLease, createRun, taskBudgetCeilings, type Run } from '@devrandom/domain';
import { prepareEvidenceEvent } from '@devrandom/protocol';
import { RunResourceBudget } from '@devrandom/runtime';
import type {
  EvidenceObservation,
  EvidenceRecording,
  PiExecution,
  RunSupervisionSettlement,
  RunWallClock,
} from '@devrandom/runtime';
import { describe, expect, it, vi } from 'vitest';

import {
  BaselineRunExecutionPreparation,
  type BaselineRunExecutionProvision,
} from './baseline-run-execution-preparation.js';
import type { PreparedCompatibilityEvidence } from './prepared-compatibility-calibration-settlement.js';

const said = (character: string): string => `E${character.repeat(43)}`;

function leasedRun(): Run {
  const created = createRun({
    runId: '1cc482f1-98e9-4454-8e4c-5566cb47ce3d',
    ownerAid: said('a'),
    taskId: '4df838a8-5109-49fd-bdad-805880a3ecee',
    taskRevisionSaid: said('b'),
    harnessLineageId: 'd9cb18e4-f4f8-4378-a852-353eef083d91',
    personalAgentAid: said('c'),
    taskMandateSaid: said('d'),
    governorAid: said('e'),
    promotionMandateSaid: said('f'),
    initialHarnessRevisionSaid: said('g'),
    purpose: { kind: 'Retained' },
    initialSpecialization: {
      kind: 'InitialSpecializationAccepted',
      harnessLineageId: 'd9cb18e4-f4f8-4378-a852-353eef083d91',
      harnessRevisionSaid: said('g'),
      runId: '3cc482f1-98e9-4454-8e4c-5566cb47ce3d',
      acceptedAt: '2026-09-24T19:59:00.000Z',
    },
    repository: { objectFormat: 'sha1', commit: '1'.repeat(40), tree: '2'.repeat(40) },
    commandId: 'd2c9160a-58f8-4d43-ae67-22124c6e9112',
    admissionExchangeSaid: said('h'),
    evidenceStreamId: 'a1975db1-6130-41c2-b9dd-c8ec8bc12c94',
    budget: taskBudgetCeilings,
    acceptedAt: '2026-09-24T20:00:00.000Z',
  });
  if (created.kind !== 'Created') {
    throw new Error('fixture Run must create');
  }
  const leased = acquireFirstRunLease(created.run, {
    incarnationId: 'ee87e11d-fb5f-46b4-841f-8a7a5faad97c',
    expectedRunVersion: 0,
    serverTime: '2026-09-24T20:00:01.000Z',
  });
  if (leased.kind !== 'Acquired') {
    throw new Error('fixture Run lease must acquire');
  }
  return leased.run;
}

function recorder(run: Run, timeline: string[]): PreparedCompatibilityEvidence {
  let sequence = 0;
  let predecessor: string | undefined;
  return {
    run,
    readiness: () => ({
      kind: 'Ready',
      readiness: { kind: 'Genesis', streamId: run.binding.evidenceStreamId },
    }),
    recordBudgetDebit(input): EvidenceRecording {
      let recorded: EvidenceRecording = { kind: 'ObservationRejected' };
      for (const event of input.debits) {
        recorded = this.record({ occurredAt: input.occurredAt, producer: input.producer, event });
        if (recorded.kind !== 'Recorded') return recorded;
      }
      return recorded;
    },
    withhold: () => ({ kind: 'Unavailable' }),
    record(observation: EvidenceObservation): EvidenceRecording {
      timeline.push(observation.event.kind);
      if (run.lease.kind !== 'Held') {
        return { kind: 'ObservationRejected' };
      }
      const prepared = prepareEvidenceEvent({
        version: 1,
        sequence,
        predecessor:
          predecessor === undefined
            ? { kind: 'Genesis' }
            : { kind: 'Previous', eventSaid: predecessor },
        taskId: run.binding.taskId,
        taskRevisionSaid: run.binding.taskRevisionSaid,
        runId: run.binding.runId,
        incarnationId: run.lease.incarnationId,
        harnessRevisionSaid: run.binding.initialHarnessRevisionSaid,
        personalAgentAid: run.binding.personalAgentAid,
        taskMandateSaid: run.binding.taskMandateSaid,
        occurredAt: observation.occurredAt,
        recordedAt: observation.occurredAt,
        producer: observation.producer,
        event: observation.event,
      });
      if (prepared.kind !== 'Prepared') {
        return { kind: 'ObservationRejected' };
      }
      sequence += 1;
      predecessor = prepared.event.d;
      return { kind: 'Recorded', event: prepared.event };
    },
    page: () => ({ kind: 'Empty' }),
    acknowledge: () => ({ kind: 'AcknowledgementRejected' }),
    storeArtifact: () => ({ kind: 'ArtifactRejected' }),
    artifact: () => ({ kind: 'ArtifactNotFound' }),
    storeCheckpoint: () => ({ kind: 'CheckpointRejected' }),
    checkpoint: () => ({ kind: 'CheckpointNotFound' }),
    recordCheckpointAcceptance: () => ({ kind: 'Unavailable' }),
    recordSealAcknowledgement: () => ({ kind: 'AcknowledgementRejected' }),
    sealAcknowledgement: () => ({ kind: 'NotFound' }),
    read: () => ({ kind: 'NotFound' }),
    close: vi.fn(),
  };
}

describe('baseline Run execution preparation', () => {
  it.each(['BeforePreparation', 'Worktree', 'Provisioning'] as const)(
    'stops preparation at the cancelled %s boundary',
    async (phase) => {
      const run = leasedRun();
      const cancellation = new AbortController();
      if (phase === 'BeforePreparation') cancellation.abort();
      const timeline: string[] = [];
      const close = vi.fn();
      const worktree = vi.fn(() => {
        if (phase === 'Worktree') cancellation.abort();
        return Promise.resolve({
          kind: 'Prepared' as const,
          worktree: {
            directory: '/state/runs/run/worktree',
            branch: `devrandom/run/${run.binding.runId}`,
            repository: run.binding.repository,
          },
        });
      });
      const open = vi.fn((input: { readonly run: Run }) => ({
        kind: 'Opened' as const,
        recorder: { ...recorder(input.run, timeline), close },
      }));
      const provision = vi.fn<BaselineRunExecutionProvision['provision']>(() => {
        cancellation.abort();
        return Promise.resolve({ kind: 'DependencyUnavailable' });
      });
      const preparation = new BaselineRunExecutionPreparation({
        stateRoot: '/state',
        repositoryDirectory: '/repository',
        worktrees: { prepare: worktree },
        recorders: { open },
        provision: { provision },
        now: () => '2026-09-24T20:00:02.000Z',
      });
      await expect(preparation.prepare(run, cancellation.signal)).resolves.toEqual({
        kind: 'Interrupted',
      });
      expect(worktree).toHaveBeenCalledTimes(phase === 'BeforePreparation' ? 0 : 1);
      expect(open).toHaveBeenCalledTimes(phase === 'Provisioning' ? 1 : 0);
      expect(provision).toHaveBeenCalledTimes(phase === 'Provisioning' ? 1 : 0);
      expect(close).toHaveBeenCalledTimes(phase === 'Provisioning' ? 1 : 0);
      expect(timeline).toEqual([]);
    },
  );
  it.each(['Throws', 'Unavailable', 'SecretDetected', 'ModelCredentialUnavailable'] as const)(
    'closes the opened recorder when provisioning is %s',
    async (failure) => {
      const run = leasedRun();
      const timeline: string[] = [];
      const close = vi.fn();
      const preparation = new BaselineRunExecutionPreparation({
        stateRoot: '/state',
        repositoryDirectory: '/repository',
        worktrees: {
          prepare: () =>
            Promise.resolve({
              kind: 'Prepared',
              worktree: {
                directory: '/state/runs/run/worktree',
                branch: `devrandom/run/${run.binding.runId}`,
                repository: run.binding.repository,
              },
            }),
        },
        recorders: {
          open: (input) => ({
            kind: 'Opened',
            recorder: { ...recorder(input.run, timeline), close },
          }),
        },
        provision: {
          provision: () =>
            failure === 'Throws'
              ? Promise.reject(new Error('provisioning unavailable'))
              : Promise.resolve({
                  kind: failure === 'Unavailable' ? 'DependencyUnavailable' : failure,
                }),
        },
        now: () => '2026-09-24T20:00:02.000Z',
      });
      await expect(preparation.prepare(run, new AbortController().signal)).resolves.toEqual({
        kind: 'Rejected',
        failure: {
          kind:
            failure === 'Throws' || failure === 'Unavailable' ? 'DependencyUnavailable' : failure,
        },
      });
      expect(close).toHaveBeenCalledOnce();
      expect(timeline).toEqual([]);
      expect(run.lifecycle).toEqual({ kind: 'Active', phase: { kind: 'Preparing' } });
    },
  );
  it.each(['Execute', 'Release'] as const)(
    'prepares exact resources for %s without recording Run start early',
    async (disposition) => {
      const run = leasedRun();
      const timeline: string[] = [];
      let openedRun: Run | undefined;
      const close = vi.fn();
      const invoke = vi.fn<PiExecution['invoke']>(() => {
        timeline.push('PiInvoked');
        return Promise.resolve({ kind: 'Completed', sessionId: crypto.randomUUID() });
      });
      const pi: PiExecution = { invoke };
      const settlement: RunSupervisionSettlement = {
        settle: ({ run: current }) => Promise.resolve({ kind: 'Settled', run: current }),
      };
      const wallClock: RunWallClock = {
        monotonicNow: () => 0,
        waitUntil: () => Promise.resolve({ kind: 'Aborted' }),
      };
      const provision = vi.fn<BaselineRunExecutionProvision['provision']>((input) =>
        Promise.resolve({
          kind: 'Provisioned',
          evidenceDelivery: { deliver: () => Promise.resolve({ kind: 'Aborted' }) },
          pi,
          settlement,
          budget: new RunResourceBudget({
            run: input.run,
            evidence: input.evidence,
            now: () => '2026-09-24T20:00:02.000Z',
          }),
          wallClock,
        }),
      );
      const preparation = new BaselineRunExecutionPreparation({
        stateRoot: '/state',
        repositoryDirectory: '/repository',
        worktrees: {
          prepare: () =>
            Promise.resolve({
              kind: 'Prepared',
              worktree: {
                directory: '/state/runs/run/worktree',
                branch: `devrandom/run/${run.binding.runId}`,
                repository: run.binding.repository,
              },
            }),
        },
        recorders: {
          open: (input) => {
            openedRun = input.run;
            return { kind: 'Opened', recorder: { ...recorder(input.run, timeline), close } };
          },
        },
        provision: { provision },
        now: () => '2026-09-24T20:00:02.000Z',
      });

      const outcome = await preparation.prepare(run, new AbortController().signal);
      expect(outcome).toMatchObject({
        kind: 'Ready',
        execution: {
          run: { version: 2, lifecycle: { kind: 'Active', phase: { kind: 'Running' } } },
        },
      });
      if (outcome.kind !== 'Ready') {
        throw new Error('fixture preparation must be ready');
      }
      expect(openedRun).toEqual(outcome.execution.run);
      expect(provision).toHaveBeenCalledOnce();
      const provisioned = provision.mock.calls[0]?.[0];
      expect(provisioned).toMatchObject({
        run: outcome.execution.run,
        worktree: {
          directory: '/state/runs/run/worktree',
          branch: `devrandom/run/${run.binding.runId}`,
          repository: run.binding.repository,
        },
      });
      expect(provisioned?.evidence.run).toEqual(outcome.execution.run);
      expect(timeline).toEqual([]);
      if (disposition === 'Release') {
        outcome.execution.releasePreparation();
        expect(close).toHaveBeenCalledOnce();
        expect(invoke).not.toHaveBeenCalled();
        expect(timeline).toEqual([]);
        return;
      }

      await expect(
        outcome.execution.pi.invoke(outcome.execution.run, new AbortController().signal),
      ).resolves.toMatchObject({ kind: 'Completed' });
      expect(timeline).toEqual(['RunStarted', 'IncarnationStarted', 'PiInvoked']);
    },
  );

  it('refuses runtime restoration when the durable outbox belongs to a prior process', async () => {
    const run = leasedRun();
    const provision = vi.fn<BaselineRunExecutionProvision['provision']>();
    const preparation = new BaselineRunExecutionPreparation({
      stateRoot: '/state',
      repositoryDirectory: '/repository',
      worktrees: {
        prepare: () =>
          Promise.resolve({
            kind: 'Prepared',
            worktree: {
              directory: '/state/runs/run/worktree',
              branch: `devrandom/run/${run.binding.runId}`,
              repository: run.binding.repository,
            },
          }),
      },
      recorders: { open: () => ({ kind: 'ExistingOutboxRequiresLaterResume' }) },
      provision: { provision },
      now: () => '2026-09-24T20:00:02.000Z',
    });

    await expect(preparation.prepare(run, new AbortController().signal)).resolves.toEqual({
      kind: 'Rejected',
      failure: { kind: 'LaterRuntimeRecoveryRequired' },
    });
    expect(provision).not.toHaveBeenCalled();
  });
});
