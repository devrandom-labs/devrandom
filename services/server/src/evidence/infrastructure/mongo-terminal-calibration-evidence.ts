import { isDeepStrictEqual } from 'node:util';

import {
  MongoServerError,
  type ClientSession,
  type Collection,
  type Db,
  type MongoClient,
} from 'mongodb';

import { acceptEvidenceBatch, type Run, type TaskBudgets } from '@devrandom/domain';
import {
  decodeEvidenceBatch,
  evidenceArtifactReferences,
  evidenceBatchCommandFingerprint,
  type EvidenceBatchAcknowledgement,
  type EvidenceEvent,
} from '@devrandom/protocol';

import { checkpointRunDisposition } from '../domain/run-binding.js';
import type { EvidenceBatchCommitment } from '../application/evidence-batches.js';
import {
  assessTerminalCalibrationBatch,
  type TerminalCalibrationEvidence,
  type TerminalCalibrationReconciliationInput,
} from '../application/terminal-calibration-reconciliation.js';
import { runsCollectionName } from '../../run/infrastructure/mongo-runs.js';
import { decodeRunDocument, type RunDocument } from '../../run/infrastructure/run-document.js';
import { tasksCollectionName } from '../../task/infrastructure/mongo-tasks.js';
import { decodeTaskDocument, type TaskDocument } from '../../task/infrastructure/task-document.js';
import {
  decodeEvidenceArtifactDocument,
  type EvidenceArtifactDocument,
} from './evidence-artifact-document.js';
import {
  decodeEvidenceBatchDocument,
  encodeEvidenceBatchDocument,
  type EvidenceBatchDocument,
} from './evidence-batch-document.js';
import {
  encodeEvidenceCheckpointDocument,
  type EvidenceCheckpointDocument,
} from './evidence-checkpoint-document.js';
import {
  decodeEvidenceEventDocument,
  encodeEvidenceEventDocument,
  type EvidenceEventDocument,
} from './evidence-event-document.js';
import { evidenceCollectionNames, evidenceUsageDocumentId } from './evidence-storage-contract.js';
import {
  decodeEvidenceStreamDocument,
  encodeEvidenceStreamDocument,
  type EvidenceStreamDocument,
} from './evidence-stream-document.js';
import {
  decodeEvidenceUsageDocument,
  type EvidenceUsageDocument,
} from './evidence-usage-document.js';

class TerminalCommitAborted extends Error {
  readonly outcome: EvidenceBatchCommitment;

  constructor(outcome: EvidenceBatchCommitment) {
    super(outcome.kind);
    this.outcome = outcome;
  }
}

function rejected(
  reason: 'RunBindingMismatch' | 'EventBindingMismatch' | 'CheckpointBindingMismatch',
): EvidenceBatchCommitment {
  return { kind: 'EvidenceBatchRejected', reason };
}

function consumedFromAccepted(run: Run, events: readonly EvidenceEvent[]): TaskBudgets | undefined {
  let consumed = { ...run.consumedBudget };
  for (const event of events) {
    if (event.event.kind !== 'BudgetDebited') continue;
    const { budget, amount } = event.event;
    const total = consumed[budget] + amount;
    if (amount <= 0 || !Number.isSafeInteger(total) || total !== event.event.consumed)
      return undefined;
    consumed = { ...consumed, [budget]: total };
  }
  return consumed;
}

function oneAcceptedChain(
  events: readonly EvidenceEvent[],
  through: number,
  head: string,
): boolean {
  if (events.length !== through + 1 || events[0]?.sequence !== 0) return false;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (
      event === undefined ||
      event.sequence !== index ||
      (index === 0
        ? event.predecessor.kind !== 'Genesis'
        : event.predecessor.kind !== 'Previous' ||
          event.predecessor.eventSaid !== events[index - 1]?.d)
    )
      return false;
  }
  return events.at(-1)?.d === head;
}

/** Dedicated terminal writer; ordinary evidence batches retain their pre-expiry law. */
export class MongoTerminalCalibrationEvidence implements TerminalCalibrationEvidence {
  readonly #client: MongoClient;
  readonly #runs: Collection<RunDocument>;
  readonly #tasks: Collection<TaskDocument>;
  readonly #streams: Collection<EvidenceStreamDocument>;
  readonly #events: Collection<EvidenceEventDocument>;
  readonly #batches: Collection<EvidenceBatchDocument>;
  readonly #checkpoints: Collection<EvidenceCheckpointDocument>;
  readonly #artifacts: Collection<EvidenceArtifactDocument>;
  readonly #usage: Collection<EvidenceUsageDocument>;

