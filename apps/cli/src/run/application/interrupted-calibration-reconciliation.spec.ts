import { expect, it } from 'vitest';
import {
  acquireFirstRunLease,
  createRun,
  startRunExecution,
  continueCalibrationRun,
  taskBudgetCeilings,
  type Run,
} from '@devrandom/domain';
import {
  prepareEvidenceEvent,
  prepareRunSuccessorSegment,
  verifyInterruptedCalibrationPrefix,
  type EvidenceEvent,
  type EvidenceEventDetail,
} from '@devrandom/protocol';
import { baselineHarnessCommandFixture } from '../../../test/baseline-harness-fixture.js';
import { taskProjectionFixture } from '../../../test/task-source-fixture.js';
const said = (c: string) => `E${c.repeat(43)}`;
const campaignId = '57ed9f1a-b444-44b2-95c9-fd780c90a7dd';
function calibrationRun(): Run {
  const task = taskProjectionFixture();
  const harness = baselineHarnessCommandFixture().revision;
  const runId = '1cc482f1-98e9-4454-8e4c-5566cb47ce3d';
  const acceptedAt = '2026-09-24T20:00:00.000Z';
  const created = createRun({
    runId,
    ownerAid: task.ownerAid,
    taskId: task.taskId,
    taskRevisionSaid: task.revisionSaid,
    harnessLineageId: task.harnessLineageId,
    personalAgentAid: harness.authority.personalAgentAid,
    taskMandateSaid: harness.authority.taskMandateSaid,
    governorAid: said('g'),
    promotionMandateSaid: said('p'),
    initialHarnessRevisionSaid: harness.d,
    purpose: { kind: 'PreparedCompatibilityCalibration', campaignId, ordinal: 1 },
    initialSpecialization: {
      kind: 'InitialSpecializationAccepted',
      harnessLineageId: task.harnessLineageId,
      harnessRevisionSaid: harness.d,
      runId,
      acceptedAt,
    },
    repository: task.revision.repository,
    commandId: 'd2c9160a-58f8-4d43-ae67-22124c6e9112',
    admissionExchangeSaid: said('a'),
    evidenceStreamId: 'a1975db1-6130-41c2-b9dd-c8ec8bc12c94',
    budget: taskBudgetCeilings,
    acceptedAt,
  });
  if (created.kind !== 'Created') throw new Error('calibration Run fixture must create');
  const leased = acquireFirstRunLease(created.run, {
    incarnationId: 'ee87e11d-fb5f-46b4-841f-8a7a5faad97c',
    expectedRunVersion: 0,
    serverTime: '2026-09-24T20:00:01.000Z',
  });
  if (leased.kind !== 'Acquired' || leased.run.lease.kind !== 'Held') {
    throw new Error('calibration Run fixture must acquire its lease');
  }
  const started = startRunExecution(leased.run, {
    incarnationId: leased.run.lease.incarnationId,
    leaseObservedAt: '2026-09-24T20:00:02.000Z',
    worktree: { repository: leased.run.binding.repository },
    evidence: { kind: 'Genesis', streamId: leased.run.binding.evidenceStreamId },
  });
  if (started.kind !== 'Started') throw new Error('calibration Run fixture must start');
  return leased.run;
}

