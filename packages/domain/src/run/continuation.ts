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

export type RunContinuation =
  | { readonly kind: 'Admitted' | 'Equivalent'; readonly run: Run }
  | { readonly kind: 'VersionConflict'; readonly currentVersion: number }
  | {
      readonly kind:
        | 'RunNotRetained'
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
  if (run.binding.purpose.kind !== 'Retained') return { kind: 'RunNotRetained' };
  if (
    run.lifecycle.kind !== 'Active' ||
    run.lifecycle.phase.kind !== 'Blocked' ||
    (run.lifecycle.phase.reason !== 'CheckpointPause' &&
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
    !Number.isSafeInteger(input.activation.pointerVersion) ||
    input.activation.pointerVersion < 2 ||
    input.activation.activeRevisionSaid !== input.successor.harnessRevisionSaid ||
    input.successor.harnessRevisionSaid === run.binding.initialHarnessRevisionSaid ||
    input.activation.decisionReceiptSaid.length === 0
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
