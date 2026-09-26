import {
  encodeHarnessDocument,
  type HarnessDocument,
} from '../../harness/infrastructure/harness-document.js';
import { harnessRevisionsCollectionName } from '../../harness/infrastructure/mongo-harness-revisions.js';
import { MongoActivationCommits } from '../../activation/infrastructure/mongo-activation-commits.js';
import { MongoRunSuccessorSegments } from './mongo-run-successor-segments.js';
import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  authorizedTaskCommandFingerprint,
  harnessCommandFingerprint,
  type TaskProjection,
} from '@devrandom/protocol';
import {
  baselineHarnessCommandFixture,
  harnessTask,
} from '../../harness/test/harness-command-fixture.js';
import { taskCommandFixture } from '../../task/test/task-command-fixture.js';
import { encodeTaskDocument, type TaskDocument } from '../../task/infrastructure/task-document.js';
import { tasksCollectionName } from '../../task/infrastructure/mongo-tasks.js';
import {
  encodeEvidenceStreamDocument,
  type EvidenceStreamDocument,
} from '../../evidence/infrastructure/evidence-stream-document.js';
import {
  encodeEvidenceEventDocument,
  type EvidenceEventDocument,
} from '../../evidence/infrastructure/evidence-event-document.js';
import {
  encodeEvidenceCheckpointDocument,
  type EvidenceCheckpointDocument,
} from '../../evidence/infrastructure/evidence-checkpoint-document.js';
import { evidenceCollectionNames } from '../../evidence/infrastructure/evidence-storage-contract.js';
import { runFixture, runCommandFingerprint } from '../test/run-fixture.js';
import { sealedRunPredecessorFixture } from '../test/sealed-run-predecessor-fixture.js';
import { encodeRunDocument, type RunDocument } from './run-document.js';
import { runsCollectionName } from './mongo-runs.js';
import {
  MongoRunContinuations,
  runSuccessorSegmentsCollectionName,
} from './mongo-run-continuations.js';
import { MongoRunContinuationBootstrap } from './mongo-run-continuation-bootstrap.js';

