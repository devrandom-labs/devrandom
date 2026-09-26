import type { Run, RunExecutionStart } from '@devrandom/domain';
import type { EvidenceProblem } from '@devrandom/protocol';
import { assign, createActor, fromCallback, fromPromise, sendTo, setup, toPromise } from 'xstate';

import {
  keepRunLease,
  runLeaseSafetyDeadline,
  type LeaseClock,
  type RunLeaseAcceptances,
  type RunLeaseAuthority,
  type RunLeaseKeeping,
  type RunLeaseReceipt,
} from './lease-keeper.js';
import type { RunBudgetCommitment, RunResourceBudget } from './run-resource-budget.js';

export type RunPreparationFailure =
  | {
      readonly kind: 'DomainTransitionRejected';
      readonly outcome: Exclude<RunExecutionStart, { readonly kind: 'Started' }>;
    }
  | { readonly kind: 'RepositoryBindingRejected' }
  | { readonly kind: 'ManagedWorktreeConflict' }
  | { readonly kind: 'GitUnavailable' }
  | { readonly kind: 'EvidenceUnavailable' }
  | { readonly kind: 'LaterRuntimeRecoveryRequired' }
  | { readonly kind: 'OutboxBackpressure' }
  | { readonly kind: 'LocalStateCorruption' }
  | { readonly kind: 'SecretDetected' }
  | { readonly kind: 'ModelCredentialUnavailable' }
  | { readonly kind: 'DependencyUnavailable' };

export type RunExecutionPreparationOutcome =
  | { readonly kind: 'Interrupted' }
  | { readonly kind: 'Ready'; readonly execution: PreparedRunExecution }
  | { readonly kind: 'Rejected'; readonly failure: RunPreparationFailure };

export interface PreparedRunExecution {
  /** Release resources only when execution has never been invoked. */
  releasePreparation(): void;
  readonly run: Run;
  readonly pi: PiExecution;
  readonly evidenceDelivery: RunEvidenceDelivery;
  readonly settlement: RunSupervisionSettlement;
  readonly budget: RunResourceBudget;
  readonly wallClock: RunWallClock;
}

export type RunEvidenceDeliveryDisposition =
  | { readonly kind: 'Aborted' }
  | { readonly kind: 'EvidenceUnavailable' }
  | { readonly kind: 'EvidenceIntegrityFailure' }
  | { readonly kind: 'DependencyUnavailable' };

export interface RunEvidenceDelivery {
  deliver(signal: AbortSignal): Promise<RunEvidenceDeliveryDisposition>;
}

export type RunWallWait = { readonly kind: 'Reached' } | { readonly kind: 'Aborted' };

export interface RunWallClock {
  monotonicNow(): number;
  waitUntil(deadline: number, signal: AbortSignal): Promise<RunWallWait>;
}

export interface RunExecutionPreparation {
  prepare(run: Run, signal: AbortSignal): Promise<RunExecutionPreparationOutcome>;
}

export type ContextCapacityMeasurement =
  | {
      readonly kind: 'InitialInput';
      readonly encodedBytes: number;
      readonly allowedInputTokens: number;
      readonly providerRequestsAdmitted: 0;
    }
  | {
      readonly kind: 'ProviderRequest';
      readonly piEstimateTokens: number;
      readonly encodedBytes: number;
      readonly profile: 'AsciiGemmaEstimate' | 'ByteFallback';
      readonly admissionEstimateTokens: number;
      readonly allowedInputTokens: number;
      readonly providerRequestsAdmitted: number;
    };

