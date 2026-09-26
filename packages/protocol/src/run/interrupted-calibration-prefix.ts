import { isDeepStrictEqual } from 'node:util';
import { startRunExecution, type Run } from '@devrandom/domain';
import { decodeEvidenceEvent, type EvidenceEvent } from '../evidence/evidence-event.js';
import { decodeRunSuccessorSegment, type RunSuccessorSegment } from './successor-segment.js';

/** A complete startup-only prefix proves no provider or tool authorization was recorded. */
export function verifyInterruptedCalibrationPrefix(input: {
  readonly run: Run;
  readonly segment: RunSuccessorSegment;
  readonly events: readonly EvidenceEvent[];
}):
  | { readonly kind: 'Verified'; readonly run: Run; readonly runStartedSaid: string }
  | { readonly kind: 'Rejected' } {
  const { run, segment, events } = input;
  if (
    run.binding.purpose.kind !== 'PreparedCompatibilityCalibration' ||
    run.lease.kind !== 'Held' ||
    run.lifecycle.kind !== 'Active' ||
    run.lifecycle.phase.kind !== 'Preparing' ||
    run.submissionVerification.kind !== 'NotSubmitted' ||
    decodeRunSuccessorSegment(segment).kind !== 'Accepted' ||
    segment.version !== 2 ||
    run.currentExecution?.segmentSaid !== segment.d ||
    run.lease.segmentSaid !== segment.d ||
    segment.runId !== run.binding.runId ||
    segment.ownerAid !== run.binding.ownerAid ||
    segment.taskId !== run.binding.taskId ||
    segment.taskRevisionSaid !== run.binding.taskRevisionSaid ||
    segment.personalAgentAid !== run.binding.personalAgentAid ||
    segment.taskMandateSaid !== run.binding.taskMandateSaid ||
    segment.successor.incarnationId !== run.lease.incarnationId ||
    segment.successor.evidenceStreamId !== run.currentExecution.evidenceStreamId ||
    segment.successor.harnessRevisionSaid !== run.binding.initialHarnessRevisionSaid ||
    !isDeepStrictEqual(segment.consumedBudget, run.consumedBudget) ||
    events.length !== 4
  )
    return { kind: 'Rejected' };
  for (const [index, event] of events.entries()) {
    const previous = events[index - 1];
    if (
      decodeEvidenceEvent(event).kind !== 'Accepted' ||
      event.sequence !== index ||
      event.runId !== run.binding.runId ||
      event.taskId !== run.binding.taskId ||
      event.taskRevisionSaid !== run.binding.taskRevisionSaid ||
      event.incarnationId !== run.lease.incarnationId ||
      event.harnessRevisionSaid !== run.binding.initialHarnessRevisionSaid ||
      event.personalAgentAid !== run.binding.personalAgentAid ||
      event.taskMandateSaid !== run.binding.taskMandateSaid ||
      (previous === undefined
        ? event.predecessor.kind !== 'Genesis'
        : event.predecessor.kind !== 'Previous' || event.predecessor.eventSaid !== previous.d) ||
      Date.parse(event.recordedAt) < Date.parse(run.lease.acquiredAt) ||
      Date.parse(event.recordedAt) >= Date.parse(run.lease.expiresAt) ||
      event.producer.kind !== 'RunSupervisor'
    )
      return { kind: 'Rejected' };
  }
  const start = events[0],
    incarnation = events[1],
    profile = events[2],
    debit = events[3];
  if (
    start?.event.kind !== 'RunStarted' ||
    start.event.fromRunVersion !== run.version ||
    incarnation?.event.kind !== 'IncarnationStarted' ||
    profile?.event.kind !== 'RunExecutionProfileBound' ||
    (debit !== undefined &&
      (debit.event.kind !== 'BudgetDebited' ||
        debit.event.budget !== 'runWallTimeSeconds' ||
        debit.event.amount <= 0 ||
        debit.event.consumed !== segment.consumedBudget.runWallTimeSeconds + debit.event.amount))
  )
    return { kind: 'Rejected' };
  const started = startRunExecution(run, {
    incarnationId: run.lease.incarnationId,
    leaseObservedAt: start.occurredAt,
    worktree: { repository: run.binding.repository },
    evidence: { kind: 'Genesis', streamId: segment.successor.evidenceStreamId },
  });
  if (started.kind !== 'Started') return { kind: 'Rejected' };
  return {
    kind: 'Verified',
    run: {
      ...started.run,
      consumedBudget: {
        ...started.run.consumedBudget,
        runWallTimeSeconds:
          debit?.event.kind === 'BudgetDebited'
            ? debit.event.consumed
            : started.run.consumedBudget.runWallTimeSeconds,
      },
    },
    runStartedSaid: start.d,
  };
}
