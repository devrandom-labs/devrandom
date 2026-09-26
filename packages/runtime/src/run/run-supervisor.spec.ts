import { describe, expect, it, vi } from 'vitest';

import {
  acquireFirstRunLease,
  createRun,
  startRunExecution,
  taskBudgetCeilings,
  type Run,
} from '@devrandom/domain';
import { prepareEvidenceEvent } from '@devrandom/protocol';

import type { EvidenceObservation, EvidenceRecording } from '../evidence/evidence-recorder.js';
import {
  MonotonicLeaseClock,
  type LeaseClock,
  type RunLeaseAcceptances,
  type RunLeaseAuthority,
  type RunLeaseReceipt,
} from './lease-keeper.js';
import {
  RunSupervisor,
  type PiExecution,
  type RunExecutionPreparation,
  type RunExecutionPreparationOutcome,
  type RunEvidenceDelivery,
  type RunSupervisionSettlement,
} from './run-supervisor.js';
import { RunResourceBudget } from './run-resource-budget.js';

function leasedRunFixture(): Run {
  const created = createRun({
    runId: '1cc482f1-98e9-4454-8e4c-5566cb47ce3d',
    ownerAid: `E${'u'.repeat(43)}`,
    taskId: '0d6971c5-2a18-4983-8973-f6fe818479dd',
    taskRevisionSaid: `E${'t'.repeat(43)}`,
    harnessLineageId: '6a63c120-0927-450f-978f-cee50cc136fe',
    personalAgentAid: `E${'a'.repeat(43)}`,
    taskMandateSaid: `E${'m'.repeat(43)}`,
    governorAid: `E${'g'.repeat(43)}`,
    promotionMandateSaid: `E${'p'.repeat(43)}`,
    initialHarnessRevisionSaid: `E${'h'.repeat(43)}`,
    purpose: { kind: 'Retained' },
    initialSpecialization: {
      kind: 'InitialSpecializationAccepted',
      harnessLineageId: '6a63c120-0927-450f-978f-cee50cc136fe',
      harnessRevisionSaid: `E${'h'.repeat(43)}`,
      runId: '3cc482f1-98e9-4454-8e4c-5566cb47ce3d',
      acceptedAt: '2026-09-24T19:59:00.000Z',
    },
    repository: { objectFormat: 'sha1', commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
    commandId: 'd2c9160a-58f8-4d43-ae67-22124c6e9112',
    admissionExchangeSaid: `E${'x'.repeat(43)}`,
    evidenceStreamId: 'a1975db1-6130-41c2-b9dd-c8ec8bc12c94',
    budget: taskBudgetCeilings,
    acceptedAt: '2026-09-24T20:00:00.000Z',
  });
  if (created.kind !== 'Created') {
    throw new Error('fixture Run must be created');
  }
  const leased = acquireFirstRunLease(created.run, {
    incarnationId: 'ee87e11d-fb5f-46b4-841f-8a7a5faad97c',
    expectedRunVersion: 0,
    serverTime: '2026-09-24T20:00:01.000Z',
  });
  if (leased.kind !== 'Acquired') {
    throw new Error('fixture Run lease must be acquired');
  }
  return leased.run;
}

function receipt(run: Run): RunLeaseReceipt {
  if (run.lease.kind !== 'Held') {
    throw new Error('fixture Run must hold a lease');
  }
  return {
    runId: run.binding.runId,
    incarnationId: run.lease.incarnationId,
    runVersion: run.version,
    serverTime: run.lease.acquiredAt,
    expiresAt: run.lease.expiresAt,
  };
}

function preparation(
  run: Run,
  pi: PiExecution,
  settlement: RunSupervisionSettlement,
  resourceBudget = budget(run),
  wallClock: LeaseClock = waitingClock(),
  evidenceDelivery: RunEvidenceDelivery = {
    deliver: async (signal: AbortSignal) => {
      if (!signal.aborted) await waitingClock().waitUntil(Infinity, signal);
      return { kind: 'Aborted' as const };
    },
  },
): RunExecutionPreparation {
  return {
    prepare: (): ReturnType<RunExecutionPreparation['prepare']> => {
      const started = startRunExecution(run, {
        incarnationId: run.lease.kind === 'Held' ? run.lease.incarnationId : '',
        leaseObservedAt: '2026-09-24T20:00:02.000Z',
        worktree: { repository: run.binding.repository },
        evidence: { kind: 'Genesis', streamId: run.binding.evidenceStreamId },
      });
      return Promise.resolve(
        started.kind === 'Started'
          ? {
              kind: 'Ready',
              execution: {
                run: started.run,
                releasePreparation: () => undefined,
                pi,
                settlement,
                budget: resourceBudget,
                wallClock,
                evidenceDelivery,
              },
            }
          : {
              kind: 'Rejected',
              failure: { kind: 'DomainTransitionRejected', outcome: started },
            },
      );
    },
  };
}

function waitingClock(onAbort?: () => void): LeaseClock {
  return {
    monotonicNow: () => 1_000,
    waitUntil: (_deadline, signal) =>
      new Promise((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            onAbort?.();
            resolve({ kind: 'Aborted' });
          },
          { once: true },
        );
      }),
  };
}