export type PiExecutionDisposition =
  | { readonly kind: 'Completed'; readonly sessionId: string }
  | { readonly kind: 'Aborted' }
  | { readonly kind: 'ModelConfigurationRequired' }
  | { readonly kind: 'ModelCredentialUnavailable' }
  | { readonly kind: 'ContextLimitReached'; readonly measurement: ContextCapacityMeasurement }
  | { readonly kind: 'ProviderUnavailable' }
  | { readonly kind: 'ModelUsageUnavailable' }
  | { readonly kind: 'EvidenceUnavailable' }
  | { readonly kind: 'ApprovalRequired' }
  | { readonly kind: 'TaskMandateExpired' }
  | { readonly kind: 'AuthorityRevoked' }
  | { readonly kind: 'BudgetExhausted' }
  | { readonly kind: 'LeaseLost' }
  | { readonly kind: 'EvidenceIntegrityFailure' }
  | { readonly kind: 'OutboxBackpressure' }
  | { readonly kind: 'SecretDetected' }
  | { readonly kind: 'DependencyUnavailable' };

export interface PiExecution {
  invoke(run: Run, signal: AbortSignal): Promise<PiExecutionDisposition>;
}

export type RunStopCause =
  | { readonly kind: 'PreparationRejected'; readonly failure: RunPreparationFailure }
  | { readonly kind: 'ExecutorSettled'; readonly disposition: PiExecutionDisposition }
  | { readonly kind: 'LeaseKeeperSettled'; readonly disposition: RunLeaseKeeping }
  | { readonly kind: 'UserInterrupted' }
  | { readonly kind: 'SupervisorIntegrityFailure' };

export interface RunSettlementInput {
  readonly run: Run;
  readonly cause: RunStopCause;
  readonly latestHostedRunVersion: number;
}

export type RunSettlementFailure =
  | {
      readonly kind: 'EvidenceDeliveryRejected';
      readonly delivery:
        | {
            readonly kind: 'ArtifactDeliveryRejected' | 'BatchDeliveryRejected';
            readonly failure:
              | { readonly kind: 'InputInvalid' | 'ServerUnavailable' | 'ResponseInvalid' }
              | {
                  readonly kind: 'RequestRejected';
                  readonly code: Exclude<EvidenceProblem['code'], 'EvidenceConflict'>;
                }
              | ({ readonly kind: 'RequestRejected'; readonly code: 'EvidenceConflict' } & (
                  | {
                      readonly reason: 'SequenceGap';
                      readonly expectedStartingSequence: number;
                      readonly receivedStartingSequence: number;
                    }
                  | {
                      readonly reason: Exclude<
                        Extract<EvidenceProblem, { readonly code: 'EvidenceConflict' }>['reason'],
                        'SequenceGap'
                      >;
                    }
                ));
          }
        | {
            readonly kind:
              | 'Aborted'
              | 'CheckpointUnavailable'
              | 'LocalStateCorruption'
              | 'OutboxUnavailable'
              | 'AcknowledgementRejected';
          };
    }
  | {
      readonly kind: 'EvidenceSealingRejected';
      readonly reason:
        | 'CheckpointAcceptanceRejected'
        | 'SecretDetected'
        | 'EvidenceIntegrityFailure'
        | 'EvidenceUnavailable'
        | 'SealExchangeUnavailable'
        | 'SealObservationUnavailable'
        | 'SealPendingLimitReached'
        | 'SealReconciliationRejected'
        | 'SealProjectionRejected'
        | 'SealAcknowledgementRejected';
    };

export type RunSettlement =
  | { readonly kind: 'Settled'; readonly run: Run }
  | { readonly kind: 'Unavailable' }
  | { readonly kind: 'EvidenceSealingFailed'; readonly failure: RunSettlementFailure };

export interface RunSupervisionSettlement {
  settle(input: RunSettlementInput): Promise<RunSettlement>;
}

export type RunSupervision =
  | {
      readonly kind: 'Stopped';
      readonly run: Run;
      readonly cause: RunStopCause;
      readonly latestHostedRunVersion: number;
    }
  | {
      readonly kind: 'SettlementUnavailable';
      readonly run: Run;
      readonly cause: RunStopCause;
      readonly failure: { readonly kind: 'Unspecified' } | RunSettlementFailure;
      readonly latestHostedRunVersion: number;
    }
  | { readonly kind: 'SupervisorIntegrityFailure' };

