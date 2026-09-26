import { isDeepStrictEqual } from 'node:util';

import {
  createEvidenceStream,
  continueRun,
  continueCalibrationRun,
  recoverUnstartedRunContinuation,
  type Run,
} from '@devrandom/domain';
import {
  decodeRunSuccessorSegment,
  evidenceArtifactReferences,
  prepareRunSuccessorSegment,
  type EvidenceEvent,
  type RunSuccessorSegment,
} from '@devrandom/protocol';
import {
  MongoServerError,
  type ClientSession,
  type Collection,
  type Db,
  type MongoClient,
} from 'mongodb';

import type { RunContinuationCommitments } from '../application/admit-run-continuation.js';
import { verifyContinuationPredecessor } from '@devrandom/protocol';
import {
  decodeEvidenceArtifactDocument,
  type EvidenceArtifactDocument,
} from '../../evidence/infrastructure/evidence-artifact-document.js';
import {
  decodeEvidenceCheckpointDocument,
  type EvidenceCheckpointDocument,
} from '../../evidence/infrastructure/evidence-checkpoint-document.js';
import {
  decodeEvidenceEventDocument,
  type EvidenceEventDocument,
} from '../../evidence/infrastructure/evidence-event-document.js';
import { evidenceCollectionNames } from '../../evidence/infrastructure/evidence-storage-contract.js';
import {
  decodeEvidenceStreamDocument,
  encodeEvidenceStreamDocument,
  type EvidenceStreamDocument,
} from '../../evidence/infrastructure/evidence-stream-document.js';
import { decodeRunDocument, encodeRunDocument, type RunDocument } from './run-document.js';
import { runsCollectionName } from './mongo-runs.js';
import { decodeTaskDocument, type TaskDocument } from '../../task/infrastructure/task-document.js';
import { tasksCollectionName } from '../../task/infrastructure/mongo-tasks.js';
import {
  decodeHarnessDocument,
  type HarnessDocument,
} from '../../harness/infrastructure/harness-document.js';
import { harnessRevisionsCollectionName } from '../../harness/infrastructure/mongo-harness-revisions.js';
import { activationCollectionNames } from '../../activation/infrastructure/mongo-activation-commits.js';

export const runSuccessorSegmentsCollectionName = 'runSuccessorSegments' as const;

export interface RunSuccessorSegmentDocument {
  readonly _id: string;
  readonly ownerAid: string;
  readonly runId: string;
  readonly segment: RunSuccessorSegment;
  readonly acceptedAt: Date;
}

interface ActivationPointerDocument {
  readonly _id: string;
  readonly ownerAid: string;
  readonly taskRevisionSaid: string;
  readonly harnessLineageId: string;
  readonly activeRevisionSaid: string;
  readonly version: number;
  readonly pendingCommandId?: string;
}

class ContinuationAborted extends Error {}

function rejected(): { readonly kind: 'Rejected' } {
  return { kind: 'Rejected' };
}

function duplicate(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11_000;
}

/** Snapshot/majority admission of one successor segment, replacement lease, and Genesis stream. */
export class MongoRunContinuations implements RunContinuationCommitments {
  readonly #client: MongoClient;
  readonly #runs: Collection<RunDocument>;
  readonly #tasks: Collection<TaskDocument>;
  readonly #streams: Collection<EvidenceStreamDocument>;
  readonly #events: Collection<EvidenceEventDocument>;
  readonly #checkpoints: Collection<EvidenceCheckpointDocument>;
  readonly #artifacts: Collection<EvidenceArtifactDocument>;
  readonly #segments: Collection<RunSuccessorSegmentDocument>;
  readonly #pointers: Collection<ActivationPointerDocument>;
  readonly #harnesses: Collection<HarnessDocument>;
  readonly #transitions: Collection<{ ownerAid: string; taskId: string }>;
  readonly #batches: Collection<{ evidenceStreamId: string }>;

