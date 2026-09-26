import { taskBudgetNames } from '../task/authority.js';
import { runLeasePolicy } from './lease.js';
import type { Run } from './run.js';

export interface RunContinuationInput {
  readonly expectedRunVersion: number;
  readonly serverTime: string;
  readonly predecessor: {
    readonly incarnationId: string;
    readonly evidenceStreamId: string;
    readonly checkpointSaid: string;
  };
  readonly successor: {
    readonly segmentSaid: string;
    readonly incarnationId: string;
    readonly evidenceStreamId: string;
    readonly harnessRevisionSaid: string;
  };
  readonly activation: {
    readonly pointerVersion: number;
    readonly activeRevisionSaid: string;
    readonly decisionReceiptSaid: string;
  };
  readonly effects: 'Settled' | 'Unresolved';
}

export interface CalibrationRunContinuationInput extends Omit<RunContinuationInput, 'activation'> {
  readonly baseline: { readonly pointerVersion: 1; readonly harnessRevisionSaid: string };
}

export type RunContinuation =
  | { readonly kind: 'Admitted' | 'Equivalent'; readonly run: Run }
  | { readonly kind: 'VersionConflict'; readonly currentVersion: number }
  | {
      readonly kind:
        | 'RunNotRetained'
        | 'RunNotCalibration'
        | 'RunNotPaused'
        | 'CheckpointConflict'
        | 'LeaseConflict'
        | 'LeaseStillHeld'
        | 'ActivationConflict'
        | 'BudgetExhausted'
        | 'UnresolvedEffects'
        | 'TimeInvalid';
    };

/** Replace exactly one expired incarnation of the same retained Run after a sealed pause. */
export function continueRun(run: Run, input: RunContinuationInput): RunContinuation {
  if (run.binding.purpose.kind !== 'Retained') return { kind: 'RunNotRetained' };
  return continueIncarnation(run, input);
}

/** Recover the same calibration attempt, preserving H1 and its cumulative authority budget. */
export function continueCalibrationRun(
  run: Run,
  input: CalibrationRunContinuationInput,
): RunContinuation {
  if (run.binding.purpose.kind !== 'PreparedCompatibilityCalibration')
    return { kind: 'RunNotCalibration' };
  return continueIncarnation(run, input);
}

function continueIncarnation(
  run: Run,
  input: RunContinuationInput | CalibrationRunContinuationInput,
): RunContinuation {
  const calibration = 'baseline' in input;
  if (
    calibration &&
    (input.baseline.harnessRevisionSaid !== run.binding.initialHarnessRevisionSaid ||
      input.successor.harnessRevisionSaid !== run.binding.initialHarnessRevisionSaid ||
      (run.currentExecution !== undefined &&
        run.currentExecution.harnessRevisionSaid !== run.binding.initialHarnessRevisionSaid))
  )
    return { kind: 'ActivationConflict' };
  if (
    run.currentExecution?.segmentSaid === input.successor.segmentSaid &&
    run.lease.kind === 'Held' &&
    run.lease.incarnationId === input.successor.incarnationId &&
    run.currentExecution.evidenceStreamId === input.successor.evidenceStreamId &&
    run.currentExecution.harnessRevisionSaid === input.successor.harnessRevisionSaid
  )
    return { kind: 'Equivalent', run };
  if (run.version !== input.expectedRunVersion)
    return { kind: 'VersionConflict', currentVersion: run.version };
  if (
    run.lifecycle.kind !== 'Active' ||
    run.lifecycle.phase.kind !== 'Blocked' ||
    (calibration
      ? run.lifecycle.phase.reason !== 'ContextLimitReached'
      : run.lifecycle.phase.reason !== 'CheckpointPause' &&
        (run.lifecycle.phase.reason !== 'HarnessCompatibilityFailure' ||
          run.currentExecution !== undefined))
  )
    return { kind: 'RunNotPaused' };
  if (run.lifecycle.phase.checkpointSaid !== input.predecessor.checkpointSaid)
    return { kind: 'CheckpointConflict' };
  const predecessorStreamId =
    run.currentExecution?.evidenceStreamId ?? run.binding.evidenceStreamId;
  if (
    run.lease.kind !== 'Held' ||
    run.lease.incarnationId !== input.predecessor.incarnationId ||
    predecessorStreamId !== input.predecessor.evidenceStreamId ||
    input.successor.incarnationId === input.predecessor.incarnationId ||
    input.successor.evidenceStreamId === input.predecessor.evidenceStreamId
  )
    return { kind: 'LeaseConflict' };
  const observedAt = Date.parse(input.serverTime);
  const expiresAt = Date.parse(run.lease.expiresAt);
  if (
    !Number.isFinite(observedAt) ||
    !Number.isFinite(expiresAt) ||
    new Date(observedAt).toISOString() !== input.serverTime
  )
    return { kind: 'TimeInvalid' };
  if (expiresAt > observedAt) return { kind: 'LeaseStillHeld' };
  if (
    'activation' in input &&
    (!Number.isSafeInteger(input.activation.pointerVersion) ||
      input.activation.pointerVersion < 2 ||
      input.activation.activeRevisionSaid !== input.successor.harnessRevisionSaid ||
      input.successor.harnessRevisionSaid === run.binding.initialHarnessRevisionSaid ||
      input.activation.decisionReceiptSaid.length === 0)
  )
    return { kind: 'ActivationConflict' };
  if (input.effects !== 'Settled') return { kind: 'UnresolvedEffects' };
  if (
    taskBudgetNames.some((name) => run.consumedBudget[name] > run.binding.budget[name]) ||
    run.consumedBudget.runWallTimeSeconds >= run.binding.budget.runWallTimeSeconds ||
    run.consumedBudget.providerRequests >= run.binding.budget.providerRequests ||
    run.consumedBudget.toolProposals >= run.binding.budget.toolProposals
  )
    return { kind: 'BudgetExhausted' };
  return {
    kind: 'Admitted',
    run: {
      ...run,
      version: run.version + 1,
      lifecycle: { kind: 'Active', phase: { kind: 'Preparing' } },
      lease: {
        kind: 'Held',
        incarnationId: input.successor.incarnationId,
        acquiredAt: input.serverTime,
        expiresAt: new Date(observedAt + runLeasePolicy.leaseSeconds * 1_000).toISOString(),
        segmentSaid: input.successor.segmentSaid,
        lastChange: {
          kind: 'Replaced',
          fromRunVersion: run.version,
          segmentSaid: input.successor.segmentSaid,
        },
      },
      currentExecution: {
        segmentSaid: input.successor.segmentSaid,
        harnessRevisionSaid: input.successor.harnessRevisionSaid,
        evidenceStreamId: input.successor.evidenceStreamId,
      },
    },
  };
}