export interface RunSupervisorDependencies {
  readonly preparation: RunExecutionPreparation;
  readonly leaseAuthority: RunLeaseAuthority;
  readonly leaseAcceptances: RunLeaseAcceptances;
  readonly leaseClock: LeaseClock;
  readonly settlement: RunSupervisionSettlement;
}

type SupervisorExecution =
  | { readonly kind: 'Pending'; readonly run: Run }
  | { readonly kind: 'Ready'; readonly execution: PreparedRunExecution };

interface SupervisorContext {
  readonly execution: SupervisorExecution;
  readonly lease: RunLeaseReceipt;
  readonly latestHostedRunVersion: number;
  readonly stopCause: RunStopCause | undefined;
  readonly settlement: RunSettlement | undefined;
  readonly wallStartedAt: number | undefined;
}

type SupervisorEvent =
  | { readonly type: 'supervision.interrupted' }
  | { readonly type: 'pi.settled'; readonly disposition: PiExecutionDisposition }
  | { readonly type: 'lease.renewed'; readonly receipt: RunLeaseReceipt }
  | { readonly type: 'lease.settled'; readonly disposition: RunLeaseKeeping }
  | { readonly type: 'wall-time.exhausted' }
  | { readonly type: 'wall-time.integrity-failed' };

type SupervisorActionParameters = {
  readonly setPreparedExecution: {
    readonly outcome: SupervisedPreparation;
    readonly startedAt: number;
  };
  readonly setPreparationFailure: { readonly failure: RunPreparationFailure };
  readonly setExecutorDisposition: { readonly disposition: PiExecutionDisposition };
  readonly setLeaseReceipt: { readonly receipt: RunLeaseReceipt };
  readonly setLeaseDisposition: { readonly disposition: RunLeaseKeeping };
  readonly setInterrupted: undefined;
  readonly setWallTimeExhausted: undefined;
  readonly setSupervisorIntegrityFailure: undefined;
  readonly setAccountedCause: { readonly cause: RunStopCause };
  readonly setSettlement: { readonly settlement: RunSettlement };
};

type SupervisedPreparation =
  | RunExecutionPreparationOutcome
  | { readonly kind: 'LeaseStopped'; readonly disposition: RunLeaseKeeping };

interface PreparationActorInput {
  readonly interruption: AbortSignal;
  readonly lease: RunLeaseReceipt;
  readonly leaseReceivedAt: number;
  readonly leaseClock: LeaseClock;
  readonly preparation: RunExecutionPreparation;
  readonly run: Run;
}

interface ExecutionActorInput {
  readonly execution: SupervisorExecution;
}

type ExecutionCommand = { readonly type: 'pi.stop' };

interface LeaseActorInput {
  readonly receivedAt: number;
  readonly authority: RunLeaseAuthority;
  readonly acceptances: RunLeaseAcceptances;
  readonly clock: LeaseClock;
  readonly receipt: RunLeaseReceipt;
}

interface SettlementActorInput extends RunSettlementInput {
  readonly settlement: RunSupervisionSettlement;
}

interface WallTimeActorInput {
  readonly execution: SupervisorExecution;
  readonly startedAt: number | undefined;
}

interface WallTimeAccountingInput extends WallTimeActorInput {
  readonly cause: RunStopCause | undefined;
}

type WallTimeCommand = { readonly type: 'wall-time.stop' };

type SupervisorChildren = {
  readonly 'run-preparation': 'prepareRun';
  readonly 'run-execution': 'executeRun';
  readonly 'lease-keeper': 'keepLease';
  readonly 'run-wall-time': 'keepWallTime';
  readonly 'run-wall-time-accounting': 'accountWallTime';
  readonly 'run-settlement': 'settleRun';
};

