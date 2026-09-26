import {
  MongoServerError,
  type ClientSession,
  type Collection,
  type Db,
  type MongoClient,
} from 'mongodb';

import {
  acceptEvidenceBatch as advanceEvidenceStream,
  taskBudgetNames,
  type EvidenceBatchCheckpoint,
  type EvidenceStream,
  type Run,
  type TaskBudgets,
} from '@devrandom/domain';
import {
  decodeEvidenceBatch,
  decodeVerifiedCheckpoint,
  evidenceArtifactReferences,
  type EvidenceBatchAcknowledgement,
  type EvidenceEvent,
  type VerifiedCheckpoint,
} from '@devrandom/protocol';

import type {
  EvidenceBatchCommitment,
  EvidenceBatchCommitmentInput,
  EvidenceBatches,
} from '../application/evidence-batches.js';
import {
  bodyCheckpointBelongsToRun,
  checkpointRunDisposition,
  evidenceEventBelongsToRun,
  privacyCheckpointMarkersMatch,
} from '../domain/run-binding.js';
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
import { currentEvidenceStream } from './evidence-stream-binding.js';

function duplicateKey(error: unknown): error is MongoServerError {
  return error instanceof MongoServerError && error.code === 11_000;
}

class EvidenceBatchCommitmentAborted extends Error {
  readonly outcome: EvidenceBatchCommitment;

  constructor(outcome: EvidenceBatchCommitment) {
    super(outcome.kind);
    this.name = 'EvidenceBatchCommitmentAborted';
    this.outcome = outcome;
  }
}

function checkpointInput(checkpoint: VerifiedCheckpoint | undefined): EvidenceBatchCheckpoint {
  if (checkpoint === undefined) {
    return { kind: 'Absent' };
  }
  const disposition = checkpointRunDisposition(checkpoint);
  return {
    kind: 'Present',
    checkpointSaid: checkpoint.d,
    lifecycle: disposition.lifecycle,
    submissionVerification: disposition.submissionVerification,
  };
}

function budgetLedger(
  run: Run,
  events: readonly EvidenceEvent[],
  throughSequence: number,
): TaskBudgets | undefined {
  let consumed: TaskBudgets = { ...run.consumedBudget };
  for (const event of events) {
    if (event.sequence > throughSequence || event.event.kind !== 'BudgetDebited') {
      continue;
    }
    const name = event.event.budget;
    const next = consumed[name] + event.event.amount;
    if (!Number.isSafeInteger(next) || next !== event.event.consumed) {
      return undefined;
    }
    consumed = { ...consumed, [name]: next };
  }
  return consumed;
}

function checkpointBudgetMatches(
  checkpoint: VerifiedCheckpoint,
  run: Run,
  consumed: TaskBudgets,
): boolean {
  return taskBudgetNames.every(
    (name) =>
      checkpoint.budget.consumed[name] === consumed[name] &&
      checkpoint.budget.remaining[name] === Math.max(0, run.binding.budget[name] - consumed[name]),
  );
}

function artifactReferences(
  events: readonly EvidenceEvent[],
  checkpoint: VerifiedCheckpoint | undefined,
): readonly string[] {
  const references = new Set<string>();
  for (const event of events) {
    for (const said of evidenceArtifactReferences(event.event)) {
      references.add(said);
    }
  }
  if (checkpoint !== undefined) {
    for (const said of checkpoint.outputArtifactSaids) {
      references.add(said);
    }
    for (const receipt of checkpoint.verifierReceipts) {
      if (receipt.outcome.kind === 'Accepted' || receipt.outcome.kind === 'Rejected') {
        for (const said of receipt.outcome.outputArtifactSaids) {
          references.add(said);
        }
      }
    }
  }
  return [...references];
}

export class MongoEvidenceBatches implements EvidenceBatches {
  readonly #client: MongoClient;
  readonly #runs: Collection<RunDocument>;
  readonly #tasks: Collection<TaskDocument>;
  readonly #streams: Collection<EvidenceStreamDocument>;
  readonly #artifacts: Collection<EvidenceArtifactDocument>;
  readonly #batches: Collection<EvidenceBatchDocument>;
  readonly #events: Collection<EvidenceEventDocument>;
  readonly #checkpoints: Collection<EvidenceCheckpointDocument>;
  readonly #usage: Collection<EvidenceUsageDocument>;

