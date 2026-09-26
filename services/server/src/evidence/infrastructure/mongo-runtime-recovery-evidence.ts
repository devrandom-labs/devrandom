import { isDeepStrictEqual } from 'node:util';

import {
  MongoServerError,
  type ClientSession,
  type Collection,
  type Db,
  type MongoClient,
} from 'mongodb';

import { acceptEvidenceBatch } from '@devrandom/domain';
import {
  decodeEvidenceBatch,
  decodeRunSuccessorSegment,
  evidenceArtifactReferences,
  evidenceBatchCommandFingerprint,
  type EvidenceBatchAcknowledgement,
  type EvidenceEvent,
} from '@devrandom/protocol';

import type { CurrentRunMandates } from '../../run/application/run-authority.js';
import {
  runSuccessorSegmentsCollectionName,
  type RunSuccessorSegmentDocument,
} from '../../run/infrastructure/mongo-run-continuations.js';
import { activationCollectionNames } from '../../activation/infrastructure/mongo-activation-commits.js';
import {
  decodeHarnessDocument,
  type HarnessDocument,
} from '../../harness/infrastructure/harness-document.js';
import { harnessRevisionsCollectionName } from '../../harness/infrastructure/mongo-harness-revisions.js';
import { checkpointRunDisposition } from '../domain/run-binding.js';
import type { EvidenceBatchCommitment } from '../application/evidence-batches.js';
import {
  assessRuntimeRecoveryBatch,
  type RuntimeRecoveryEvidence,
  type RuntimeRecoveryReconciliationInput,
} from '../application/runtime-recovery-reconciliation.js';
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
  decodeEvidenceCheckpointDocument,
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

class RuntimeRecoveryCommitAborted extends Error {
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

/** Accounting-only ProcessLost checkpoint custody; never renews a lease or admits an effect. */
export class MongoRuntimeRecoveryEvidence implements RuntimeRecoveryEvidence {
  readonly #client: MongoClient;
  readonly #mandates: CurrentRunMandates;
  readonly #harnesses: Collection<HarnessDocument>;
  readonly #pointers: Collection<{
    _id: string;
    ownerAid: string;
    version: number;
    activeRevisionSaid: string;
    taskRevisionSaid: string;
    harnessLineageId: string;
    pendingCommandId?: string;
  }>;
  readonly #transitions: Collection<{ ownerAid: string; taskId: string }>;
  readonly #segments: Collection<RunSuccessorSegmentDocument>;
  readonly #runs: Collection<RunDocument>;
  readonly #tasks: Collection<TaskDocument>;
  readonly #streams: Collection<EvidenceStreamDocument>;
  readonly #events: Collection<EvidenceEventDocument>;
  readonly #batches: Collection<EvidenceBatchDocument>;
  readonly #checkpoints: Collection<EvidenceCheckpointDocument>;
  readonly #artifacts: Collection<EvidenceArtifactDocument>;
  readonly #usage: Collection<EvidenceUsageDocument>;

  constructor(client: MongoClient, database: Db, mandates: CurrentRunMandates) {
    this.#mandates = mandates;
    this.#harnesses = database.collection(harnessRevisionsCollectionName);
    this.#pointers = database.collection(activationCollectionNames.pointers);
    this.#transitions = database.collection(activationCollectionNames.transitions);
    this.#segments = database.collection(runSuccessorSegmentsCollectionName);
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

  async reconcile(input: RuntimeRecoveryReconciliationInput): Promise<EvidenceBatchCommitment> {
    try {
      return await this.#client.withSession((session) =>
        session.withTransaction(() => this.#commit(input, session), {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
        }),
      );
    } catch (error) {
      if (error instanceof RuntimeRecoveryCommitAborted) return error.outcome;
      if (error instanceof MongoServerError && error.code === 11_000) return this.#retry(input);
      return { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' };
    }
  }