const prepareRun = fromPromise<SupervisedPreparation, PreparationActorInput>(async ({ input }) => {
  const deadline = runLeaseSafetyDeadline(input.leaseReceivedAt, input.lease);
  if (deadline === undefined) {
    return {
      kind: 'LeaseStopped',
      disposition: { kind: 'LeaseReceiptRejected', lastAcceptedRunVersion: input.lease.runVersion },
    };
  }
  const preparation = new AbortController();
  const watching = new AbortController();
  const interrupt = (): void => {
    preparation.abort();
  };
  input.interruption.addEventListener('abort', interrupt, { once: true });
  if (input.interruption.aborted) interrupt();
  const deadlineWait = (async () => {
    try {
      const waited = await input.leaseClock.waitUntil(deadline, watching.signal);
      if (waited.kind === 'Reached') preparation.abort();
      return waited;
    } catch {
      preparation.abort();
      return { kind: 'Unavailable' as const };
    }
  })();
  let prepared: RunExecutionPreparationOutcome;
  try {
    prepared = await input.preparation.prepare(input.run, preparation.signal);
  } catch {
    prepared = { kind: 'Rejected', failure: { kind: 'DependencyUnavailable' } };
  } finally {
    watching.abort();
    input.interruption.removeEventListener('abort', interrupt);
  }
  const waited = await deadlineWait;
  const now = input.leaseClock.monotonicNow();
  let stopped: SupervisedPreparation | undefined;
  if (input.interruption.aborted) {
    stopped = { kind: 'Interrupted' };
  } else if (
    waited.kind === 'Reached' ||
    !Number.isFinite(now) ||
    now < input.leaseReceivedAt ||
    now >= deadline
  ) {
    stopped = {
      kind: 'LeaseStopped',
      disposition: { kind: 'LeaseLost', lastAcceptedRunVersion: input.lease.runVersion },
    };
  } else if (waited.kind === 'Unavailable') {
    stopped = { kind: 'Rejected', failure: { kind: 'DependencyUnavailable' } };
  }
  if (stopped !== undefined) {
    if (prepared.kind === 'Ready') prepared.execution.releasePreparation();
    return stopped;
  }
  return prepared;
});

const executeRun = fromCallback<ExecutionCommand, ExecutionActorInput>(
  ({ input, receive, sendBack }) => {
    const cancellation = new AbortController();
    receive(() => {
      cancellation.abort();
    });
    void (async (): Promise<PiExecutionDisposition> => {
      if (input.execution.kind !== 'Ready') return { kind: 'DependencyUnavailable' };
      const execution = input.execution.execution;
      const pi = Promise.resolve()
        .then(() => execution.pi.invoke(execution.run, cancellation.signal))
        .catch((): PiExecutionDisposition => ({ kind: 'DependencyUnavailable' }));
      const delivery = Promise.resolve()
        .then(() => execution.evidenceDelivery.deliver(cancellation.signal))
        .catch((): RunEvidenceDeliveryDisposition => ({ kind: 'EvidenceUnavailable' }));
      await Promise.race([pi, delivery]);
      cancellation.abort();
      const [disposition, delivered] = await Promise.all([pi, delivery]);
      // Settlement owns the recorder only after the producer and transport have joined.
      return delivered.kind === 'Aborted' ? disposition : delivered;
    })().then((disposition) => {
      sendBack({ type: 'pi.settled', disposition });
    });
    return () => {
      cancellation.abort();
    };
  },
);

const keepLease = fromCallback<{ readonly type: 'lease.stop' }, LeaseActorInput>(
  ({ input, sendBack }) => {
    const cancellation = new AbortController();
    void keepRunLease(
      input.receipt,
      input.receivedAt,
      input.authority,
      input.clock,
      cancellation.signal,
      {
        accept: (receipt, requestStartedAt) => {
          input.acceptances.accept(receipt, requestStartedAt);
          sendBack({ type: 'lease.renewed', receipt });
        },
      },
    ).then(
      (disposition) => {
        sendBack({ type: 'lease.settled', disposition });
      },
      () => {
        sendBack({
          type: 'lease.settled',
          disposition: {
            kind: 'LeaseReceiptRejected',
            lastAcceptedRunVersion: input.receipt.runVersion,
          },
        });
      },
    );
    return () => {
      cancellation.abort();
    };
  },
);

