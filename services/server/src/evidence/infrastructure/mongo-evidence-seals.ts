import { type ClientSession, type Collection, type Db, type MongoClient } from 'mongodb';

import {
  applySealedRunCheckpoint,
  sealEvidenceStream,
  settleTaskFromSealedRun,
  type EvidenceStream,
  type Task,
} from '@devrandom/domain';

import type {
  EvidenceSealCommitment,
  EvidenceSealCommitmentInput,
  EvidenceSeals,
} from '../application/evidence-seals.js';
import { runsCollectionName } from '../../run/infrastructure/mongo-runs.js';
import {
  decodeRunDocument,
  encodeRunDocument,
  type RunDocument,
} from '../../run/infrastructure/run-document.js';
import { projectTask } from '../../task/application/task-projection.js';
import { tasksCollectionName } from '../../task/infrastructure/mongo-tasks.js';
import {
  decodeTaskDocument,
  encodeTaskDocument,
  type TaskDocument,
} from '../../task/infrastructure/task-document.js';
import {
  decodeEvidenceCheckpointDocument,
  type EvidenceCheckpointDocument,
} from './evidence-checkpoint-document.js';
import {
  decodeEvidenceEventDocument,
  type EvidenceEventDocument,
} from './evidence-event-document.js';
import { evidenceCollectionNames } from './evidence-storage-contract.js';
import {
  decodeEvidenceStreamDocument,
  encodeEvidenceStreamDocument,
  type EvidenceStreamDocument,
} from './evidence-stream-document.js';

class EvidenceSealCommitmentAborted extends Error {
  readonly outcome: EvidenceSealCommitment;

  constructor(outcome: EvidenceSealCommitment) {
    super(outcome.kind);
    this.name = 'EvidenceSealCommitmentAborted';
    this.outcome = outcome;
  }
}

function taskFromDocument(document: TaskDocument): {
  readonly task: Task;
  readonly revision: ReturnType<typeof decodeTaskDocument>['task']['revision'];
  readonly commandFingerprint: string;
  readonly allocation: ReturnType<typeof decodeTaskDocument>['allocation'];
} {
  const decoded = decodeTaskDocument(document);
  const projection = decoded.task;
  return {
    task: {
      taskId: projection.taskId,
      ownerAid: projection.ownerAid,
      label: projection.label,
      harnessLineageId: projection.harnessLineageId,
      revision: { said: projection.revisionSaid },
      lifecycle: { ...projection.lifecycle },
      commandId: projection.commandId,
      createdAt: projection.createdAt,
      expectedVersion: projection.expectedVersion,
    },
    revision: projection.revision,
    commandFingerprint: decoded.commandFingerprint,
    allocation: decoded.allocation,
  };
}

export class MongoEvidenceSeals implements EvidenceSeals {
  readonly #client: MongoClient;
  readonly #runs: Collection<RunDocument>;
  readonly #tasks: Collection<TaskDocument>;
  readonly #streams: Collection<EvidenceStreamDocument>;
  readonly #events: Collection<EvidenceEventDocument>;
  readonly #checkpoints: Collection<EvidenceCheckpointDocument>;