const ignoredLeaseAcceptances: RunLeaseAcceptances = { accept: () => undefined };

function budget(run: Run, observations: EvidenceObservation[] = []): RunResourceBudget {
  return new RunResourceBudget({
    run,
    evidence: {
      recordBudgetDebit(input): EvidenceRecording {
        const entries = input.debits.map((event) => ({
          occurredAt: input.occurredAt,
          producer: input.producer,
          event,
        }));
        observations.push(...entries);
        const observation = entries.at(-1);
        if (observation === undefined) return { kind: 'ObservationRejected' };
        const prepared = prepareEvidenceEvent({
          version: 1,
          sequence: observations.length - 1,
          predecessor:
            observations.length === 1
              ? { kind: 'Genesis' }
              : { kind: 'Previous', eventSaid: `E${'z'.repeat(43)}` },
          taskId: run.binding.taskId,
          taskRevisionSaid: run.binding.taskRevisionSaid,
          runId: run.binding.runId,
          incarnationId:
            run.lease.kind === 'Held'
              ? run.lease.incarnationId
              : 'ee87e11d-fb5f-46b4-841f-8a7a5faad97c',
          harnessRevisionSaid: run.binding.initialHarnessRevisionSaid,
          personalAgentAid: run.binding.personalAgentAid,
          taskMandateSaid: run.binding.taskMandateSaid,
          occurredAt: observation.occurredAt,
          recordedAt: observation.occurredAt,
          producer: observation.producer,
          event: observation.event,
        });
        return prepared.kind === 'Prepared'
          ? { kind: 'Recorded', event: prepared.event }
          : { kind: 'ObservationRejected' };
      },
    },
    now: () => '2026-09-24T20:00:03.000Z',
  });
}

