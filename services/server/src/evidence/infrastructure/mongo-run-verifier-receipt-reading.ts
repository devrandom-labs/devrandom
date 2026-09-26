import type { Collection, Db } from 'mongodb';

import { decodePublicVerifierReceipt } from '@devrandom/protocol';

import type { RunVerifierReceiptReading } from '../application/read-run-verifier-receipt.js';
import { evidenceCheckpointBelongsToRun } from '../domain/run-binding.js';
import { runsCollectionName } from '../../run/infrastructure/mongo-runs.js';
import { decodeRunDocument, type RunDocument } from '../../run/infrastructure/run-document.js';
import { tasksCollectionName } from '../../task/infrastructure/mongo-tasks.js';
import { decodeTaskDocument, type TaskDocument } from '../../task/infrastructure/task-document.js';
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
  type EvidenceStreamDocument,
} from './evidence-stream-document.js';

/** The receipt is a checkpoint document member, never a raw EvidenceArtifact. */
export class MongoRunVerifierReceiptReading implements RunVerifierReceiptReading {
  readonly #runs: Collection<RunDocument>;
  readonly #tasks: Collection<TaskDocument>;
  readonly #streams: Collection<EvidenceStreamDocument>;
  readonly #checkpoints: Collection<EvidenceCheckpointDocument>;
  readonly #events: Collection<EvidenceEventDocument>;

  constructor(database: Db) {
    this.#runs = database.collection(runsCollectionName);
    this.#tasks = database.collection(tasksCollectionName);
    this.#streams = database.collection(evidenceCollectionNames.streams);
    this.#checkpoints = database.collection(evidenceCollectionNames.checkpoints);
    this.#events = database.collection(evidenceCollectionNames.events);
  }

  async read(input: Parameters<RunVerifierReceiptReading['read']>[0]) {
    try {
      const runDocument = await this.#runs.findOne({ _id: input.runId, ownerAid: input.ownerAid });
      if (runDocument === null) return { kind: 'NotFound' } as const;
      const run = decodeRunDocument(runDocument).run;
      if (run.binding.runId !== input.runId || run.binding.ownerAid !== input.ownerAid)
        return { kind: 'Unavailable' } as const;
      const checkpointSaid =
        run.lifecycle.kind === 'Active'
          ? run.lifecycle.phase.kind === 'Blocked'
            ? run.lifecycle.phase.checkpointSaid
            : undefined
          : run.lifecycle.outcome.checkpointSaid;
      if (checkpointSaid === undefined) return { kind: 'NotFound' } as const;
      const taskDocument = await this.#tasks.findOne({
        _id: run.binding.taskId,
        ownerAid: input.ownerAid,
      });
      if (taskDocument === null) return { kind: 'NotFound' } as const;
      const task = decodeTaskDocument(taskDocument).task;
      if (task.revisionSaid !== run.binding.taskRevisionSaid)
        return { kind: 'Unavailable' } as const;
      const streamDocument = await this.#streams.findOne({
        _id: run.binding.evidenceStreamId,
        'binding.ownerAid': input.ownerAid,
        'binding.runId': input.runId,
      });
      if (streamDocument === null) return { kind: 'NotFound' } as const;
      const stream = decodeEvidenceStreamDocument(streamDocument);
      if (
        stream.binding.streamId !== run.binding.evidenceStreamId ||
        stream.binding.taskId !== run.binding.taskId ||
        stream.binding.taskRevisionSaid !== run.binding.taskRevisionSaid ||
        stream.binding.personalAgentAid !== run.binding.personalAgentAid ||
        stream.binding.taskMandateSaid !== run.binding.taskMandateSaid ||
        stream.seal.kind !== 'Sealed' ||
        stream.cursor.kind !== 'Continued' ||
        stream.provisional.kind !== 'Checkpointed' ||
        stream.provisional.checkpointSaid !== checkpointSaid
      )
        return { kind: 'Unavailable' } as const;
      const checkpointDocument = await this.#checkpoints.findOne({
        _id: checkpointSaid,
        ownerAid: input.ownerAid,
        runId: input.runId,
        evidenceStreamId: stream.binding.streamId,
      });
      if (checkpointDocument === null) return { kind: 'NotFound' } as const;
      const checkpoint = decodeEvidenceCheckpointDocument(
        checkpointDocument,
        task.revision.completionConditions.map((condition) => condition.id),
      ).checkpoint;
      if (
        checkpoint.d !== checkpointSaid ||
        !evidenceCheckpointBelongsToRun(checkpoint, run) ||
        checkpoint.evidence.eventCount > stream.cursor.acceptedThrough + 1
      )
        return { kind: 'Unavailable' } as const;
      const checkpointHeadDocument = await this.#events.findOne({
        ownerAid: input.ownerAid,
        runId: input.runId,
        evidenceStreamId: stream.binding.streamId,
        sequence: checkpoint.evidence.finalSequence,
      });
      if (checkpointHeadDocument === null) return { kind: 'NotFound' } as const;
      const checkpointHead = decodeEvidenceEventDocument(checkpointHeadDocument).event;
      if (checkpointHead.d !== checkpoint.evidence.chainHeadSaid)
        return { kind: 'Unavailable' } as const;
      const receipt = checkpoint.verifierReceipts.find((item) => item.d === input.receiptSaid);
      if (receipt === undefined) return { kind: 'NotFound' } as const;
      if (decodePublicVerifierReceipt(receipt).kind !== 'Accepted')
        return { kind: 'Unavailable' } as const;
      const eventDocument = await this.#events.findOne({
        ownerAid: input.ownerAid,
        runId: input.runId,
        evidenceStreamId: stream.binding.streamId,
        'event.event.kind': 'FailureObserved',
        'event.event.receiptSaid': input.receiptSaid,
        sequence: { $lte: checkpoint.evidence.finalSequence },
      });
      if (eventDocument === null) return { kind: 'NotFound' } as const;
      const event = decodeEvidenceEventDocument(eventDocument).event;
      if (
        event.runId !== input.runId ||
        event.taskId !== run.binding.taskId ||
        event.taskRevisionSaid !== run.binding.taskRevisionSaid ||
        event.incarnationId !== checkpoint.incarnationId ||
        event.event.kind !== 'FailureObserved' ||
        event.event.failure !== 'HarnessCompatibilityFailure' ||
        event.event.receiptSaid !== input.receiptSaid
      )
        return { kind: 'Unavailable' } as const;
      return {
        kind: 'Read',
        runId: input.runId,
        evidenceStreamId: stream.binding.streamId,
        checkpointSaid,
        receipt,
      } as const;
    } catch {
      return { kind: 'Unavailable' } as const;
    }
  }
}