  constructor(client: MongoClient, database: Db) {
    this.#client = client;
    this.#runs = database.collection<RunDocument>(runsCollectionName);
    this.#tasks = database.collection<TaskDocument>(tasksCollectionName);
    this.#streams = database.collection<EvidenceStreamDocument>(evidenceCollectionNames.streams);
    this.#events = database.collection<EvidenceEventDocument>(evidenceCollectionNames.events);
    this.#batches = database.collection<EvidenceBatchDocument>(evidenceCollectionNames.batches);
    this.#checkpoints = database.collection<EvidenceCheckpointDocument>(
      evidenceCollectionNames.checkpoints,
    );
    this.#artifacts = database.collection<EvidenceArtifactDocument>(
      evidenceCollectionNames.artifacts,
    );
    this.#usage = database.collection<EvidenceUsageDocument>(evidenceCollectionNames.usage);
  }

  async reconcile(input: TerminalCalibrationReconciliationInput): Promise<EvidenceBatchCommitment> {
    try {
      return await this.#client.withSession((session) =>
        session.withTransaction(() => this.#commit(input, session), {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
        }),
      );
    } catch (error) {
      if (error instanceof TerminalCommitAborted) return error.outcome;
      if (error instanceof MongoServerError && error.code === 11_000) return this.#retry(input);
      return { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' };
    }
  }

  async #commit(
    input: TerminalCalibrationReconciliationInput,
    session: ClientSession,
  ): Promise<EvidenceBatchCommitment> {
    const { expected, body } = input.command;
    if (body.batch.runId !== input.runId) return rejected('RunBindingMismatch');
    const existing = await this.#batches.findOne({ _id: body.batch.d }, { session });
    if (existing !== null) return this.#existing(input, existing, session);
    const runDocument = await this.#runs.findOne(
      { _id: input.runId, ownerAid: input.ownerAid },
      { session },
    );
    if (runDocument === null) return { kind: 'EvidenceRunNotFound' };
    const run = decodeRunDocument(runDocument).run;
    const streamDocument = await this.#streams.findOne(
      { _id: run.binding.evidenceStreamId, 'binding.ownerAid': input.ownerAid },
      { session },
    );
    if (streamDocument === null)
      return {
        kind: 'EvidenceSequenceGap',
        expectedStartingSequence: 0,
        receivedStartingSequence: body.batch.startingSequence,
      };
    const stream = decodeEvidenceStreamDocument(streamDocument);
    if (stream.cursor.kind !== 'Continued') return rejected('RunBindingMismatch');
    const taskDocument = await this.#tasks.findOne(
      { _id: run.binding.taskId, ownerAid: input.ownerAid },
      { session },
    );
    if (taskDocument === null) return rejected('RunBindingMismatch');
    const task = decodeTaskDocument(taskDocument).task;
    if (
      task.revisionSaid !== run.binding.taskRevisionSaid ||
      task.harnessLineageId !== run.binding.harnessLineageId
    )
      return rejected('RunBindingMismatch');
    const completionConditionIds = task.revision.completionConditions.map(
      (condition) => condition.id,
    );
    const eventDocuments = await this.#events
      .find(
        {
          ownerAid: input.ownerAid,
          runId: input.runId,
          evidenceStreamId: run.binding.evidenceStreamId,
        },
        { session },
      )
      .sort({ sequence: 1 })
      .toArray();
    const acceptedEvents = eventDocuments.map(
      (document) => decodeEvidenceEventDocument(document).event,
    );
    if (
      !oneAcceptedChain(acceptedEvents, stream.cursor.acceptedThrough, stream.cursor.chainHeadSaid)
    )
      return rejected('EventBindingMismatch');
    const runStarted = acceptedEvents[0];
    const acceptedBudget = consumedFromAccepted(run, acceptedEvents);
    if (runStarted === undefined || acceptedBudget === undefined)
      return rejected('EventBindingMismatch');
    const assessment = assessTerminalCalibrationBatch({
      run,
      stream,
      runStarted,
      acceptedBudget,
      taskExpiresAt: task.revision.expiresAt,
      acceptedSubmission: acceptedEvents.some(({ event }) => event.kind === 'ResultSubmitted'),
      completionConditionIds,
      expected,
      body,
      receivedAt: input.receivedAt,
    });
    if (assessment.kind !== 'Accepted')
      return assessment.reason === 'CursorConflict'
        ? { kind: 'EvidenceCursorConcurrentUpdate' }
        : rejected(
            assessment.reason === 'CheckpointInvalid' || assessment.reason === 'BudgetMismatch'
              ? 'CheckpointBindingMismatch'
              : 'EventBindingMismatch',
          );
    if (assessment.phase === 'Acknowledgement') {
      if (stream.provisional.kind !== 'Checkpointed') return rejected('CheckpointBindingMismatch');
      const checkpointSaid = stream.provisional.checkpointSaid;
      const marker = acceptedEvents.find(
        (event) =>
          (stream.provisional.kind === 'Checkpointed' &&
          stream.provisional.lifecycle.kind === 'Ended' &&
          stream.provisional.lifecycle.outcome.kind === 'Cancelled'
            ? event.event.kind === 'CheckpointVerified'
            : event.event.kind === 'RunCalibrationRecorded') &&
          'checkpointSaid' in event.event &&
          event.event.checkpointSaid === checkpointSaid,
      );
      if (marker === undefined) return rejected('CheckpointBindingMismatch');
    }
    const references = new Set(
      body.events.flatMap((event) => evidenceArtifactReferences(event.event)),
    );
    if (body.checkpoint !== undefined) {
      body.checkpoint.outputArtifactSaids.forEach((said) => references.add(said));
      for (const receipt of body.checkpoint.verifierReceipts) {
        if (receipt.outcome.kind === 'Accepted' || receipt.outcome.kind === 'Rejected')
          receipt.outcome.outputArtifactSaids.forEach((said) => references.add(said));
      }
    }
    if (references.size > 0) {
      const artifacts = await this.#artifacts
        .find({ runId: input.runId, 'artifact.d': { $in: [...references] } }, { session })
        .toArray();
      if (
        artifacts.length !== references.size ||
        artifacts.some((document) => {
          const artifact = decodeEvidenceArtifactDocument(document);
          return (
            artifact.ownerAid !== input.ownerAid ||
            artifact.evidenceStreamId !== run.binding.evidenceStreamId
          );
        })
      )
        return rejected('EventBindingMismatch');
    }
    const advancement = acceptEvidenceBatch(stream, {
      batchSaid: body.batch.d,
      startingSequence: body.batch.startingSequence,
      endingSequence: body.batch.endingSequence,
      predecessor: body.batch.predecessor,
      eventSaids: body.batch.eventSaids,
      encodedBytes: body.batch.encodedByteCount,
      checkpoint:
        body.checkpoint === undefined
          ? { kind: 'Absent' }
          : {
              kind: 'Present',
              checkpointSaid: body.checkpoint.d,
              ...checkpointRunDisposition(body.checkpoint),
            },
    });
    if (advancement.kind !== 'Accepted')
      return advancement.kind === 'RunByteBudgetExhausted'
        ? { kind: 'RunEvidenceQuotaExceeded' }
        : { kind: 'EvidenceCursorConcurrentUpdate' };
    const decodedBatch = decodeEvidenceBatch(body.batch, body.events);
    if (decodedBatch.kind !== 'Accepted') return { kind: 'EvidenceBatchConflict' };
    const usageDocument = await this.#usage.findOne({ _id: evidenceUsageDocumentId }, { session });
    const usage = decodeEvidenceUsageDocument(usageDocument);
    if (
      usage.acceptedBytes + body.batch.encodedByteCount >
      run.binding.budget.acceptedEvidencePlusArtifactsGloballyBytes
    )
      return { kind: 'GlobalEvidenceQuotaExceeded' };
    const acknowledgement: EvidenceBatchAcknowledgement = {
      version: 1,
      disposition: { kind: 'Accepted' },
      runId: input.runId,
      evidenceStreamId: run.binding.evidenceStreamId,
      batchSaid: body.batch.d,
      acceptedThroughSequence: body.batch.endingSequence,
      chainHeadSaid: body.batch.eventSaids.at(-1) ?? '',
      receivedAt: input.receivedAt,
    };
    await this.#events.insertMany(
      body.events.map((event) =>
        encodeEvidenceEventDocument({
          ownerAid: input.ownerAid,
          evidenceStreamId: run.binding.evidenceStreamId,
          batchSaid: body.batch.d,
          event,
          receivedAt: input.receivedAt,
        }),
      ),
      { session, ordered: true },
    );
    if (body.checkpoint !== undefined)
      await this.#checkpoints.insertOne(
        encodeEvidenceCheckpointDocument(
          {
            ownerAid: input.ownerAid,
            evidenceStreamId: run.binding.evidenceStreamId,
            batchSaid: body.batch.d,
            checkpoint: body.checkpoint,
            receivedAt: input.receivedAt,
          },
          completionConditionIds,
        ),
        { session },
      );
    await this.#batches.insertOne(
      encodeEvidenceBatchDocument({
        ownerAid: input.ownerAid,
        commandFingerprint: evidenceBatchCommandFingerprint(body),
        batch: decodedBatch.batch,
        events: decodedBatch.events,
        acknowledgement,
      }),
      { session },
    );
    const usageUpdate = await this.#usage.updateOne(
      { _id: evidenceUsageDocumentId, version: usage.version },
      { $inc: { version: 1, acceptedBytes: body.batch.encodedByteCount } },
      { session },
    );
    if (usageUpdate.modifiedCount !== 1)
      throw new TerminalCommitAborted({ kind: 'EvidenceCursorConcurrentUpdate' });
    const streamUpdate = await this.#streams.replaceOne(
      { _id: stream.binding.streamId, version: stream.version },
      encodeEvidenceStreamDocument(advancement.stream),
      { session },
    );
    if (streamUpdate.modifiedCount !== 1)
      throw new TerminalCommitAborted({ kind: 'EvidenceCursorConcurrentUpdate' });
    return { kind: 'EvidenceBatchAccepted', acknowledgement };
  }

  async #existing(
    input: TerminalCalibrationReconciliationInput,
    document: EvidenceBatchDocument,
    session?: ClientSession,
  ): Promise<EvidenceBatchCommitment> {
    const body = input.command.body;
    if (
      document.ownerAid !== input.ownerAid ||
      document.runId !== input.runId ||
      document.commandFingerprint !== evidenceBatchCommandFingerprint(body) ||
      body.batch.predecessor.kind !== 'Previous' ||
      body.batch.predecessor.eventSaid !== input.command.expected.chainHeadSaid ||
      body.batch.startingSequence !== input.command.expected.acceptedThroughSequence + 1 ||
      body.events.some((event) => event.incarnationId !== input.command.expected.incarnationId)
    )
      return { kind: 'EvidenceBatchConflict' };
    const runStarted = await this.#events.findOne(
      {
        ownerAid: input.ownerAid,
        runId: input.runId,
        sequence: 0,
        'event.event.kind': 'RunStarted',
        'event.d': input.command.expected.runStartedSaid,
      },
      session === undefined ? {} : { session },
    );
    if (runStarted === null) return { kind: 'EvidenceBatchConflict' };
    const storedEvents = await this.#events
      .find(
        { _id: { $in: [...document.batch.eventSaids] } },
        session === undefined ? {} : { session },
      )
      .toArray();
    const bySaid = new Map(
      storedEvents.map((row) => {
        const decoded = decodeEvidenceEventDocument(row);
        return [decoded.event.d, decoded.event] as const;
      }),
    );
    const events = document.batch.eventSaids.map((said) => bySaid.get(said));
    if (events.some((event) => event === undefined))
      return { kind: 'EvidenceCursorConcurrentUpdate' };
    const accepted = decodeEvidenceBatchDocument(document, events as EvidenceEvent[]);
    return isDeepStrictEqual(accepted.events, body.events)
      ? { kind: 'EvidenceBatchAlreadyAccepted', acknowledgement: accepted.acknowledgement }
      : { kind: 'EvidenceBatchConflict' };
  }

  async #retry(input: TerminalCalibrationReconciliationInput): Promise<EvidenceBatchCommitment> {
    try {
      const document = await this.#batches.findOne({ _id: input.command.body.batch.d });
      return document === null
        ? { kind: 'EvidenceCursorConcurrentUpdate' }
        : await this.#existing(input, document);
    } catch {
      return { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' };
    }
  }
}