describe('XState Run Supervisor', () => {
  it('cancels preparation at the lease deadline and joins cleanup before reporting lease loss', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const cleanup = Promise.withResolvers<RunExecutionPreparationOutcome>();
    try {
      const run = leasedRunFixture();
      const interrupted = vi.fn();
      const completed = vi.fn();
      const settle = vi.fn<RunSupervisionSettlement['settle']>();
      const renew = vi.fn<RunLeaseAuthority['renew']>();
      const supervision = new RunSupervisor({
        preparation: {
          prepare: (_run, signal) => {
            signal.addEventListener('abort', interrupted, { once: true });
            return cleanup.promise;
          },
        },
        leaseAuthority: { renew },
        leaseAcceptances: ignoredLeaseAcceptances,
        leaseClock: new MonotonicLeaseClock(),
        settlement: { settle },
      })
        .supervise(run, receipt(run), new AbortController().signal, 0)
        .then(completed);
      await vi.advanceTimersByTimeAsync(39_999);
      expect(interrupted).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(interrupted).toHaveBeenCalledTimes(1);
      expect(completed).not.toHaveBeenCalled();
      cleanup.resolve({ kind: 'Interrupted' });
      await supervision;
      expect(completed).toHaveBeenCalledExactlyOnceWith({
        kind: 'Stopped',
        run,
        cause: {
          kind: 'LeaseKeeperSettled',
          disposition: { kind: 'LeaseLost', lastAcceptedRunVersion: run.version },
        },
        latestHostedRunVersion: run.version,
      });
      expect(renew).not.toHaveBeenCalled();
      expect(settle).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      cleanup.resolve({ kind: 'Interrupted' });
      vi.useRealTimers();
    }
  });
  it.each(['Ready', 'Rejected'] as const)(
    'joins interrupted preparation and releases its unused resources: %s',
    async (kind) => {
      const run = leasedRunFixture();
      const invoke = vi.fn<PiExecution['invoke']>();
      const settle = vi.fn<RunSupervisionSettlement['settle']>();
      const releasePreparation = vi.fn();
      const result = await preparation(run, { invoke }, { settle }).prepare(
        run,
        new AbortController().signal,
      );
      if (result.kind !== 'Ready') throw new Error('fixture must prepare');
      const prepared = Promise.withResolvers<RunExecutionPreparationOutcome>();
      const entered = Promise.withResolvers<undefined>();
      const cancellation = new AbortController();
      const completed = vi.fn();
      const supervisor = new RunSupervisor({
        preparation: {
          prepare: () => {
            entered.resolve(undefined);
            return prepared.promise;
          },
        },
        leaseAuthority: { renew: vi.fn() },
        leaseAcceptances: ignoredLeaseAcceptances,
        leaseClock: waitingClock(),
        settlement: { settle },
      });
      const supervision = supervisor
        .supervise(run, receipt(run), cancellation.signal, 0)
        .then(completed);
      await entered.promise;
      cancellation.abort();
      try {
        await new Promise((resolve) => setImmediate(resolve));
        expect(completed).not.toHaveBeenCalled();
      } finally {
        prepared.resolve(
          kind === 'Ready'
            ? { ...result, execution: { ...result.execution, releasePreparation } }
            : { kind: 'Rejected', failure: { kind: 'DependencyUnavailable' } },
        );
        await supervision;
      }
      expect(completed).toHaveBeenCalledExactlyOnceWith({
        kind: 'Stopped',
        run,
        cause: { kind: 'UserInterrupted' },
        latestHostedRunVersion: run.version,
      });
      expect(releasePreparation).toHaveBeenCalledTimes(kind === 'Ready' ? 1 : 0);
      expect(invoke).not.toHaveBeenCalled();
      expect(settle).not.toHaveBeenCalled();
    },
  );
  it('does not prepare an execution whose caller already cancelled', async () => {
    const run = leasedRunFixture();
    const prepare = vi.fn<RunExecutionPreparation['prepare']>().mockResolvedValue({
      kind: 'Rejected',
      failure: { kind: 'DependencyUnavailable' },
    });
    const renew = vi.fn<RunLeaseAuthority['renew']>();
    const settle = vi.fn<RunSupervisionSettlement['settle']>();
    const supervisor = new RunSupervisor({
      preparation: { prepare },
      leaseAuthority: { renew },
      leaseAcceptances: ignoredLeaseAcceptances,
      leaseClock: waitingClock(),
      settlement: { settle },
    });
    const cancellation = new AbortController();
    cancellation.abort();
    await expect(supervisor.supervise(run, receipt(run), cancellation.signal, 0)).resolves.toEqual({
      kind: 'Stopped',
      run,
      cause: { kind: 'UserInterrupted' },
      latestHostedRunVersion: run.version,
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(renew).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });
  it.each(['BeforeSupervision', 'DuringPreparation'] as const)(
    'does not start Pi when the lease expires %s',
    async (delay) => {
      const run = leasedRunFixture();
      let now = delay === 'BeforeSupervision' ? 40_000 : 0;
      const invoke = vi.fn<PiExecution['invoke']>(() =>
        Promise.resolve({ kind: 'Completed', sessionId: 'session-1' }),
      );
      const settle = vi.fn<RunSupervisionSettlement['settle']>((input) =>
        Promise.resolve({ kind: 'Settled', run: input.run }),
      );
      const ready = preparation(run, { invoke }, { settle });
      const renew = vi.fn<RunLeaseAuthority['renew']>();
      const supervision = new RunSupervisor({
        preparation: {
          prepare: async (input) => {
            const prepared = await ready.prepare(input, new AbortController().signal);
            now = 40_000;
            return prepared;
          },
        },
        leaseAuthority: { renew },
        leaseAcceptances: ignoredLeaseAcceptances,
        leaseClock: { ...waitingClock(), monotonicNow: () => now },
        settlement: { settle },
      });
      await expect(
        supervision.supervise(run, receipt(run), new AbortController().signal, 0),
      ).resolves.toMatchObject({
        kind: 'Stopped',
        cause: {
          kind: 'LeaseKeeperSettled',
          disposition: { kind: 'LeaseLost', lastAcceptedRunVersion: run.version },
        },
      });
      expect(invoke).not.toHaveBeenCalled();
      expect(renew).not.toHaveBeenCalled();
      expect(settle).not.toHaveBeenCalled();
    },
  );

  it('aborts and joins Pi when delivery detects a corrupt stream', async () => {
    const run = leasedRunFixture();
    const timeline: string[] = [];
    const pi: PiExecution = {
      invoke: (_run, signal) =>
        new Promise((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              timeline.push('pi-stopped');
              resolve({ kind: 'Aborted' });
            },
            { once: true },
          );
        }),
    };
    const settlement: RunSupervisionSettlement = {
      settle: (input) => {
        timeline.push('settlement');
        return Promise.resolve({ kind: 'Settled', run: input.run });
      },
    };
    const supervision = new RunSupervisor({
      preparation: preparation(run, pi, settlement, budget(run), waitingClock(), {
        deliver: () => Promise.resolve({ kind: 'EvidenceIntegrityFailure' }),
      }),
      leaseAuthority: { renew: () => Promise.reject(new Error('unexpected renewal')) },
      leaseAcceptances: ignoredLeaseAcceptances,
      leaseClock: waitingClock(),
      settlement,
    }).supervise(run, receipt(run), new AbortController().signal, 0);
    await expect(supervision).resolves.toMatchObject({
      kind: 'Stopped',
      cause: { kind: 'ExecutorSettled', disposition: { kind: 'EvidenceIntegrityFailure' } },
    });
    expect(timeline).toEqual(['pi-stopped', 'settlement']);
  });

  it('delivers while Pi runs and joins delivery before settlement', async () => {
    const run = leasedRunFixture();
    const timeline: string[] = [];
    const deliveryStarted = Promise.withResolvers<undefined>();
    const deliveryReleased = Promise.withResolvers<undefined>();
    const deliveryCancelled = Promise.withResolvers<undefined>();
    const settlement: RunSupervisionSettlement = {
      settle: (input) => {
        timeline.push('settlement');
        return Promise.resolve({ kind: 'Settled', run: input.run });
      },
    };
    const pi: PiExecution = {
      invoke: async () => {
        await deliveryStarted.promise;
        timeline.push('pi-completed');
        return { kind: 'Completed', sessionId: 'session' };
      },
    };
    const supervision = new RunSupervisor({
      preparation: preparation(run, pi, settlement, budget(run), waitingClock(), {
        deliver: async (signal) => {
          timeline.push('delivery-started');
          deliveryStarted.resolve(undefined);
          await new Promise<void>((resolve) => {
            signal.addEventListener(
              'abort',
              () => {
                deliveryCancelled.resolve(undefined);
                resolve();
              },
              { once: true },
            );
          });
          await deliveryReleased.promise;
          timeline.push('delivery-joined');
          return { kind: 'Aborted' };
        },
      }),
      leaseAuthority: { renew: () => Promise.reject(new Error('unexpected renewal')) },
      leaseAcceptances: ignoredLeaseAcceptances,
      leaseClock: waitingClock(),
      settlement,
    }).supervise(run, receipt(run), new AbortController().signal, 0);
    await vi.waitFor(() => {
      expect(timeline).toContain('delivery-started');
    });
    await deliveryCancelled.promise;
    expect(timeline).toEqual(['delivery-started', 'pi-completed']);
    deliveryReleased.resolve(undefined);
    await expect(supervision).resolves.toMatchObject({ kind: 'Stopped' });
    expect(timeline).toEqual(['delivery-started', 'pi-completed', 'delivery-joined', 'settlement']);
  });

  it('starts exactly one Pi executor after preparation and cancels lease keeping before settlement', async () => {
    const run = leasedRunFixture();
    const timeline: string[] = [];
    const invoke = vi.fn<PiExecution['invoke']>(() => {
      timeline.push('pi');
      return Promise.resolve({ kind: 'Completed', sessionId: crypto.randomUUID() });
    });
    const pi: PiExecution = {
      invoke,
    };
    const leaseAuthority: RunLeaseAuthority = {
      renew: () => Promise.reject(new Error('renewal must not occur before cancellation')),
    };
    const settlement: RunSupervisionSettlement = {
      settle: vi.fn<RunSupervisionSettlement['settle']>((input) => {
        timeline.push('settlement');
        return Promise.resolve({ kind: 'Settled', run: input.run });
      }),
    };
    await expect(
      preparation(run, pi, settlement).prepare(run, new AbortController().signal),
    ).resolves.toMatchObject({
      kind: 'Ready',
    });

    const outcome = await new RunSupervisor({
      preparation: preparation(run, pi, settlement),
      leaseAuthority,
      leaseAcceptances: ignoredLeaseAcceptances,
      leaseClock: waitingClock(() => timeline.push('lease-wait-cancelled')),
      settlement: {
        settle: () => Promise.reject(new Error('prepared settlement must own the Run')),
      },
    }).supervise(run, receipt(run), new AbortController().signal, 0);

    expect(outcome).toMatchObject({
      kind: 'Stopped',
      run: { lifecycle: { kind: 'Active', phase: { kind: 'Running' } } },
      cause: {
        kind: 'ExecutorSettled',
        disposition: { kind: 'Completed' },
      },
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(timeline).toEqual(['lease-wait-cancelled', 'pi', 'lease-wait-cancelled', 'settlement']);
  });

  it('keeps typed evidence settlement failure while leaving the Run unsealed', async () => {
    const run = leasedRunFixture();
    const failure = {
      kind: 'EvidenceDeliveryRejected',
      delivery: {
        kind: 'BatchDeliveryRejected',
        failure: { kind: 'RequestRejected', code: 'EvidenceCapabilityInvalid' },
      },
    } as const;
    const settlement: RunSupervisionSettlement = {
      settle: () => Promise.resolve({ kind: 'EvidenceSealingFailed', failure }),
    };
    const outcome = await new RunSupervisor({
      preparation: preparation(
        run,
        { invoke: () => Promise.resolve({ kind: 'ModelUsageUnavailable' }) },
        settlement,
      ),
      leaseAuthority: { renew: () => Promise.reject(new Error('renewal must not start')) },
      leaseAcceptances: ignoredLeaseAcceptances,
      leaseClock: waitingClock(),
      settlement: {
        settle: () => Promise.reject(new Error('prepared settlement must own the Run')),
      },
    }).supervise(run, receipt(run), new AbortController().signal, 0);

    expect(outcome).toMatchObject({
      kind: 'SettlementUnavailable',
      failure,
      run: { lifecycle: { kind: 'Active', phase: { kind: 'Running' } } },
      cause: { kind: 'ExecutorSettled', disposition: { kind: 'ModelUsageUnavailable' } },
    });
  });

  it.each([
    'ManagedWorktreeConflict',
    'EvidenceUnavailable',
    'LocalStateCorruption',
    'SecretDetected',
    'ModelCredentialUnavailable',
  ] as const)(
    'leaves failed %s preparation unchanged without invoking sealed settlement',
    async (failure) => {
      const run = leasedRunFixture();
      const renew = vi.fn<RunLeaseAuthority['renew']>();
      const settle = vi.fn<RunSupervisionSettlement['settle']>(() =>
        Promise.resolve({ kind: 'Unavailable' }),
      );
      const settlement: RunSupervisionSettlement = { settle };

      const outcome = await new RunSupervisor({
        preparation: {
          prepare: () =>
            Promise.resolve({
              kind: 'Rejected',
              failure: { kind: failure },
            }),
        },
        leaseAuthority: { renew },
        leaseAcceptances: ignoredLeaseAcceptances,
        leaseClock: waitingClock(),
        settlement,
      }).supervise(run, receipt(run), new AbortController().signal, 0);

      expect(outcome).toEqual({
        kind: 'Stopped',
        run,
        latestHostedRunVersion: run.version,
        cause: {
          kind: 'PreparationRejected',
          failure: { kind: failure },
        },
      });
      expect(run.lifecycle).toEqual({ kind: 'Active', phase: { kind: 'Preparing' } });
      expect(settle).not.toHaveBeenCalled();
      expect(renew).not.toHaveBeenCalled();
    },
  );

  it('aborts the active Pi executor when the lease cannot be renewed', async () => {
    const run = leasedRunFixture();
    let now = 1_000;
    const clock: LeaseClock = {
      monotonicNow: () => now,
      waitUntil: (deadline, signal) =>
        new Promise((resolve) => {
          setImmediate(() => {
            if (signal.aborted) {
              resolve({ kind: 'Aborted' });
              return;
            }
            now = deadline;
            resolve({ kind: 'Reached' });
          });
        }),
    };
    const pi: PiExecution = {
      invoke: vi.fn<PiExecution['invoke']>(
        (_run, signal) =>
          new Promise((resolve) => {
            signal.addEventListener(
              'abort',
              () => {
                resolve({ kind: 'Aborted' });
              },
              { once: true },
            );
          }),
      ),
    };
    const settlement: RunSupervisionSettlement = {
      settle: (input) => Promise.resolve({ kind: 'Settled', run: input.run }),
    };

    const outcome = await new RunSupervisor({
      preparation: preparation(run, pi, settlement),
      leaseAuthority: { renew: () => Promise.resolve({ kind: 'Unavailable' }) },
      leaseAcceptances: ignoredLeaseAcceptances,
      leaseClock: clock,
      settlement: {
        settle: () => Promise.reject(new Error('prepared settlement must own the Run')),
      },
    }).supervise(run, receipt(run), new AbortController().signal, 0);

    expect(outcome).toMatchObject({
      kind: 'Stopped',
      cause: {
        kind: 'LeaseKeeperSettled',
        disposition: { kind: 'LeaseLost', lastAcceptedRunVersion: 1 },
      },
    });
  });

  it('awaits executor shutdown before checkpoint settlement after lease loss', async () => {
    const run = leasedRunFixture();
    let now = 1_000;
    const clock: LeaseClock = {
      monotonicNow: () => now,
      waitUntil: (deadline, signal) =>
        new Promise((resolve) => {
          setImmediate(() => {
            if (signal.aborted) {
              resolve({ kind: 'Aborted' });
              return;
            }
            now = deadline;
            resolve({ kind: 'Reached' });
          });
        }),
    };
    const timeline: string[] = [];
    let finishShutdown: (() => void) | undefined;
    const pi: PiExecution = {
      invoke: (_run, signal) =>
        new Promise((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              timeline.push('shutdown-requested');
              finishShutdown = () => {
                timeline.push('executor-stopped');
                resolve({ kind: 'Aborted' });
              };
            },
            { once: true },
          );
        }),
    };
    const settlement: RunSupervisionSettlement = {
      settle: (input) => {
        timeline.push('settlement');
        return Promise.resolve({ kind: 'Settled', run: input.run });
      },
    };

    const supervision = new RunSupervisor({
      preparation: preparation(run, pi, settlement),
      leaseAuthority: { renew: () => Promise.resolve({ kind: 'Unavailable' }) },
      leaseAcceptances: ignoredLeaseAcceptances,
      leaseClock: clock,
      settlement,
    }).supervise(run, receipt(run), new AbortController().signal, 0);

    await vi.waitFor(() => {
      expect(finishShutdown).toBeTypeOf('function');
    });
    expect(timeline).toEqual(['shutdown-requested']);
    finishShutdown?.();
    await supervision;
    expect(timeline).toEqual(['shutdown-requested', 'executor-stopped', 'settlement']);
  });

  it('accepts each renewed lease for effect gating before publishing it to supervision', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const run = leasedRunFixture();
      const clock = new MonotonicLeaseClock();
      let completePi:
        | ((disposition: { readonly kind: 'Completed'; readonly sessionId: string }) => void)
        | undefined;
      const pi: PiExecution = {
        invoke: () =>
          new Promise((resolve) => {
            completePi = resolve;
          }),
      };
      const timeline: string[] = [];
      const settlement: RunSupervisionSettlement = {
        settle: (input) => {
          timeline.push('settlement');
          return Promise.resolve({ kind: 'Settled', run: input.run });
        },
      };
      const renewal: RunLeaseReceipt = {
        ...receipt(run),
        runVersion: run.version + 1,
        serverTime: '2026-09-24T20:00:21.000Z',
        expiresAt: '2026-09-24T20:01:06.000Z',
      };

      const supervision = new RunSupervisor({
        preparation: preparation(run, pi, settlement),
        leaseAuthority: { renew: () => Promise.resolve({ kind: 'Renewed', receipt: renewal }) },
        leaseAcceptances: {
          accept: (accepted) => {
            timeline.push(`accepted-${String(accepted.runVersion)}`);
            queueMicrotask(() => {
              completePi?.({ kind: 'Completed', sessionId: crypto.randomUUID() });
            });
          },
        },
        leaseClock: clock,
        settlement: {
          settle: () => Promise.reject(new Error('prepared settlement must own the Run')),
        },
      }).supervise(run, receipt(run), new AbortController().signal, 0);

      await vi.advanceTimersByTimeAsync(15_000);
      const outcome = await supervision;
      expect(outcome).toMatchObject({ kind: 'Stopped' });
      expect(timeline).toEqual([`accepted-${String(renewal.runVersion)}`, 'settlement']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts Pi before settlement at the lease deadline when the server never answers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const run = leasedRunFixture();
      const timeline: string[] = [];
      const pi: PiExecution = {
        invoke: (_run, signal) =>
          new Promise((resolve) => {
            signal.addEventListener(
              'abort',
              () => {
                timeline.push('executor-aborted');
                resolve({ kind: 'Aborted' });
              },
              { once: true },
            );
          }),
      };
      const settlement: RunSupervisionSettlement = {
        settle: (input) => {
          timeline.push('settlement');
          return Promise.resolve({ kind: 'Settled', run: input.run });
        },
      };
      const settled = vi.fn();
      const supervision = new RunSupervisor({
        preparation: preparation(run, pi, settlement),
        leaseAuthority: { renew: () => new Promise(() => undefined) },
        leaseAcceptances: ignoredLeaseAcceptances,
        leaseClock: new MonotonicLeaseClock(),
        settlement,
      })
        .supervise(run, receipt(run), new AbortController().signal, 0)
        .then(settled);
      await vi.advanceTimersByTimeAsync(40_000);
      expect(timeline).toEqual(['executor-aborted', 'settlement']);
      expect(settled).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'Stopped',
          cause: {
            kind: 'LeaseKeeperSettled',
            disposition: { kind: 'LeaseLost', lastAcceptedRunVersion: 1 },
          },
        }),
      );
      await supervision;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops at the Run wall-time ceiling and records the final elapsed debit before settlement', async () => {
    const leased = leasedRunFixture();
    const run: Run = {
      ...leased,
      consumedBudget: {
        ...leased.consumedBudget,
        runWallTimeSeconds: leased.binding.budget.runWallTimeSeconds - 1,
      },
    };
    const observations: EvidenceObservation[] = [];
    const resourceBudget = budget(run, observations);
    let now = 1_000;
    const wallClock: LeaseClock = {
      monotonicNow: () => now,
      waitUntil: (deadline) => {
        now = deadline;
        return Promise.resolve({ kind: 'Reached' });
      },
    };
    const pi: PiExecution = {
      invoke: (_run, signal) =>
        new Promise((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              resolve({ kind: 'Aborted' });
            },
            { once: true },
          );
        }),
    };
    const settlement: RunSupervisionSettlement = {
      settle: (input) => {
        expect(resourceBudget.snapshot().runWallTimeSeconds).toBe(
          run.binding.budget.runWallTimeSeconds,
        );
        return Promise.resolve({ kind: 'Settled', run: input.run });
      },
    };

    const cancellation = new AbortController();
    const supervision = new RunSupervisor({
      preparation: preparation(run, pi, settlement, resourceBudget, wallClock),
      leaseAuthority: { renew: () => Promise.resolve({ kind: 'Unavailable' }) },
      leaseAcceptances: ignoredLeaseAcceptances,
      leaseClock: waitingClock(),
      settlement,
    }).supervise(run, receipt(run), cancellation.signal, 0);
    setTimeout(() => {
      cancellation.abort();
    }, 25);
    const outcome = await supervision;

    expect(outcome).toMatchObject({
      kind: 'Stopped',
      cause: { kind: 'ExecutorSettled', disposition: { kind: 'BudgetExhausted' } },
    });
    expect(observations.map(({ event }) => event)).toEqual([
      {
        kind: 'BudgetDebited',
        budget: 'runWallTimeSeconds',
        amount: 1,
        consumed: run.binding.budget.runWallTimeSeconds,
      },
    ]);
  });
});