const keepWallTime = fromCallback<WallTimeCommand, WallTimeActorInput>(({ input, sendBack }) => {
  const cancellation = new AbortController();
  if (
    input.execution.kind !== 'Ready' ||
    input.startedAt === undefined ||
    !Number.isFinite(input.startedAt) ||
    input.execution.execution.budget.runId !== input.execution.execution.run.binding.runId
  ) {
    sendBack({ type: 'wall-time.integrity-failed' });
    return () => {
      cancellation.abort();
    };
  }
  const { run, budget, wallClock } = input.execution.execution;
  const remaining = run.binding.budget.runWallTimeSeconds - budget.snapshot().runWallTimeSeconds;
  if (!Number.isSafeInteger(remaining) || remaining < 0) {
    sendBack({ type: 'wall-time.integrity-failed' });
    return () => {
      cancellation.abort();
    };
  }
  if (remaining === 0) {
    sendBack({ type: 'wall-time.exhausted' });
    return () => {
      cancellation.abort();
    };
  }
  const deadline = input.startedAt + remaining * 1_000;
  if (!Number.isFinite(deadline)) {
    sendBack({ type: 'wall-time.integrity-failed' });
    return () => {
      cancellation.abort();
    };
  }
  let waiting: Promise<RunWallWait>;
  try {
    waiting = wallClock.waitUntil(deadline, cancellation.signal);
  } catch {
    sendBack({ type: 'wall-time.integrity-failed' });
    return () => {
      cancellation.abort();
    };
  }
  void waiting.then(
    (wait) => {
      if (wait.kind === 'Reached' && !cancellation.signal.aborted) {
        sendBack({ type: 'wall-time.exhausted' });
      }
    },
    () => {
      if (!cancellation.signal.aborted) {
        sendBack({ type: 'wall-time.integrity-failed' });
      }
    },
  );
  return () => {
    cancellation.abort();
  };
});

function wallTimeFailure(
  commitment: Exclude<RunBudgetCommitment, { readonly kind: 'Committed' }>,
): RunStopCause {
  switch (commitment.kind) {
    case 'SecretDetected':
      return { kind: 'ExecutorSettled', disposition: { kind: 'SecretDetected' } };
    case 'Exhausted':
      return { kind: 'ExecutorSettled', disposition: { kind: 'BudgetExhausted' } };
    case 'OutboxBackpressure':
      return { kind: 'ExecutorSettled', disposition: { kind: 'OutboxBackpressure' } };
    case 'Unavailable':
      return { kind: 'ExecutorSettled', disposition: { kind: 'DependencyUnavailable' } };
    case 'EvidenceIntegrityFailure':
    case 'ReservationRejected':
      return { kind: 'ExecutorSettled', disposition: { kind: 'EvidenceIntegrityFailure' } };
  }
}

function accountedWallTime(input: WallTimeAccountingInput): RunStopCause {
  if (
    input.execution.kind !== 'Ready' ||
    input.startedAt === undefined ||
    input.cause === undefined
  ) {
    return { kind: 'SupervisorIntegrityFailure' };
  }
  const { budget, wallClock } = input.execution.execution;
  const elapsedMilliseconds = Math.ceil(wallClock.monotonicNow() - input.startedAt);
  if (!Number.isSafeInteger(elapsedMilliseconds) || elapsedMilliseconds < 0) {
    return { kind: 'SupervisorIntegrityFailure' };
  }
  const elapsedSeconds = Math.ceil(elapsedMilliseconds / 1_000);
  if (elapsedSeconds === 0) {
    return input.cause;
  }
  const reservation = budget.reserve([{ budget: 'runWallTimeSeconds', amount: elapsedSeconds }]);
  if (reservation.kind === 'Exhausted') {
    return { kind: 'ExecutorSettled', disposition: { kind: 'BudgetExhausted' } };
  }
  if (reservation.kind !== 'Reserved') {
    return { kind: 'SupervisorIntegrityFailure' };
  }
  const commitment = budget.commit(reservation.reservation, {
    producer: { kind: 'RunSupervisor' },
    actual: [{ budget: 'runWallTimeSeconds', amount: elapsedSeconds }],
  });
  return commitment.kind === 'Committed' ? input.cause : wallTimeFailure(commitment);
}