function fixture() {
  const initial = calibrationRun();
  if (initial.lease.kind !== 'Held') throw Error('fixture');
  const prior: Run = {
    ...initial,
    version: 19,
    lifecycle: {
      kind: 'Active',
      phase: { kind: 'Blocked', reason: 'ContextLimitReached', checkpointSaid: said('c') },
    },
    consumedBudget: { ...initial.consumedBudget, runWallTimeSeconds: 265, providerRequests: 7 },
  };
  const prepared = prepareRunSuccessorSegment({
    version: 2,
    kind: 'CalibrationContinuationSegment',
    runId: prior.binding.runId,
    taskId: prior.binding.taskId,
    taskRevisionSaid: prior.binding.taskRevisionSaid,
    ownerAid: prior.binding.ownerAid,
    personalAgentAid: prior.binding.personalAgentAid,
    taskMandateSaid: prior.binding.taskMandateSaid,
    fromRunVersion: 19,
    predecessor: {
      incarnationId: initial.lease.incarnationId,
      evidenceStreamId: prior.binding.evidenceStreamId,
      checkpointSaid: said('c'),
      sealExchangeSaid: said('s'),
      finalSequence: 73,
      chainHeadSaid: said('h'),
    },
    successor: {
      incarnationId: '10000000-0000-4000-8000-000000000001',
      evidenceStreamId: '10000000-0000-4000-8000-000000000002',
      harnessRevisionSaid: prior.binding.initialHarnessRevisionSaid,
    },
    baseline: { pointerVersion: 1, harnessRevisionSaid: prior.binding.initialHarnessRevisionSaid },
    consumedBudget: prior.consumedBudget,
    admittedAt: '2026-09-24T20:02:00.000Z',
  });
  if (prepared.kind !== 'Prepared') throw Error('segment');
  const segment = prepared.segment;
  const continued = continueCalibrationRun(prior, {
    expectedRunVersion: 19,
    serverTime: segment.admittedAt,
    predecessor: segment.predecessor,
    successor: { ...segment.successor, segmentSaid: segment.d },
    baseline:
      segment.version === 2
        ? segment.baseline
        : { pointerVersion: 1, harnessRevisionSaid: prior.binding.initialHarnessRevisionSaid },
    effects: 'Settled',
  });
  if (continued.kind !== 'Admitted' || continued.run.lease.kind !== 'Held')
    throw Error('continuation');
  const run = continued.run;
  const events: EvidenceEvent[] = [];
  const append = (event: EvidenceEventDetail) => {
    const previous = events.at(-1);
    const prepared = prepareEvidenceEvent({
      version: 1,
      sequence: events.length,
      predecessor:
        previous === undefined ? { kind: 'Genesis' } : { kind: 'Previous', eventSaid: previous.d },
      taskId: run.binding.taskId,
      taskRevisionSaid: run.binding.taskRevisionSaid,
      runId: run.binding.runId,
      incarnationId: segment.successor.incarnationId,
      harnessRevisionSaid: run.binding.initialHarnessRevisionSaid,
      personalAgentAid: run.binding.personalAgentAid,
      taskMandateSaid: run.binding.taskMandateSaid,
      occurredAt: '2026-09-24T20:02:02.000Z',
      recordedAt: '2026-09-24T20:02:02.000Z',
      producer: { kind: 'RunSupervisor' },
      event,
    });
    if (prepared.kind !== 'Prepared') throw Error('event');
    events.push(prepared.event);
  };
  append({ kind: 'RunStarted', fromRunVersion: run.version });
  append({ kind: 'IncarnationStarted' });
  append({
    kind: 'RunExecutionProfileBound',
    executionProfileSaid: said('p'),
    profileArtifactSaid: said('a'),
    worktreeBranch: `devrandom/run/${run.binding.runId}`,
  });
  append({ kind: 'BudgetDebited', budget: 'runWallTimeSeconds', amount: 9, consumed: 274 });
  return { run, segment, events };
}
it('reconstructs startup without resetting inherited model or wall consumption', () => {
  const input = fixture();
  const verified = verifyInterruptedCalibrationPrefix(input);
  expect(verified).toMatchObject({
    kind: 'Verified',
    run: {
      lifecycle: { kind: 'Active', phase: { kind: 'Running' } },
      consumedBudget: { runWallTimeSeconds: 274, providerRequests: 7 },
    },
  });
  for (const altered of [
    input.events.slice(0, 3),
    [...input.events, input.events[3]!],
    input.events.slice(1),
  ])
    expect(verifyInterruptedCalibrationPrefix({ ...input, events: altered })).toEqual({
      kind: 'Rejected',
    });
  expect(
    verifyInterruptedCalibrationPrefix({
      ...input,
      run: { ...input.run, consumedBudget: { ...input.run.consumedBudget, providerRequests: 0 } },
    }),
  ).toEqual({ kind: 'Rejected' });
});