  constructor(client: MongoClient, database: Db) {
    this.#client = client;
    this.#runs = database.collection(runsCollectionName);
    this.#tasks = database.collection(tasksCollectionName);
    this.#streams = database.collection(evidenceCollectionNames.streams);
    this.#events = database.collection(evidenceCollectionNames.events);
    this.#checkpoints = database.collection(evidenceCollectionNames.checkpoints);
    this.#artifacts = database.collection(evidenceCollectionNames.artifacts);
    this.#segments = database.collection(runSuccessorSegmentsCollectionName);
    this.#pointers = database.collection(activationCollectionNames.pointers);
    this.#harnesses = database.collection(harnessRevisionsCollectionName);
    this.#transitions = database.collection(activationCollectionNames.transitions);
    this.#batches = database.collection(evidenceCollectionNames.batches);
  }

  async admit(
    input: Parameters<RunContinuationCommitments['admit']>[0],
  ): ReturnType<RunContinuationCommitments['admit']> {
    try {
      return await this.#client.withSession((session) =>
        session.withTransaction(() => this.#admit(input, session), {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
        }),
      );
    } catch (error) {
      if (error instanceof ContinuationAborted || duplicate(error)) return rejected();
      return { kind: 'Unavailable' };
    }
  }

  async #admit(
    input: Parameters<RunContinuationCommitments['admit']>[0],
    session: ClientSession,
  ): ReturnType<RunContinuationCommitments['admit']> {
    const document = await this.#runs.findOne(
      { _id: input.run.binding.runId, ownerAid: input.ownerAid },
      { session },
    );
    if (document === null) return rejected();
    const run = decodeRunDocument(document).run;
    const existing = await this.#segments.findOne(
      {
        ownerAid: input.ownerAid,
        runId: run.binding.runId,
        'segment.successor.incarnationId': input.command.successorIncarnationId,
      },
      { session },
    );
    if (existing !== null) {
      const decoded = decodeRunSuccessorSegment(existing.segment);
      const exact =
        decoded.kind === 'Accepted' &&
        existing._id === decoded.segment.d &&
        decoded.segment.fromRunVersion === input.command.expectedRunVersion &&
        run.currentExecution?.segmentSaid === existing._id &&
        run.lease.kind === 'Held' &&
        run.lease.incarnationId === input.command.successorIncarnationId &&
        decoded.segment.predecessor.checkpointSaid === input.command.predecessorCheckpointSaid &&
        decoded.segment.predecessor.sealExchangeSaid === input.command.predecessorSealSaid &&
        decoded.segment.predecessor.chainHeadSaid === input.command.predecessorHeadSaid &&
        decoded.segment.successor.evidenceStreamId === input.command.successorStreamId &&
        (input.command.version === 2
          ? decoded.segment.version === 2 &&
            decoded.segment.baseline.harnessRevisionSaid ===
              input.command.expectedHarnessRevisionSaid
          : decoded.segment.version === 1 &&
            decoded.segment.activation.pointerVersion ===
              input.command.expectedActivePointerVersion &&
            decoded.segment.activation.decisionReceiptSaid ===
              input.command.expectedActivationReceiptSaid);
      if (!exact) return rejected();
      if (input.command.version === 2 && input.command.unstartedSuccessor !== undefined) {
        return this.#recoverUnstarted(input, document, run, decoded.segment, session);
      }
      return { kind: 'Equivalent', run, segment: decoded.segment };
    }
    if (input.command.version === 2 && input.command.unstartedSuccessor !== undefined)
      return rejected();

    if (
      run.version !== input.run.version ||
      run.version !== input.command.expectedRunVersion ||
      !isDeepStrictEqual(run.binding, input.run.binding) ||
      run.binding.ownerAid !== input.ownerAid ||
      (input.command.version === 2
        ? run.binding.purpose.kind !== 'PreparedCompatibilityCalibration'
        : run.binding.purpose.kind !== 'Retained')
    )
      return rejected();
    const pointer = await this.#pointers.findOne(
      { _id: run.binding.taskId, ownerAid: input.ownerAid },
      { session },
    );
    if (input.command.version === 2) {
      if (!(await this.#initialActivationMatches(input, run, pointer, session))) return rejected();
    } else if (
      pointer === null ||
      pointer.version !== input.activation.pointerVersion ||
      pointer.version !== input.command.expectedActivePointerVersion ||
      pointer.activeRevisionSaid !== input.activation.activeRevisionSaid ||
      pointer.taskRevisionSaid !== run.binding.taskRevisionSaid ||
      pointer.harnessLineageId !== run.binding.harnessLineageId ||
      input.activation.kind !== 'Committed' ||
      input.activation.decisionReceiptSaid !== input.command.expectedActivationReceiptSaid
    )
      return rejected();
    const predecessorStreamId =
      run.currentExecution?.evidenceStreamId ?? run.binding.evidenceStreamId;
    const streamDocument = await this.#streams.findOne({ _id: predecessorStreamId }, { session });
    const taskDocument = await this.#tasks.findOne(
      { _id: run.binding.taskId, ownerAid: input.ownerAid },
      { session },
    );
    if (streamDocument === null || taskDocument === null) return rejected();
    const stream = decodeEvidenceStreamDocument(streamDocument);
    if (stream.provisional.kind !== 'Checkpointed' || stream.cursor.kind !== 'Continued')
      return rejected();
    const checkpointDocument = await this.#checkpoints.findOne(
      {
        _id: input.command.predecessorCheckpointSaid,
        ownerAid: input.ownerAid,
        evidenceStreamId: predecessorStreamId,
      },
      { session },
    );
    if (checkpointDocument === null) return rejected();
    const task = decodeTaskDocument(taskDocument).task;
    if (
      task.lifecycle.kind !== 'Open' ||
      task.revisionSaid !== run.binding.taskRevisionSaid ||
      task.harnessLineageId !== run.binding.harnessLineageId ||
      Date.parse(task.revision.expiresAt) <= Date.parse(input.observedAt)
    )
      return rejected();
    const completionConditionIds = task.revision.completionConditions.map(
      (condition) => condition.id,
    );
    const checkpoint = decodeEvidenceCheckpointDocument(
      checkpointDocument,
      completionConditionIds,
    ).checkpoint;
    const eventDocuments = await this.#events
      .find(
        {
          ownerAid: input.ownerAid,
          runId: run.binding.runId,
          evidenceStreamId: predecessorStreamId,
        },
        { session },
      )
      .sort({ sequence: 1 })
      .toArray();
    const events = eventDocuments.map((event) => decodeEvidenceEventDocument(event).event);
    if (
      verifyContinuationPredecessor({
        run,
        stream,
        checkpoint,
        events,
        sealExchangeSaid: input.command.predecessorSealSaid,
        chainHeadSaid: input.command.predecessorHeadSaid,
        completionConditionIds,
      }) !== 'Verified'
    )
      return rejected();
    if (
      !(await this.#rawReferencesExist(
        run.binding.runId,
        input.ownerAid,
        events,
        checkpoint,
        session,
      ))
    )
      return rejected();
    const allStreams = await this.#streams
      .find({ 'binding.runId': run.binding.runId, 'binding.ownerAid': input.ownerAid }, { session })
      .toArray();
    const consumedBytes = allStreams.reduce((total, candidate) => {
      const decoded = decodeEvidenceStreamDocument(candidate);
      return total + decoded.acceptedEvidenceBytes + decoded.acceptedArtifactBytes;
    }, 0);
    const remainingBytes = run.binding.budget.evidencePlusArtifactsPerRunBytes - consumedBytes;
    if (!Number.isSafeInteger(remainingBytes) || remainingBytes <= 0) return rejected();
    const prepared = prepareRunSuccessorSegment({
      ...(input.command.version === 2
        ? {
            version: 2,
            kind: 'CalibrationContinuationSegment',
            baseline: {
              pointerVersion: 1,
              harnessRevisionSaid: input.activation.activeRevisionSaid,
            },
          }
        : {
            version: 1,
            kind: 'RunSuccessorSegment',
            activation:
              input.activation.kind === 'Committed'
                ? {
                    pointerVersion: input.activation.pointerVersion,
                    decisionReceiptSaid: input.activation.decisionReceiptSaid,
                  }
                : undefined,
          }),
      runId: run.binding.runId,
      taskId: run.binding.taskId,
      taskRevisionSaid: run.binding.taskRevisionSaid,
      ownerAid: run.binding.ownerAid,
      personalAgentAid: run.binding.personalAgentAid,
      taskMandateSaid: run.binding.taskMandateSaid,
      fromRunVersion: run.version,
      predecessor: {
        incarnationId: stream.binding.incarnationId,
        evidenceStreamId: predecessorStreamId,
        checkpointSaid: checkpoint.d,
        sealExchangeSaid: input.command.predecessorSealSaid,
        finalSequence: stream.cursor.acceptedThrough,
        chainHeadSaid: stream.cursor.chainHeadSaid,
      },
      successor: {
        incarnationId: input.command.successorIncarnationId,
        evidenceStreamId: input.command.successorStreamId,
        harnessRevisionSaid: input.activation.activeRevisionSaid,
      },
      consumedBudget: run.consumedBudget,
      admittedAt: input.observedAt,
    });
    if (prepared.kind !== 'Prepared') return rejected();
    const continuation = {
      expectedRunVersion: input.command.expectedRunVersion,
      serverTime: input.observedAt,
      predecessor: {
        incarnationId: stream.binding.incarnationId,
        evidenceStreamId: predecessorStreamId,
        checkpointSaid: checkpoint.d,
      },
      successor: {
        segmentSaid: prepared.segment.d,
        incarnationId: input.command.successorIncarnationId,
        evidenceStreamId: input.command.successorStreamId,
        harnessRevisionSaid: input.activation.activeRevisionSaid,
      },
      effects: 'Settled' as const,
    };
    const continued =
      input.command.version === 2
        ? continueCalibrationRun(run, {
            ...continuation,
            baseline: {
              pointerVersion: 1,
              harnessRevisionSaid: input.activation.activeRevisionSaid,
            },
          })
        : input.activation.kind === 'Committed'
          ? continueRun(run, {
              ...continuation,
              activation: {
                pointerVersion: input.activation.pointerVersion,
                activeRevisionSaid: input.activation.activeRevisionSaid,
                decisionReceiptSaid: input.activation.decisionReceiptSaid,
              },
            })
          : { kind: 'ActivationConflict' as const };
    if (continued.kind !== 'Admitted' || continued.run.lease.kind !== 'Held') return rejected();
    const newStream = createEvidenceStream({
      ...stream.binding,
      streamId: input.command.successorStreamId,
      incarnationId: input.command.successorIncarnationId,
      harnessRevisionSaid: input.activation.activeRevisionSaid,
      combinedByteCeiling: remainingBytes,
    });
    if (newStream.kind !== 'Created') return rejected();
    await this.#segments.insertOne(
      {
        _id: prepared.segment.d,
        ownerAid: input.ownerAid,
        runId: run.binding.runId,
        segment: prepared.segment,
        acceptedAt: new Date(input.observedAt),
      },
      { session },
    );
    await this.#streams.insertOne(encodeEvidenceStreamDocument(newStream.stream), { session });
    const replaced = await this.#runs.replaceOne(
      {
        _id: run.binding.runId,
        ownerAid: input.ownerAid,
        runVersion: run.version,
        'lease.kind': 'Held',
        'lease.incarnationId': stream.binding.incarnationId,
        $expr: {
          $and: [
            { $lte: [{ $toDate: '$lease.expiresAt' }, '$$NOW'] },
            { $gt: [new Date(continued.run.lease.expiresAt), '$$NOW'] },
          ],
        },
      },
      encodeRunDocument(continued.run, document.commandFingerprint),
      { session },
    );
    if (replaced.modifiedCount !== 1) throw new ContinuationAborted();
    return { kind: 'Admitted', run: continued.run, segment: prepared.segment };
  }

  async #initialActivationMatches(
    input: Parameters<RunContinuationCommitments['admit']>[0],
    run: Run,
    pointer: ActivationPointerDocument | null,
    session: ClientSession,
  ): Promise<boolean> {
    if (input.command.version !== 2) return false;
    if (
      input.activation.kind !== 'Initial' ||
      input.activation.taskId !== run.binding.taskId ||
      input.activation.taskRevisionSaid !== run.binding.taskRevisionSaid ||
      input.activation.harnessLineageId !== run.binding.harnessLineageId ||
      input.activation.activeRevisionSaid !== run.binding.initialHarnessRevisionSaid ||
      input.command.expectedHarnessRevisionSaid !== run.binding.initialHarnessRevisionSaid ||
      (pointer !== null &&
        (pointer.version !== 1 ||
          pointer.pendingCommandId !== undefined ||
          pointer.activeRevisionSaid !== run.binding.initialHarnessRevisionSaid ||
          pointer.taskRevisionSaid !== run.binding.taskRevisionSaid ||
          pointer.harnessLineageId !== run.binding.harnessLineageId)) ||
      (await this.#transitions.findOne(
        { ownerAid: input.ownerAid, taskId: run.binding.taskId },
        { session },
      )) !== null
    )
      return false;
    // Initial activation belongs to the accepted H1 record. A pointer is only
    // materialized by promotion; absence does not invalidate that activation.
    const initialHarnesses = await this.#harnesses
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
    const initial = initialHarnesses[0];
    if (initialHarnesses.length !== 1 || initial === undefined) return false;
    const accepted = decodeHarnessDocument(initial);
    if (
      initial._id !== run.binding.initialHarnessRevisionSaid ||
      initial.taskRevisionSaid !== run.binding.taskRevisionSaid ||
      initial.harnessLineageId !== run.binding.harnessLineageId ||
      !isDeepStrictEqual(accepted.activation, run.binding.initialSpecialization)
    )
      return false;
    return true;
  }

  async #recoverUnstarted(
    input: Parameters<RunContinuationCommitments['admit']>[0],
    document: RunDocument,
    run: Run,
    segment: RunSuccessorSegment,
    session: ClientSession,
  ): ReturnType<RunContinuationCommitments['admit']> {
    if (
      input.command.version !== 2 ||
      input.command.unstartedSuccessor === undefined ||
      segment.version !== 2 ||
      input.command.unstartedSuccessor.segmentSaid !== segment.d ||
      run.version !== input.run.version ||
      !isDeepStrictEqual(run.binding, input.run.binding) ||
      run.binding.purpose.kind !== 'PreparedCompatibilityCalibration' ||
      segment.runId !== run.binding.runId ||
      segment.ownerAid !== input.ownerAid ||
      segment.taskId !== run.binding.taskId ||
      segment.taskRevisionSaid !== run.binding.taskRevisionSaid ||
      segment.personalAgentAid !== run.binding.personalAgentAid ||
      segment.taskMandateSaid !== run.binding.taskMandateSaid ||
      run.currentExecution?.harnessRevisionSaid !== run.binding.initialHarnessRevisionSaid ||
      run.currentExecution.evidenceStreamId !== segment.successor.evidenceStreamId
    )
      return rejected();
    const pointer = await this.#pointers.findOne(
      { _id: run.binding.taskId, ownerAid: input.ownerAid },
      { session },
    );
    if (!(await this.#initialActivationMatches(input, run, pointer, session))) return rejected();
    const taskDocument = await this.#tasks.findOne(
      { _id: run.binding.taskId, ownerAid: input.ownerAid },
      { session },
    );
    if (taskDocument === null) return rejected();
    const task = decodeTaskDocument(taskDocument).task;
    if (
      task.lifecycle.kind !== 'Open' ||
      task.revisionSaid !== run.binding.taskRevisionSaid ||
      task.harnessLineageId !== run.binding.harnessLineageId ||
      Date.parse(task.revision.expiresAt) <= Date.parse(input.observedAt)
    )
      return rejected();
    const streamDocument = await this.#streams.findOne(
      { _id: segment.successor.evidenceStreamId },
      { session },
    );
    if (streamDocument === null) return rejected();
    const stream = decodeEvidenceStreamDocument(streamDocument);
    if (
      stream.version !== 0 ||
      stream.cursor.kind !== 'Genesis' ||
      stream.provisional.kind !== 'None' ||
      stream.seal.kind !== 'Open' ||
      stream.acceptedEvidenceBytes !== 0 ||
      stream.acceptedArtifactBytes !== 0 ||
      stream.binding.ownerAid !== input.ownerAid ||
      stream.binding.runId !== run.binding.runId ||
      stream.binding.incarnationId !== segment.successor.incarnationId ||
      stream.binding.taskId !== run.binding.taskId ||
      stream.binding.taskRevisionSaid !== run.binding.taskRevisionSaid ||
      stream.binding.harnessRevisionSaid !== run.binding.initialHarnessRevisionSaid ||
      stream.binding.personalAgentAid !== run.binding.personalAgentAid ||
      stream.binding.taskMandateSaid !== run.binding.taskMandateSaid
    )
      return rejected();
    const scope = { evidenceStreamId: segment.successor.evidenceStreamId };
    if (
      (await this.#events.findOne(scope, { session })) !== null ||
      (await this.#artifacts.findOne(scope, { session })) !== null ||
      (await this.#checkpoints.findOne(scope, { session })) !== null ||
      (await this.#batches.findOne(scope, { session })) !== null
    )
      return rejected();
    const recovered = recoverUnstartedRunContinuation(run, {
      ...input.command.unstartedSuccessor,
      incarnationId: segment.successor.incarnationId,
      evidenceStreamId: segment.successor.evidenceStreamId,
      consumedBudget: segment.consumedBudget,
      serverTime: input.observedAt,
      execution: 'NeverStarted',
    });
    if (recovered.kind === 'Rejected' || recovered.run.lease.kind !== 'Held') return rejected();
    if (recovered.kind === 'Equivalent') return { kind: 'Equivalent', run: recovered.run, segment };
    const replaced = await this.#runs.replaceOne(
      {
        _id: run.binding.runId,
        ownerAid: input.ownerAid,
        runVersion: run.version,
        'lease.kind': 'Held',
        'lease.incarnationId': segment.successor.incarnationId,
        'currentExecution.segmentSaid': segment.d,
        $expr: {
          $and: [
            { $lte: [{ $toDate: '$lease.expiresAt' }, '$$NOW'] },
            { $gt: [new Date(recovered.run.lease.expiresAt), '$$NOW'] },
          ],
        },
      },
      encodeRunDocument(recovered.run, document.commandFingerprint),
      { session },
    );
    if (replaced.modifiedCount !== 1) throw new ContinuationAborted();
    return { kind: 'Equivalent', run: recovered.run, segment };
  }

  async #rawReferencesExist(
    runId: string,
    ownerAid: string,
    events: readonly EvidenceEvent[],
    checkpoint: Parameters<typeof verifyContinuationPredecessor>[0]['checkpoint'],
    session: ClientSession,
  ): Promise<boolean> {
    const references = new Set<string>(checkpoint.outputArtifactSaids);
    for (const event of events)
      for (const said of evidenceArtifactReferences(event.event)) references.add(said);
    for (const receipt of checkpoint.verifierReceipts)
      if (receipt.outcome.kind === 'Accepted' || receipt.outcome.kind === 'Rejected')
        for (const said of receipt.outcome.outputArtifactSaids) references.add(said);
    for (const said of references) {
      const raw = await this.#artifacts.findOne(
        { runId, ownerAid, 'artifact.d': said },
        { session },
      );
      if (raw === null || decodeEvidenceArtifactDocument(raw).artifact.d !== said) return false;
    }
    return true;
  }
}