const accountWallTime = fromPromise<RunStopCause, WallTimeAccountingInput>(({ input }) => {
  try {
    return Promise.resolve(accountedWallTime(input));
  } catch {
    return Promise.resolve({ kind: 'SupervisorIntegrityFailure' });
  }
});

const settleRun = fromPromise<RunSettlement, SettlementActorInput>(async ({ input }) => {
  try {
    return await input.settlement.settle(input);
  } catch {
    return { kind: 'Unavailable' };
  }
});

const supervisorActors = {
  prepareRun,
  executeRun,
  keepLease,
  keepWallTime,
  accountWallTime,
  settleRun,
};

const supervisorSetup = setup<
  SupervisorContext,
  SupervisorEvent,
  typeof supervisorActors,
  SupervisorChildren,
  SupervisorActionParameters
>({
  actors: supervisorActors,
  actions: {
    setPreparedExecution: assign({
      execution: ({ context }, parameters) =>
        parameters.outcome.kind === 'Ready'
          ? { kind: 'Ready', execution: parameters.outcome.execution }
          : context.execution,
      wallStartedAt: (_arguments, parameters) => parameters.startedAt,
    }),
    setPreparationFailure: assign({
      stopCause: (_arguments, parameters) => ({
        kind: 'PreparationRejected',
        failure: parameters.failure,
      }),
    }),
    setExecutorDisposition: assign({
      stopCause: (_arguments, parameters) => ({
        kind: 'ExecutorSettled',
        disposition: parameters.disposition,
      }),
    }),
    setLeaseReceipt: assign({
      latestHostedRunVersion: (_arguments, parameters) => parameters.receipt.runVersion,
      lease: (_arguments, parameters) => parameters.receipt,
    }),
    setLeaseDisposition: assign({
      latestHostedRunVersion: ({ context }, parameters) =>
        parameters.disposition.kind === 'StoppedBySupervisor'
          ? parameters.disposition.latestRunVersion
          : context.latestHostedRunVersion,
      stopCause: (_arguments, parameters) => ({
        kind: 'LeaseKeeperSettled',
        disposition: parameters.disposition,
      }),
    }),
    setInterrupted: assign({
      stopCause: { kind: 'UserInterrupted' },
    }),
    setWallTimeExhausted: assign({
      stopCause: {
        kind: 'ExecutorSettled',
        disposition: { kind: 'BudgetExhausted' },
      },
    }),
    setSupervisorIntegrityFailure: assign({
      stopCause: { kind: 'SupervisorIntegrityFailure' },
    }),
    setAccountedCause: assign({
      stopCause: (_arguments, parameters) => parameters.cause,
    }),
    setSettlement: assign({
      settlement: (_arguments, parameters) => parameters.settlement,
    }),
  },
});

function supervisedRun(execution: SupervisorExecution): Run {
  return execution.kind === 'Ready' ? execution.execution.run : execution.run;
}