/** Recover receipt delivery for an admission that never began execution; not lease renewal. */
export function recoverUnstartedRunContinuation(
  run: Run,
  input: {
    readonly segmentSaid: string;
    readonly incarnationId: string;
    readonly evidenceStreamId: string;
    readonly expectedRunVersion: number;
    readonly consumedBudget: Run['consumedBudget'];
    readonly serverTime: string;
    readonly execution: 'NeverStarted' | 'Uncertain';
  },
):
  { readonly kind: 'Recovered' | 'Equivalent'; readonly run: Run } | { readonly kind: 'Rejected' } {
  const now = Date.parse(input.serverTime);
  if (
    input.execution !== 'NeverStarted' ||
    !Number.isFinite(now) ||
    new Date(now).toISOString() !== input.serverTime ||
    run.lifecycle.kind !== 'Active' ||
    run.lifecycle.phase.kind !== 'Preparing' ||
    run.currentExecution?.segmentSaid !== input.segmentSaid ||
    run.currentExecution.evidenceStreamId !== input.evidenceStreamId ||
    run.lease.kind !== 'Held' ||
    run.lease.segmentSaid !== input.segmentSaid ||
    run.lease.incarnationId !== input.incarnationId ||
    taskBudgetNames.some((name) => run.consumedBudget[name] !== input.consumedBudget[name])
  )
    return { kind: 'Rejected' };
  if (run.version === input.expectedRunVersion && Date.parse(run.lease.expiresAt) > now)
    return { kind: 'Equivalent', run };
  if (
    run.lease.lastChange.kind === 'Renewed' &&
    run.lease.lastChange.fromRunVersion === input.expectedRunVersion &&
    Date.parse(run.lease.expiresAt) > now
  )
    return { kind: 'Equivalent', run };
  if (
    run.version !== input.expectedRunVersion ||
    Date.parse(run.lease.expiresAt) > now ||
    !Number.isFinite(Date.parse(run.lease.expiresAt))
  )
    return { kind: 'Rejected' };
  return {
    kind: 'Recovered',
    run: {
      ...run,
      version: run.version + 1,
      lease: {
        ...run.lease,
        expiresAt: new Date(now + runLeasePolicy.leaseSeconds * 1000).toISOString(),
        lastChange: { kind: 'Renewed', fromRunVersion: run.version },
      },
    },
  };
}
