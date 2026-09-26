import { randomUUID } from 'node:crypto';
import { continueCalibrationRun, createEvidenceStream, taskBudgetNames } from '@devrandom/domain';
import {
  prepareRunSuccessorSegment,
  prepareEvidenceArtifact,
  prepareEvidenceEvent,
  prepareEvidenceBatch,
  prepareVerifiedCheckpoint,
  type EvidenceEvent,
  type EvidenceEventDetail,
  type TaskProjection,
} from '@devrandom/protocol';
import { sealedRunPredecessorFixture } from '../../run/test/sealed-run-predecessor-fixture.js';
import { runFixture } from '../../run/test/run-fixture.js';
import { taskCommandFixture } from '../../task/test/task-command-fixture.js';
import {
  baselineHarnessCommandFixture,
  harnessTask,
} from '../../harness/test/harness-command-fixture.js';

export function runtimeRecoveryFixture(wallTimeCeiling?: number) {
  const epoch = Date.now() - 180_000;
  const at = (milliseconds: number) => new Date(epoch + milliseconds).toISOString();
  const taskCommand = taskCommandFixture(new Date(Date.now() + 3_600_000).toISOString());
  const task: TaskProjection = {
    ...harnessTask,
    createdAt: at(0),
    revision: taskCommand.revision,
    revisionSaid: taskCommand.revision.d,
  };
  const harness = baselineHarnessCommandFixture(randomUUID(), 'claude-sonnet-4-5', task);
  const profileBytes = new TextEncoder().encode('retained public execution profile fixture');
  const profile = prepareEvidenceArtifact(profileBytes, 'text/plain; charset=utf-8');
  if (profile.kind !== 'Prepared') throw new Error('profile artifact fixture');
  const base = runFixture();
  const prior = sealedRunPredecessorFixture([], 'ContextLimitReached', {
    run: {
      ...base,
      binding: {
        ...base.binding,
        budget: {
          ...base.binding.budget,
          runWallTimeSeconds: wallTimeCeiling ?? base.binding.budget.runWallTimeSeconds,
        },
        taskRevisionSaid: task.revisionSaid,
        initialHarnessRevisionSaid: harness.revision.d,
        initialSpecialization: {
          ...base.binding.initialSpecialization,
          harnessRevisionSaid: harness.revision.d,
        },
        repository: task.revision.repository,
      },
    },
    completionConditionIds: task.revision.completionConditions.map((condition) => condition.id),
    outputArtifactSaids: [profile.artifact.d],
    leaseAt: at(0),
    at: at(1000),
  });
  const predecessorRun = {
    ...prior.run,
    consumedBudget: { ...prior.run.consumedBudget, runWallTimeSeconds: 265 },
  };
  const predecessor = {
    incarnationId: prior.stream.binding.incarnationId,
    evidenceStreamId: prior.stream.binding.streamId,
    checkpointSaid: prior.checkpoint.d,
    sealExchangeSaid: prior.sealExchangeSaid,
    finalSequence: prior.stream.cursor.acceptedThrough,
    chainHeadSaid: prior.stream.cursor.chainHeadSaid,
  };
  const successor = {
    incarnationId: randomUUID(),
    evidenceStreamId: randomUUID(),
    harnessRevisionSaid: harness.revision.d,
  };
  const baseline = { pointerVersion: 1 as const, harnessRevisionSaid: harness.revision.d };
  const prepared = prepareRunSuccessorSegment({
    version: 2,
    kind: 'CalibrationContinuationSegment',
    baseline,
    runId: base.binding.runId,
    taskId: base.binding.taskId,
    taskRevisionSaid: task.revisionSaid,
    ownerAid: base.binding.ownerAid,
    personalAgentAid: base.binding.personalAgentAid,
    taskMandateSaid: base.binding.taskMandateSaid,
    fromRunVersion: predecessorRun.version,
    predecessor,
    successor,
    consumedBudget: predecessorRun.consumedBudget,
    admittedAt: at(60000),
  });
  if (prepared.kind !== 'Prepared') throw new Error('segment fixture');
  const segment = prepared.segment;
  const continued = continueCalibrationRun(predecessorRun, {
    expectedRunVersion: predecessorRun.version,
    serverTime: segment.admittedAt,
    predecessor,
    successor: { ...successor, segmentSaid: segment.d },
    baseline,
    effects: 'Settled',
  });
  if (continued.kind !== 'Admitted') throw new Error('continued fixture');
  const run = continued.run;
  const events: EvidenceEvent[] = [];
  function append(detail: EvidenceEventDetail, producer: EvidenceEvent['producer'], at: string) {
    const last = events.at(-1);
    const item = prepareEvidenceEvent({
      version: 1,
      sequence: events.length,
      predecessor:
        last === undefined ? { kind: 'Genesis' } : { kind: 'Previous', eventSaid: last.d },
      taskId: run.binding.taskId,
      taskRevisionSaid: run.binding.taskRevisionSaid,
      runId: run.binding.runId,
      incarnationId: successor.incarnationId,
      harnessRevisionSaid: harness.revision.d,
      personalAgentAid: run.binding.personalAgentAid,
      taskMandateSaid: run.binding.taskMandateSaid,
      occurredAt: at,
      recordedAt: at,
      producer,
      event: detail,
    });
    if (item.kind !== 'Prepared') throw new Error('event fixture');
    events.push(item.event);
    return item.event;
  }
  const started = append(
    { kind: 'RunStarted', fromRunVersion: run.version },
    { kind: 'RunSupervisor' },
    at(61000),
  );
  append({ kind: 'IncarnationStarted' }, { kind: 'RunSupervisor' }, at(62000));
  append(
    {
      kind: 'RunExecutionProfileBound',
      executionProfileSaid: `E${'p'.repeat(43)}`,
      profileArtifactSaid: profile.artifact.d,
      worktreeBranch: `devrandom/run/${run.binding.runId}`,
    },
    { kind: 'RunSupervisor' },
    at(63000),
  );
  const head = append(
    { kind: 'BudgetDebited', budget: 'runWallTimeSeconds', amount: 9, consumed: 274 },
    { kind: 'RunSupervisor' },
    at(70000),
  );
  const acceptedEvents = [...events];
  const created = createEvidenceStream({
    ...prior.stream.binding,
    streamId: successor.evidenceStreamId,
    incarnationId: successor.incarnationId,
    harnessRevisionSaid: harness.revision.d,
  });
  if (created.kind !== 'Created') throw new Error('stream fixture');
  const stream = {
    ...created.stream,
    version: 1,
    cursor: { kind: 'Continued' as const, acceptedThrough: 3, chainHeadSaid: head.d },
    acceptedEvidenceBytes: Buffer.byteLength(JSON.stringify(events)),
  };
  const consumed = { ...run.consumedBudget, runWallTimeSeconds: 274 };
  const remaining = { ...run.binding.budget };
  for (const name of taskBudgetNames)
    remaining[name] = Math.max(0, remaining[name] - consumed[name]);
  const completionConditionIds = task.revision.completionConditions.map((c) => c.id);
  const checkpoint = prepareVerifiedCheckpoint(
    {
      version: 1,
      taskId: run.binding.taskId,
      taskRevisionSaid: run.binding.taskRevisionSaid,
      runId: run.binding.runId,
      incarnationId: successor.incarnationId,
      harnessRevisionSaid: harness.revision.d,
      harnessLineageId: run.binding.harnessLineageId,
      personalAgentAid: run.binding.personalAgentAid,
      governorAid: run.binding.governorAid,
      taskMandateSaid: run.binding.taskMandateSaid,
      promotionMandateSaid: run.binding.promotionMandateSaid,
      purpose: run.binding.purpose,
      repository: {
        objectFormat: run.binding.repository.objectFormat,
        baseCommit: run.binding.repository.commit,
        baseTree: run.binding.repository.tree,
        changedFiles: [],
      },
      outputArtifactSaids: [profile.artifact.d],
      verifierReceipts: prior.checkpoint.verifierReceipts,
      evidence: { eventCount: 4, finalSequence: 3, chainHeadSaid: head.d },
      budget: { consumed, remaining },
      runState: {
        kind: 'Active',
        phase: { kind: 'Blocked', reason: 'ProcessLost' },
        verification: { kind: 'NotSubmitted' },
      },
      continuation: { kind: 'LaterRuntimeRecoveryRequired' },
    },
    completionConditionIds,
  );
  if (checkpoint.kind !== 'Prepared') throw new Error(`checkpoint fixture ${checkpoint.reason}`);
  append(
    { kind: 'CheckpointVerified', checkpointSaid: checkpoint.checkpoint.d },
    { kind: 'EvidenceRecorder' },
    at(120000),
  );
  append(
    { kind: 'RunBlocked', reason: 'ProcessLost', checkpointSaid: checkpoint.checkpoint.d },
    { kind: 'RunSupervisor' },
    at(120001),
  );
  const tail = events.slice(4);
  const batch = prepareEvidenceBatch({
    version: 1,
    runId: run.binding.runId,
    evidenceStreamId: successor.evidenceStreamId,
    events: tail,
  });
  if (batch.kind !== 'Prepared') throw new Error('batch fixture');
  return {
    run,
    originalStream: prior.stream,
    predecessorCheckpoint: prior.checkpoint,
    profile: profile.artifact,
    profileBytes,
    stream,
    segment,
    acceptedEvents,
    completionConditionIds,
    expected: {
      incarnationId: successor.incarnationId,
      runStartedSaid: started.d,
      acceptedThroughSequence: 3,
      chainHeadSaid: head.d,
    },
    body: {
      version: 1 as const,
      batch: batch.batch,
      events: tail,
      checkpoint: checkpoint.checkpoint,
    },
    receivedAt: at(121000),
    task,
    taskCommand,
    harness,
  };
}