function supervisorMachine(
  run: Run,
  lease: RunLeaseReceipt,
  dependencies: RunSupervisorDependencies,
  leaseReceivedAt: number,
  interruption: AbortSignal,
) {
  return supervisorSetup.createMachine({
    id: 'run-supervisor',
    initial: 'preparing',
    context: {
      execution: { kind: 'Pending', run },
      lease,
      latestHostedRunVersion: lease.runVersion,
      stopCause: undefined,
      settlement: undefined,
      wallStartedAt: undefined,
    },
    states: {
      preparing: {
        invoke: {
          id: 'run-preparation',
          src: 'prepareRun',
          input: ({ context }) => ({
            preparation: dependencies.preparation,
            run: supervisedRun(context.execution),
            interruption,
            lease,
            leaseReceivedAt,
            leaseClock: dependencies.leaseClock,
          }),
          onDone: [
            {
              guard: ({ event }) => event.output.kind === 'Interrupted',
              actions: { type: 'setInterrupted' },
              target: 'stopped',
            },
            {
              guard: ({ event }) => event.output.kind === 'LeaseStopped',
              actions: {
                type: 'setLeaseDisposition',
                params: ({ event }) => ({
                  disposition:
                    event.output.kind === 'LeaseStopped'
                      ? event.output.disposition
                      : { kind: 'LeaseReceiptRejected', lastAcceptedRunVersion: lease.runVersion },
                }),
              },
              target: 'stopped',
            },
            {
              guard: ({ event }) => event.output.kind === 'Ready',
              actions: {
                type: 'setPreparedExecution',
                params: ({ event }) => ({
                  outcome: event.output,
                  startedAt:
                    event.output.kind === 'Ready'
                      ? event.output.execution.wallClock.monotonicNow()
                      : Number.NaN,
                }),
              },
              target: 'executing',
            },
            {
              actions: {
                type: 'setPreparationFailure',
                params: ({ event }) => ({
                  failure:
                    event.output.kind === 'Rejected'
                      ? event.output.failure
                      : { kind: 'DependencyUnavailable' },
                }),
              },
              target: 'stopped',
            },
          ],
        },
        on: {
          'supervision.interrupted': {
            actions: { type: 'setInterrupted' },
          },
        },
      },
      executing: {
        initial: 'active',
        invoke: [
          {
            id: 'run-execution',
            src: 'executeRun',
            input: ({ context }) => ({ execution: context.execution }),
          },
          {
            id: 'lease-keeper',
            src: 'keepLease',
            input: ({ context }) => ({
              authority: dependencies.leaseAuthority,
              acceptances: dependencies.leaseAcceptances,
              clock: dependencies.leaseClock,
              receipt: context.lease,
              receivedAt: leaseReceivedAt,
            }),
          },
          {
            id: 'run-wall-time',
            src: 'keepWallTime',
            input: ({ context }) => ({
              execution: context.execution,
              startedAt: context.wallStartedAt,
            }),
          },
        ],
        on: {
          'lease.renewed': {
            actions: {
              type: 'setLeaseReceipt',
              params: ({ event }) => ({ receipt: event.receipt }),
            },
          },
        },
        states: {
          active: {
            on: {
              'pi.settled': {
                actions: {
                  type: 'setExecutorDisposition',
                  params: ({ event }) => ({ disposition: event.disposition }),
                },
                target: '#run-supervisor.accounting',
              },
              'lease.settled': {
                actions: [
                  {
                    type: 'setLeaseDisposition',
                    params: ({ event }) => ({ disposition: event.disposition }),
                  },
                  sendTo('run-execution', { type: 'pi.stop' }),
                ],
                target: 'stopping',
              },
              'supervision.interrupted': {
                actions: [{ type: 'setInterrupted' }, sendTo('run-execution', { type: 'pi.stop' })],
                target: 'stopping',
              },
              'wall-time.exhausted': {
                actions: [
                  { type: 'setWallTimeExhausted' },
                  sendTo('run-execution', { type: 'pi.stop' }),
                ],
                target: 'stopping',
              },
              'wall-time.integrity-failed': {
                actions: [
                  { type: 'setSupervisorIntegrityFailure' },
                  sendTo('run-execution', { type: 'pi.stop' }),
                ],
                target: 'stopping',
              },
            },
          },
          stopping: {
            on: {
              'pi.settled': { target: '#run-supervisor.accounting' },
            },
          },
        },
      },
      accounting: {
        invoke: {
          id: 'run-wall-time-accounting',
          src: 'accountWallTime',
          input: ({ context }) => ({
            execution: context.execution,
            startedAt: context.wallStartedAt,
            cause: context.stopCause,
          }),
          onDone: {
            actions: {
              type: 'setAccountedCause',
              params: ({ event }) => ({ cause: event.output }),
            },
            target: 'settling',
          },
        },
      },
      settling: {
        invoke: {
          id: 'run-settlement',
          src: 'settleRun',
          input: ({ context }) => ({
            settlement:
              context.execution.kind === 'Ready'
                ? context.execution.execution.settlement
                : dependencies.settlement,
            run: supervisedRun(context.execution),
            cause: context.stopCause ?? { kind: 'SupervisorIntegrityFailure' },
            latestHostedRunVersion: context.latestHostedRunVersion,
          }),
          onDone: {
            actions: {
              type: 'setSettlement',
              params: ({ event }) => ({ settlement: event.output }),
            },
            target: 'stopped',
          },
        },
      },
      stopped: { type: 'final' },
    },
  });
}