  async #commit(
    input: RuntimeRecoveryReconciliationInput,
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
    if (run.currentExecution === undefined) return rejected('RunBindingMismatch');
    const streamId = run.currentExecution.evidenceStreamId;
    const authority = await this.#mandates.authorize({
      ...run.binding,
      observedAt: input.receivedAt,
    });
    if (authority.kind !== 'CurrentRunMandatesAuthorized')
      return authority.kind === 'DependencyUnavailable'
        ? { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' }
        : rejected('RunBindingMismatch');
    if (
      authority.task.taskId !== run.binding.taskId ||
      authority.task.revisionSaid !== run.binding.taskRevisionSaid ||
      authority.personalAgentAid !== run.binding.personalAgentAid ||
      authority.taskMandateSaid !== run.binding.taskMandateSaid
    )
      return rejected('RunBindingMismatch');
    const pointer = await this.#pointers.findOne(
      { _id: run.binding.taskId, ownerAid: input.ownerAid },
      { session },
    );
    if (
      pointer !== null &&
      (pointer.version !== 1 ||
        pointer.pendingCommandId !== undefined ||
        pointer.activeRevisionSaid !== run.binding.initialHarnessRevisionSaid ||
        pointer.taskRevisionSaid !== run.binding.taskRevisionSaid ||
        pointer.harnessLineageId !== run.binding.harnessLineageId)
    )
      return rejected('RunBindingMismatch');
    if (
      (await this.#transitions.findOne(
        { ownerAid: input.ownerAid, taskId: run.binding.taskId },
        { session },
      )) !== null
    )
      return rejected('RunBindingMismatch');
    const initial = await this.#harnesses
      .find(
        {
          ownerAid: input.ownerAid,
          taskId: run.binding.taskId,
          'activation.kind': 'InitialSpecializationAccepted',
        },
        { session },
      )
      .limit(2)
      .toArray();
    const harness = initial[0];
    if (
      initial.length !== 1 ||
      harness === undefined ||
      harness._id !== run.binding.initialHarnessRevisionSaid ||
      harness.taskRevisionSaid !== run.binding.taskRevisionSaid ||
      harness.harnessLineageId !== run.binding.harnessLineageId ||
      !isDeepStrictEqual(
        decodeHarnessDocument(harness).activation,
        run.binding.initialSpecialization,
      )
    )
      return rejected('RunBindingMismatch');
    const segmentDocument = await this.#segments.findOne(
      { _id: run.currentExecution.segmentSaid, runId: run.binding.runId, ownerAid: input.ownerAid },
      { session },
    );
    const segment = decodeRunSuccessorSegment(segmentDocument?.segment);
    if (segment.kind !== 'Accepted') return rejected('RunBindingMismatch');

    const streamDocument = await this.#streams.findOne(
      {
        _id: streamId,
        'binding.ownerAid': input.ownerAid,
      },
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
      task.lifecycle.kind !== 'Open' ||
      Date.parse(task.revision.expiresAt) <= Date.parse(input.receivedAt) ||
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
          evidenceStreamId: streamId,
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
    const predecessorDocument = await this.#checkpoints.findOne(
      {
        _id: segment.segment.predecessor.checkpointSaid,
        ownerAid: input.ownerAid,
        runId: input.runId,
        evidenceStreamId: segment.segment.predecessor.evidenceStreamId,
      },
      { session },
    );
    if (predecessorDocument === null) return rejected('CheckpointBindingMismatch');
    const predecessorCheckpoint = decodeEvidenceCheckpointDocument(
      predecessorDocument,
      completionConditionIds,
    ).checkpoint;
    const assessment = assessRuntimeRecoveryBatch({
      run,
      stream,
      segment: segment.segment,
      predecessorCheckpoint,
      acceptedEvents,
      completionConditionIds,
      expected,
      body,
      receivedAt: input.receivedAt,
    });
    if (assessment.kind !== 'Accepted') return rejected('CheckpointBindingMismatch');
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
      if (artifacts.length !== references.size) return rejected('EventBindingMismatch');
      for (const document of artifacts) {
        const artifact = decodeEvidenceArtifactDocument(document);
        if (artifact.ownerAid !== input.ownerAid || artifact.runId !== input.runId)
          return rejected('EventBindingMismatch');
        const provenanceDocument = await this.#streams.findOne(
          {
            _id: artifact.evidenceStreamId,
            'binding.runId': input.runId,
            'binding.ownerAid': input.ownerAid,
          },
          { session },
        );
        if (provenanceDocument === null) return rejected('EventBindingMismatch');
        const provenance = decodeEvidenceStreamDocument(provenanceDocument).binding;
        if (
          provenance.taskId !== run.binding.taskId ||
          provenance.taskRevisionSaid !== run.binding.taskRevisionSaid ||
          provenance.personalAgentAid !== run.binding.personalAgentAid ||
          provenance.taskMandateSaid !== run.binding.taskMandateSaid
        )
          return rejected('EventBindingMismatch');
      }
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
      evidenceStreamId: streamId,
      batchSaid: body.batch.d,
      acceptedThroughSequence: body.batch.endingSequence,
      chainHeadSaid: body.batch.eventSaids.at(-1) ?? '',
      receivedAt: input.receivedAt,
    };
    await this.#events.insertMany(
      body.events.map((event) =>
        encodeEvidenceEventDocument({
          ownerAid: input.ownerAid,
          evidenceStreamId: streamId,
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
            evidenceStreamId: streamId,
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
      throw new RuntimeRecoveryCommitAborted({ kind: 'EvidenceCursorConcurrentUpdate' });
    const streamUpdate = await this.#streams.replaceOne(
      { _id: stream.binding.streamId, version: stream.version },
      encodeEvidenceStreamDocument(advancement.stream),
      { session },
    );
    if (streamUpdate.modifiedCount !== 1)
      throw new RuntimeRecoveryCommitAborted({ kind: 'EvidenceCursorConcurrentUpdate' });
    return { kind: 'EvidenceBatchAccepted', acknowledgement };
  }

  async #existing(
    input: RuntimeRecoveryReconciliationInput,
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

  async #retry(input: RuntimeRecoveryReconciliationInput): Promise<EvidenceBatchCommitment> {
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