  constructor(client: MongoClient, database: Db) {
    this.#client = client;
    this.#runs = database.collection<RunDocument>(runsCollectionName);
    this.#tasks = database.collection<TaskDocument>(tasksCollectionName);
    this.#streams = database.collection<EvidenceStreamDocument>(evidenceCollectionNames.streams);
    this.#events = database.collection<EvidenceEventDocument>(evidenceCollectionNames.events);
    this.#checkpoints = database.collection<EvidenceCheckpointDocument>(
      evidenceCollectionNames.checkpoints,
    );
  }

  async commit(input: EvidenceSealCommitmentInput): Promise<EvidenceSealCommitment> {
    try {
      return await this.#client.withSession((session) =>
        session.withTransaction(() => this.#settle(input, session), {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
        }),
      );
    } catch (error) {
      return error instanceof EvidenceSealCommitmentAborted
        ? error.outcome
        : { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' };
    }
  }

  async #settle(
    input: EvidenceSealCommitmentInput,
    session: ClientSession,
  ): Promise<EvidenceSealCommitment> {
    const runDocument = await this.#runs.findOne(
      { _id: input.runId, ownerAid: input.ownerAid },
      { session },
    );
    if (runDocument === null) {
      return { kind: 'EvidenceRunNotFound' };
    }
    const decodedRun = decodeRunDocument(runDocument);
    const currentRun = decodedRun.run;
    const streamDocument = await this.#streams.findOne(
      {
        _id: currentRun.currentExecution?.evidenceStreamId ?? currentRun.binding.evidenceStreamId,
        'binding.ownerAid': input.ownerAid,
      },
      { session },
    );
    if (streamDocument === null) {
      return { kind: 'EvidenceSealCursorIncomplete', acceptedEventCount: 0 };
    }
    const currentStream = decodeEvidenceStreamDocument(streamDocument);
    if (currentStream.version !== input.expectedStreamVersion) {
      return { kind: 'EvidenceCursorConcurrentUpdate' };
    }
    if (currentStream.cursor.kind === 'Genesis' || currentStream.provisional.kind === 'None') {
      return { kind: 'EvidenceSealCursorIncomplete', acceptedEventCount: 0 };
    }
    const taskDocument = await this.#tasks.findOne(
      { _id: currentRun.binding.taskId, ownerAid: input.ownerAid },
      { session },
    );
    if (taskDocument === null) {
      return { kind: 'EvidenceSealRejected', reason: 'CheckpointBindingMismatch' };
    }
    const currentTask = taskFromDocument(taskDocument);
    const completionConditionIds = currentTask.revision.completionConditions.map(
      (condition) => condition.id,
    );
    const checkpointDocument = await this.#checkpoints.findOne(
      { _id: currentStream.provisional.checkpointSaid, ownerAid: input.ownerAid },
      { session },
    );
    if (checkpointDocument === null) {
      return { kind: 'EvidenceSealRejected', reason: 'CheckpointBindingMismatch' };
    }
    const checkpoint = decodeEvidenceCheckpointDocument(
      checkpointDocument,
      completionConditionIds,
    ).checkpoint;
    const runStartedDocument = await this.#events.findOne(
      {
        ownerAid: input.ownerAid,
        runId: input.runId,
        evidenceStreamId: currentStream.binding.streamId,
        'event.event.kind': 'RunStarted',
      },
      { session, sort: { sequence: 1 } },
    );
    if (runStartedDocument === null) {
      return { kind: 'EvidenceSealRejected', reason: 'CheckpointBindingMismatch' };
    }
    const runStarted = decodeEvidenceEventDocument(runStartedDocument).event;
    if (runStarted.event.kind !== 'RunStarted') {
      return { kind: 'EvidenceSealRejected', reason: 'CheckpointBindingMismatch' };
    }
    const streamSettlement = sealEvidenceStream(currentStream, {
      exchangeSaid: input.exchangeSaid,
      eventCount: currentStream.cursor.acceptedThrough + 1,
      finalSequence: currentStream.cursor.acceptedThrough,
      chainHeadSaid: currentStream.cursor.chainHeadSaid,
      sealedAt: input.sealedAt,
    });
    switch (streamSettlement.kind) {
      case 'SealConflict':
        return { kind: 'EvidenceSealConflict' };
      case 'EvidenceAbsent':
      case 'CheckpointAbsent':
      case 'CursorConflict':
        return {
          kind: 'EvidenceSealCursorIncomplete',
          acceptedEventCount: currentStream.cursor.acceptedThrough + 1,
        };
      case 'Sealed':
      case 'Equivalent':
        break;
    }
    const previousRunVersion =
      streamSettlement.kind === 'Equivalent' ? currentRun.version - 1 : input.expectedRunVersion;
    const runSettlement = applySealedRunCheckpoint(currentRun, {
      expectedRunVersion: previousRunVersion,
      checkpoint: {
        checkpointSaid: checkpoint.d,
        taskId: checkpoint.taskId,
        taskRevisionSaid: checkpoint.taskRevisionSaid,
        runId: checkpoint.runId,
        incarnationId: checkpoint.incarnationId,
        harnessRevisionSaid: checkpoint.harnessRevisionSaid,
        lifecycle: currentStream.provisional.lifecycle,
        submissionVerification: currentStream.provisional.submissionVerification,
      },
      runStarted: {
        eventSaid: runStarted.d,
        fromRunVersion: runStarted.event.fromRunVersion,
        taskId: runStarted.taskId,
        taskRevisionSaid: runStarted.taskRevisionSaid,
        runId: runStarted.runId,
        incarnationId: runStarted.incarnationId,
        harnessRevisionSaid: runStarted.harnessRevisionSaid,
        personalAgentAid: runStarted.personalAgentAid,
        taskMandateSaid: runStarted.taskMandateSaid,
      },
      consumedBudget: checkpoint.budget.consumed,
    });
    if (runSettlement.kind !== 'Applied' && runSettlement.kind !== 'Equivalent') {
      return runSettlement.kind === 'VersionConflict'
        ? { kind: 'EvidenceCursorConcurrentUpdate' }
        : { kind: 'EvidenceSealRejected', reason: 'CheckpointBindingMismatch' };
    }
    const previousTaskVersion =
      streamSettlement.kind === 'Equivalent' && currentTask.task.lifecycle.kind === 'Completed'
        ? currentTask.task.expectedVersion - 1
        : currentTask.task.expectedVersion;
    const taskSettlement = settleTaskFromSealedRun(currentTask.task, {
      taskRevisionSaid: checkpoint.taskRevisionSaid,
      expectedTaskVersion: previousTaskVersion,
      lifecycle: runSettlement.run.lifecycle,
      submissionVerification: runSettlement.run.submissionVerification,
    });
    if (taskSettlement.kind !== 'Settled' && taskSettlement.kind !== 'Equivalent') {
      return taskSettlement.kind === 'TaskVersionConflict'
        ? { kind: 'EvidenceCursorConcurrentUpdate' }
        : { kind: 'EvidenceSealRejected', reason: 'CheckpointBindingMismatch' };
    }
    if (streamSettlement.kind === 'Sealed') {
      await this.#replaceStream(currentStream.version, streamSettlement.stream, session);
    }
    if (runSettlement.kind === 'Applied') {
      const replaced = await this.#runs.replaceOne(
        { _id: input.runId, ownerAid: input.ownerAid, runVersion: currentRun.version },
        encodeRunDocument(runSettlement.run, decodedRun.commandFingerprint),
        { session },
      );
      if (replaced.modifiedCount !== 1) {
        throw new EvidenceSealCommitmentAborted({ kind: 'EvidenceCursorConcurrentUpdate' });
      }
    }
    if (
      taskSettlement.kind === 'Settled' &&
      taskSettlement.task.expectedVersion !== currentTask.task.expectedVersion
    ) {
      const replaced = await this.#tasks.replaceOne(
        {
          _id: currentTask.task.taskId,
          ownerAid: input.ownerAid,
          expectedVersion: currentTask.task.expectedVersion,
        },
        encodeTaskDocument(
          projectTask(taskSettlement.task, currentTask.revision),
          currentTask.commandFingerprint,
          currentTask.allocation,
        ),
        { session },
      );
      if (replaced.modifiedCount !== 1) {
        throw new EvidenceSealCommitmentAborted({ kind: 'EvidenceCursorConcurrentUpdate' });
      }
    }
    return streamSettlement.kind === 'Equivalent'
      ? { kind: 'EvidenceStreamAlreadySealed', stream: streamSettlement.stream }
      : { kind: 'EvidenceStreamSealed', stream: streamSettlement.stream };
  }

  async #replaceStream(
    currentVersion: number,
    next: EvidenceStream,
    session: ClientSession,
  ): Promise<void> {
    const replaced = await this.#streams.replaceOne(
      { _id: next.binding.streamId, version: currentVersion },
      encodeEvidenceStreamDocument(next),
      { session },
    );
    if (replaced.modifiedCount !== 1) {
      throw new EvidenceSealCommitmentAborted({ kind: 'EvidenceCursorConcurrentUpdate' });
    }
  }
}