const uri = process.env.DEVRANDOM_MONGODB_URI;
const integration = uri === undefined ? describe.skip : describe;
integration('same calibration Run Mongo continuation', () => {
  const client = new MongoClient(uri ?? 'mongodb://127.0.0.1:27017');
  const db = client.db(`devrandom_calibration_${randomUUID().replaceAll('-', '')}`);
  beforeAll(async () => {
    await client.connect();
    await new MongoRunContinuationBootstrap(db).bootstrap();
  });
  afterAll(async () => {
    await db.dropDatabase();
    await client.close();
  });
  it('fences the old lease and retains one purpose slot and all predecessor proof on exact retry', async () => {
    const now = Date.now();
    const taskCommand = taskCommandFixture(new Date(now + 3_600_000).toISOString());
    const task: TaskProjection = {
      ...harnessTask,
      createdAt: new Date(now - 120_000).toISOString(),
      revision: taskCommand.revision,
      revisionSaid: taskCommand.revision.d,
    };
    const harness = baselineHarnessCommandFixture(randomUUID(), 'claude-sonnet-4-5', task);
    const base = runFixture();
    const prior = sealedRunPredecessorFixture([], 'ContextLimitReached', {
      run: {
        ...base,
        binding: {
          ...base.binding,
          taskRevisionSaid: task.revisionSaid,
          initialHarnessRevisionSaid: harness.revision.d,
          initialSpecialization: {
            ...base.binding.initialSpecialization,
            harnessRevisionSaid: harness.revision.d,
          },
          repository: task.revision.repository,
          budget: task.revision.budgets,
        },
      },
      leaseAt: new Date(now - 60_000).toISOString(),
      at: new Date(now - 59_000).toISOString(),
      completionConditionIds: task.revision.completionConditions.map((condition) => condition.id),
    });
    const { run, stream, events, checkpoint } = prior;
    await db.collection<TaskDocument>(tasksCollectionName).insertOne(
      encodeTaskDocument(task, authorizedTaskCommandFingerprint(taskCommand), {
        ownerSlot: 0,
        globalSlot: 0,
      }),
    );
    await db
      .collection<RunDocument>(runsCollectionName)
      .insertOne(encodeRunDocument(run, runCommandFingerprint));
    await db
      .collection<EvidenceStreamDocument>(evidenceCollectionNames.streams)
      .insertOne(encodeEvidenceStreamDocument(stream));
    await db.collection<EvidenceEventDocument>(evidenceCollectionNames.events).insertMany(
      events.map((event) =>
        encodeEvidenceEventDocument({
          ownerAid: run.binding.ownerAid,
          evidenceStreamId: stream.binding.streamId,
          batchSaid: `E${'b'.repeat(43)}`,
          event,
          receivedAt: new Date(now - 58_000).toISOString(),
        }),
      ),
    );
    await db.collection<EvidenceCheckpointDocument>(evidenceCollectionNames.checkpoints).insertOne(
      encodeEvidenceCheckpointDocument(
        {
          ownerAid: run.binding.ownerAid,
          evidenceStreamId: stream.binding.streamId,
          batchSaid: `E${'b'.repeat(43)}`,
          checkpoint,
          receivedAt: new Date(now - 58_000).toISOString(),
        },
        task.revision.completionConditions.map((item) => item.id),
      ),
    );
    const activation = {
      version: 1 as const,
      kind: 'Initial' as const,
      pointerVersion: 1 as const,
      taskId: run.binding.taskId,
      taskRevisionSaid: run.binding.taskRevisionSaid,
      harnessLineageId: run.binding.harnessLineageId,
      activeRevisionSaid: run.binding.initialHarnessRevisionSaid,
    };
    const harnessDocument = encodeHarnessDocument(
      {
        version: 1,
        ownerAid: run.binding.ownerAid,
        commandId: harness.commandId,
        acceptedAt: run.binding.acceptedAt,
        revision: harness.revision,
      },
      harnessCommandFingerprint(harness),
    );
    await db
      .collection<HarnessDocument>(harnessRevisionsCollectionName)
      .insertOne({
        ...harnessDocument,
        activation: {
          ...run.binding.initialSpecialization,
          acceptedAt: new Date(run.binding.initialSpecialization.acceptedAt),
        },
      });
    expect(
      await new MongoActivationCommits(client, db).inspectCurrent({
        ownerAid: run.binding.ownerAid,
        taskId: run.binding.taskId,
      }),
    ).toEqual({ kind: 'Initial', pointer: activation });
    expect(await db.collection('activationPointers').countDocuments()).toBe(0);
    const command = {
      version: 2 as const,
      kind: 'CalibrationContinuation' as const,
      expectedRunVersion: run.version,
      predecessorCheckpointSaid: checkpoint.d,
      predecessorSealSaid: prior.sealExchangeSaid,
      predecessorHeadSaid: prior.chainHeadSaid,
      successorIncarnationId: randomUUID(),
      successorStreamId: randomUUID(),
      expectedHarnessRevisionSaid: run.binding.initialHarnessRevisionSaid,
    };
    const writer = new MongoRunContinuations(client, db);
    const input = {
      ownerAid: run.binding.ownerAid,
      run,
      command,
      activation,
      observedAt: new Date(now).toISOString(),
    };
    expect(
      await writer.admit({
        ...input,
        command: { ...command, expectedHarnessRevisionSaid: `E${'x'.repeat(43)}` },
      }),
    ).toEqual({ kind: 'Rejected' });
    const pointer = {
      _id: run.binding.taskId,
      ownerAid: run.binding.ownerAid,
      taskRevisionSaid: run.binding.taskRevisionSaid,
      harnessLineageId: run.binding.harnessLineageId,
      activeRevisionSaid: run.binding.initialHarnessRevisionSaid,
      version: 1,
    };
    const pointers = db.collection<{
      _id: string;
      ownerAid: string;
      taskRevisionSaid: string;
      harnessLineageId: string;
      activeRevisionSaid: string;
      version: number;
      pendingCommandId?: string;
    }>('activationPointers');
    for (const drift of [
      { version: 2 },
      { activeRevisionSaid: `E${'z'.repeat(43)}` },
      { taskRevisionSaid: `E${'z'.repeat(43)}` },
      { harnessLineageId: randomUUID() },
      { pendingCommandId: randomUUID() },
    ]) {
      await pointers.insertOne({ ...pointer, ...drift });
      expect(await writer.admit(input)).toEqual({ kind: 'Rejected' });
      await pointers.deleteMany({});
    }
    const transitions = db.collection('activationTransitions');
    await transitions.insertOne({ ownerAid: run.binding.ownerAid, taskId: run.binding.taskId });
    expect(await writer.admit(input)).toEqual({ kind: 'Rejected' });
    await transitions.deleteMany({});
    const harnesses = db.collection<HarnessDocument>(harnessRevisionsCollectionName);
    await harnesses.updateOne(
      { _id: harness.revision.d },
      { $set: { 'activation.kind': 'AwaitingRunAdmission' } },
    );
    expect(await writer.admit(input)).toEqual({ kind: 'Rejected' });
    await harnesses.updateOne(
      { _id: harness.revision.d },
      { $set: { 'activation.kind': 'InitialSpecializationAccepted' } },
    );
    await harnesses.insertOne({
      ...harnessDocument,
      _id: `E${'z'.repeat(43)}`,
      activation: {
        ...run.binding.initialSpecialization,
        acceptedAt: new Date(run.binding.initialSpecialization.acceptedAt),
      },
    });
    expect(await writer.admit(input)).toEqual({ kind: 'Rejected' });
    await harnesses.deleteOne({ _id: `E${'z'.repeat(43)}` });
    const admitted = await writer.admit(input);
    expect(admitted.kind).toBe('Admitted');
    if (admitted.kind !== 'Admitted') throw new Error('continuation failed');
    const history = new MongoRunSuccessorSegments(db);
    expect(
      await history.read({
        ownerAid: run.binding.ownerAid,
        runId: run.binding.runId,
        segmentSaid: admitted.segment.d,
      }),
    ).toEqual({ kind: 'Found', segment: admitted.segment });
    expect(
      await history.read({
        ownerAid: `E${'z'.repeat(43)}`,
        runId: run.binding.runId,
        segmentSaid: admitted.segment.d,
      }),
    ).toEqual({ kind: 'NotFound' });
    expect(await db.collection('activationPointers').countDocuments()).toBe(0);
    expect(admitted.run.binding).toEqual(run.binding);
    expect(admitted.run.consumedBudget).toEqual(run.consumedBudget);
    expect(admitted.segment).toMatchObject({
      version: 2,
      baseline: { pointerVersion: 1, harnessRevisionSaid: run.binding.initialHarnessRevisionSaid },
    });
    expect(await writer.admit(input)).toMatchObject({
      kind: 'Equivalent',
      segment: admitted.segment,
    });
    expect(
      await writer.admit({
        ...input,
        command: {
          ...command,
          successorIncarnationId: randomUUID(),
          successorStreamId: randomUUID(),
        },
      }),
    ).toEqual({ kind: 'Rejected' });
    expect(await db.collection<RunDocument>(runsCollectionName).countDocuments()).toBe(1);
    expect(await db.collection(runSuccessorSegmentsCollectionName).countDocuments()).toBe(1);
    expect(
      await db.collection<EvidenceStreamDocument>(evidenceCollectionNames.streams).countDocuments(),
    ).toBe(2);
    expect(
      await db.collection<EvidenceEventDocument>(evidenceCollectionNames.events).countDocuments(),
    ).toBe(events.length);
  });
});