  constructor(client: MongoClient, database: Db) {
    this.#client = client;
    this.#runs = database.collection<RunDocument>(runsCollectionName);
    this.#tasks = database.collection<TaskDocument>(tasksCollectionName);
    this.#streams = database.collection<EvidenceStreamDocument>(evidenceCollectionNames.streams);
    this.#artifacts = database.collection<EvidenceArtifactDocument>(
      evidenceCollectionNames.artifacts,
    );
    this.#batches = database.collection<EvidenceBatchDocument>(evidenceCollectionNames.batches);
    this.#events = database.collection<EvidenceEventDocument>(evidenceCollectionNames.events);
    this.#checkpoints = database.collection<EvidenceCheckpointDocument>(
      evidenceCollectionNames.checkpoints,
    );
    this.#usage = database.collection<EvidenceUsageDocument>(evidenceCollectionNames.usage);
  }

  async accept(input: EvidenceBatchCommitmentInput): Promise<EvidenceBatchCommitment> {
    try {
      return await this.#client.withSession((session) =>
        session.withTransaction(() => this.#commit(input, session), {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
        }),
      );
    } catch (error) {
      if (error instanceof EvidenceBatchCommitmentAborted) {
        return error.outcome;
      }
      if (duplicateKey(error)) {
        return this.#reconcile(input);
      }
      return { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' };
    }
  }

  async #commit(
    input: EvidenceBatchCommitmentInput,
    session: ClientSession,
  ): Promise<EvidenceBatchCommitment> {
    const existing = await this.#batches.findOne({ _id: input.body.batch.d }, { session });
    if (existing !== null) {
      return this.#existing(input, existing, session);
    }
    const runDocument = await this.#runs.findOne(
      { _id: input.body.batch.runId, ownerAid: input.ownerAid },
      { session },
    );
    if (runDocument === null) {
      return { kind: 'EvidenceRunNotFound' };
    }
    const run = decodeRunDocument(runDocument).run;
    if (run.version !== input.expectedRunVersion) {
      return { kind: 'EvidenceCursorConcurrentUpdate' };
    }
    if (
      input.body.batch.evidenceStreamId !==
        (run.currentExecution?.evidenceStreamId ?? run.binding.evidenceStreamId) ||
      input.body.events.some((event) => !evidenceEventBelongsToRun(event, run))
    ) {
      return { kind: 'EvidenceBatchRejected', reason: 'EventBindingMismatch' };
    }
    if (!bodyCheckpointBelongsToRun(input.body, run)) {
      return { kind: 'EvidenceBatchRejected', reason: 'CheckpointBindingMismatch' };
    }
    const taskDocument = await this.#tasks.findOne(
      { _id: run.binding.taskId, ownerAid: input.ownerAid },
      { session },
    );
    if (taskDocument === null) {
      return { kind: 'EvidenceBatchRejected', reason: 'RunBindingMismatch' };
    }
    const task = decodeTaskDocument(taskDocument).task;
    if (
      task.revisionSaid !== run.binding.taskRevisionSaid ||
      task.harnessLineageId !== run.binding.harnessLineageId
    ) {
      return { kind: 'EvidenceBatchRejected', reason: 'RunBindingMismatch' };
    }
    const completionConditionIds = task.revision.completionConditions.map(
      (condition) => condition.id,
    );
    if (
      input.body.checkpoint !== undefined &&
      decodeVerifiedCheckpoint(input.body.checkpoint, completionConditionIds).kind !== 'Accepted'
    ) {
      return { kind: 'EvidenceBatchRejected', reason: 'CheckpointInvalid' };
    }
    const references = artifactReferences(input.body.events, input.body.checkpoint);
    if (!(await this.#artifactsExist(references, input.ownerAid, run, session))) {
      return { kind: 'EvidenceBatchRejected', reason: 'EventBindingMismatch' };
    }
    const streamDocument = await this.#streams.findOne(
      {
        _id: run.currentExecution?.evidenceStreamId ?? run.binding.evidenceStreamId,
        'binding.ownerAid': input.ownerAid,
      },
      { session },
    );
    const stream =
      streamDocument === null
        ? currentEvidenceStream(run)
        : decodeEvidenceStreamDocument(streamDocument);
    if (stream === undefined || stream.binding.runId !== run.binding.runId) {
      return { kind: 'EvidenceBatchRejected', reason: 'RunBindingMismatch' };
    }
    if (
      input.body.checkpoint !== undefined &&
      !(await this.#checkpointIsConsistent(input.body.checkpoint, run, input.body.events, session))
    ) {
      return { kind: 'EvidenceBatchRejected', reason: 'CheckpointBindingMismatch' };
    }
    const advancement = advanceEvidenceStream(stream, {
      batchSaid: input.body.batch.d,
      startingSequence: input.body.batch.startingSequence,
      endingSequence: input.body.batch.endingSequence,
      predecessor: input.body.batch.predecessor,
      eventSaids: input.body.batch.eventSaids,
      encodedBytes: input.body.batch.encodedByteCount,
      checkpoint: checkpointInput(input.body.checkpoint),
    });
    if (advancement.kind !== 'Accepted') {
      return this.#advancementFailure(advancement, input.body.batch.startingSequence);
    }
    const usageDocument = await this.#usage.findOne({ _id: evidenceUsageDocumentId }, { session });
    const usage = decodeEvidenceUsageDocument(usageDocument);
    const globalCeiling = run.binding.budget.acceptedEvidencePlusArtifactsGloballyBytes;
    if (usage.acceptedBytes + input.body.batch.encodedByteCount > globalCeiling) {
      return { kind: 'GlobalEvidenceQuotaExceeded' };
    }
    const acknowledgement: EvidenceBatchAcknowledgement = {
      version: 1,
      disposition: { kind: 'Accepted' },
      runId: input.body.batch.runId,
      evidenceStreamId: input.body.batch.evidenceStreamId,
      batchSaid: input.body.batch.d,
      acceptedThroughSequence: input.body.batch.endingSequence,
      chainHeadSaid: input.body.batch.eventSaids[input.body.batch.eventSaids.length - 1] ?? '',
      receivedAt: input.receivedAt,
    };
    const decodedBatch = decodeEvidenceBatch(input.body.batch, input.body.events);
    if (decodedBatch.kind !== 'Accepted' || acknowledgement.chainHeadSaid.length === 0) {
      return { kind: 'EvidenceBatchRejected', reason: 'PredecessorMismatch' };
    }
    await this.#events.insertMany(
      input.body.events.map((event) =>
        encodeEvidenceEventDocument({
          ownerAid: input.ownerAid,
          evidenceStreamId: input.body.batch.evidenceStreamId,
          batchSaid: input.body.batch.d,
          event,
          receivedAt: input.receivedAt,
        }),
      ),
      { session, ordered: true },
    );
    if (input.body.checkpoint !== undefined) {
      await this.#checkpoints.insertOne(
        encodeEvidenceCheckpointDocument(
          {
            ownerAid: input.ownerAid,
            evidenceStreamId: input.body.batch.evidenceStreamId,
            batchSaid: input.body.batch.d,
            checkpoint: input.body.checkpoint,
            receivedAt: input.receivedAt,
          },
          completionConditionIds,
        ),
        { session },
      );
    }
    await this.#batches.insertOne(
      encodeEvidenceBatchDocument({
        ownerAid: input.ownerAid,
        commandFingerprint: input.commandFingerprint,
        batch: decodedBatch.batch,
        events: decodedBatch.events,
        acknowledgement,
      }),
      { session },
    );
    const usageUpdate = await this.#usage.updateOne(
      { _id: evidenceUsageDocumentId, version: usage.version },
      { $inc: { version: 1, acceptedBytes: input.body.batch.encodedByteCount } },
      { session },
    );
    if (usageUpdate.modifiedCount !== 1) {
      throw new EvidenceBatchCommitmentAborted({ kind: 'EvidenceCursorConcurrentUpdate' });
    }
    await this.#commitStream(streamDocument, stream, advancement.stream, session);
    return { kind: 'EvidenceBatchAccepted', acknowledgement };
  }

  async #artifactsExist(
    references: readonly string[],
    ownerAid: string,
    run: Run,
    session: ClientSession,
  ): Promise<boolean> {
    if (references.length === 0) {
      return true;
    }
    const documents = await this.#artifacts
      .find({ runId: run.binding.runId, 'artifact.d': { $in: [...references] } }, { session })
      .toArray();
    if (documents.length !== references.length) {
      return false;
    }
    // Artifacts are content-addressed within a Run; the recording stream is
    // immutable provenance, not exclusive ownership by one incarnation.
    for (const document of documents) {
      const artifact = decodeEvidenceArtifactDocument(document);
      if (artifact.ownerAid !== ownerAid || artifact.runId !== run.binding.runId) return false;
      const source = await this.#streams.findOne(
        {
          _id: artifact.evidenceStreamId,
          'binding.runId': run.binding.runId,
          'binding.ownerAid': ownerAid,
        },
        { session },
      );
      if (source === null) return false;
      const provenance = decodeEvidenceStreamDocument(source).binding;
      if (
        provenance.taskId !== run.binding.taskId ||
        provenance.taskRevisionSaid !== run.binding.taskRevisionSaid ||
        provenance.personalAgentAid !== run.binding.personalAgentAid ||
        provenance.taskMandateSaid !== run.binding.taskMandateSaid
      )
        return false;
    }
    return true;
  }

  async #checkpointIsConsistent(
    checkpoint: VerifiedCheckpoint,
    run: Run,
    currentEvents: readonly EvidenceEvent[],
    session: ClientSession,
  ): Promise<boolean> {
    const priorDocuments = await this.#events
      .find(
        {
          ownerAid: run.binding.ownerAid,
          runId: run.binding.runId,
          evidenceStreamId: run.currentExecution?.evidenceStreamId ?? run.binding.evidenceStreamId,
          sequence: { $lte: checkpoint.evidence.finalSequence },
        },
        { session },
      )
      .sort({ sequence: 1 })
      .toArray();
    const priorEvents = priorDocuments.map(
      (document) => decodeEvidenceEventDocument(document).event,
    );
    const throughCheckpoint = [...priorEvents, ...currentEvents]
      .filter((event) => event.sequence <= checkpoint.evidence.finalSequence)
      .sort((left, right) => left.sequence - right.sequence);
    const finalEvent = throughCheckpoint.at(-1);
    if (
      finalEvent === undefined ||
      throughCheckpoint.length !== checkpoint.evidence.eventCount ||
      finalEvent.sequence !== checkpoint.evidence.finalSequence ||
      finalEvent.d !== checkpoint.evidence.chainHeadSaid ||
      !privacyCheckpointMarkersMatch(checkpoint, throughCheckpoint)
    ) {
      return false;
    }
    const consumed = budgetLedger(run, throughCheckpoint, checkpoint.evidence.finalSequence);
    return consumed !== undefined && checkpointBudgetMatches(checkpoint, run, consumed);
  }

  #advancementFailure(
    advancement: Exclude<ReturnType<typeof advanceEvidenceStream>, { readonly kind: 'Accepted' }>,
    receivedStartingSequence: number,
  ): EvidenceBatchCommitment {
    switch (advancement.kind) {
      case 'StreamSealed':
        return { kind: 'EvidenceStreamSealed' };
      case 'SequenceGap':
        return {
          kind: 'EvidenceSequenceGap',
          expectedStartingSequence: advancement.expectedSequence,
          receivedStartingSequence,
        };
      case 'CheckpointConflict':
        return { kind: 'EvidenceCheckpointConflict' };
      case 'RunByteBudgetExhausted':
        return { kind: 'RunEvidenceQuotaExceeded' };
      case 'PredecessorConflict':
        return { kind: 'EvidenceBatchRejected', reason: 'PredecessorMismatch' };
      case 'CheckpointDispositionInvalid':
        return { kind: 'EvidenceBatchRejected', reason: 'CheckpointInvalid' };
      case 'BatchLimitExceeded':
      case 'BatchPositionInvalid':
      case 'DuplicateEventSaid':
        return { kind: 'EvidenceBatchConflict' };
    }
  }

  async #commitStream(
    currentDocument: EvidenceStreamDocument | null,
    current: EvidenceStream,
    next: EvidenceStream,
    session: ClientSession,
  ): Promise<void> {
    const replacement = encodeEvidenceStreamDocument(next);
    if (currentDocument === null) {
      await this.#streams.insertOne(replacement, { session });
      return;
    }
    const committed = await this.#streams.replaceOne(
      { _id: current.binding.streamId, version: current.version },
      replacement,
      { session },
    );
    if (committed.modifiedCount !== 1) {
      throw new EvidenceBatchCommitmentAborted({ kind: 'EvidenceCursorConcurrentUpdate' });
    }
  }

  async #existing(
    input: EvidenceBatchCommitmentInput,
    document: EvidenceBatchDocument,
    session?: ClientSession,
  ): Promise<EvidenceBatchCommitment> {
    const eventDocuments = await this.#events
      .find(
        { _id: { $in: [...document.batch.eventSaids] } },
        session === undefined ? {} : { session },
      )
      .toArray();
    const bySaid = new Map(
      eventDocuments.map((eventDocument) => {
        const decoded = decodeEvidenceEventDocument(eventDocument);
        return [decoded.event.d, decoded.event] as const;
      }),
    );
    const events: EvidenceEvent[] = [];
    for (const said of document.batch.eventSaids) {
      const event = bySaid.get(said);
      if (event === undefined) {
        return { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' };
      }
      events.push(event);
    }
    const accepted = decodeEvidenceBatchDocument(document, events);
    return accepted.ownerAid === input.ownerAid &&
      accepted.commandFingerprint === input.commandFingerprint
      ? {
          kind: 'EvidenceBatchAlreadyAccepted',
          acknowledgement: accepted.acknowledgement,
        }
      : { kind: 'EvidenceBatchConflict' };
  }

  async #reconcile(input: EvidenceBatchCommitmentInput): Promise<EvidenceBatchCommitment> {
    try {
      const existing = await this.#batches.findOne({ _id: input.body.batch.d });
      return existing === null
        ? { kind: 'EvidenceCursorConcurrentUpdate' }
        : await this.#existing(input, existing);
    } catch {
      return { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' };
    }
  }
}