export class RunSupervisor {
  readonly #dependencies: RunSupervisorDependencies;

  constructor(dependencies: RunSupervisorDependencies) {
    this.#dependencies = dependencies;
  }

  async supervise(
    run: Run,
    lease: RunLeaseReceipt,
    signal: AbortSignal,
    leaseRequestStartedAt: number,
  ): Promise<RunSupervision> {
    if (signal.aborted) {
      return {
        kind: 'Stopped',
        run,
        cause: { kind: 'UserInterrupted' },
        latestHostedRunVersion: lease.runVersion,
      };
    }
    const deadline = runLeaseSafetyDeadline(leaseRequestStartedAt, lease);
    const now = this.#dependencies.leaseClock.monotonicNow();
    if (
      deadline === undefined ||
      !Number.isFinite(now) ||
      now < leaseRequestStartedAt ||
      now >= deadline
    ) {
      return {
        kind: 'Stopped',
        run,
        cause: {
          kind: 'LeaseKeeperSettled',
          disposition: {
            kind: deadline === undefined ? 'LeaseReceiptRejected' : 'LeaseLost',
            lastAcceptedRunVersion: lease.runVersion,
          },
        },
        latestHostedRunVersion: lease.runVersion,
      };
    }
    const actor = createActor(
      supervisorMachine(run, lease, this.#dependencies, leaseRequestStartedAt, signal),
    );
    const interrupt = () => {
      actor.send({ type: 'supervision.interrupted' });
    };
    signal.addEventListener('abort', interrupt, { once: true });
    actor.start();
    await toPromise(actor);
    signal.removeEventListener('abort', interrupt);
    const context = actor.getSnapshot().context;
    if (context.stopCause === undefined) {
      return { kind: 'SupervisorIntegrityFailure' };
    }
    if (context.execution.kind === 'Pending') {
      return {
        kind: 'Stopped',
        run: context.execution.run,
        cause: context.stopCause,
        latestHostedRunVersion: context.latestHostedRunVersion,
      };
    }
    if (context.settlement === undefined) {
      return { kind: 'SupervisorIntegrityFailure' };
    }
    if (context.settlement.kind !== 'Settled') {
      return {
        kind: 'SettlementUnavailable',
        run: supervisedRun(context.execution),
        cause: context.stopCause,
        failure:
          context.settlement.kind === 'EvidenceSealingFailed'
            ? context.settlement.failure
            : { kind: 'Unspecified' },
        latestHostedRunVersion: context.latestHostedRunVersion,
      };
    }
    const supervised = supervisedRun(context.execution);
    if (context.settlement.run.binding.runId !== supervised.binding.runId) {
      return { kind: 'SupervisorIntegrityFailure' };
    }
    return {
      kind: 'Stopped',
      run: context.settlement.run,
      cause: context.stopCause,
      latestHostedRunVersion: context.latestHostedRunVersion,
    };
  }
}
