import { isDeepStrictEqual } from 'node:util';

import {
  MongoServerError,
  type ClientSession,
  type Collection,
  type Db,
  type MongoClient,
} from 'mongodb';

import { admitEvidenceArtifact } from '@devrandom/domain';

import type {
  EvidenceArtifactAdmission,
  EvidenceArtifactAdmissionInput,
  EvidenceArtifacts,
} from '../application/evidence-artifacts.js';
import { runsCollectionName } from '../../run/infrastructure/mongo-runs.js';
import { decodeRunDocument, type RunDocument } from '../../run/infrastructure/run-document.js';
import {
  decodeEvidenceArtifactDocument,
  encodeEvidenceArtifactDocument,
  type EvidenceArtifactDocument,
} from './evidence-artifact-document.js';
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

class EvidenceArtifactAdmissionAborted extends Error {
  readonly outcome: EvidenceArtifactAdmission;

  constructor(outcome: EvidenceArtifactAdmission) {
    super(outcome.kind);
    this.name = 'EvidenceArtifactAdmissionAborted';
    this.outcome = outcome;
  }
}

export class MongoEvidenceArtifacts implements EvidenceArtifacts {
  readonly #client: MongoClient;
  readonly #runs: Collection<RunDocument>;
  readonly #streams: Collection<EvidenceStreamDocument>;
  readonly #artifacts: Collection<EvidenceArtifactDocument>;
  readonly #usage: Collection<EvidenceUsageDocument>;

  constructor(client: MongoClient, database: Db) {
    this.#client = client;
    this.#runs = database.collection<RunDocument>(runsCollectionName);
    this.#streams = database.collection<EvidenceStreamDocument>(evidenceCollectionNames.streams);
    this.#artifacts = database.collection<EvidenceArtifactDocument>(
      evidenceCollectionNames.artifacts,
    );
    this.#usage = database.collection<EvidenceUsageDocument>(evidenceCollectionNames.usage);
  }

  async admit(input: EvidenceArtifactAdmissionInput): Promise<EvidenceArtifactAdmission> {
    try {
      return await this.#client.withSession((session) =>
        session.withTransaction(() => this.#commit(input, session), {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
        }),
      );
    } catch (error) {
      if (error instanceof EvidenceArtifactAdmissionAborted) {
        return error.outcome;
      }
      if (duplicateKey(error)) {
        return this.#reconcile(input);
      }
      return { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' };
    }
  }

  async #commit(
    input: EvidenceArtifactAdmissionInput,
    session: ClientSession,
  ): Promise<EvidenceArtifactAdmission> {
    const existing = await this.#artifacts.findOne(
      { runId: input.runId, 'artifact.d': input.artifact.d },
      { session },
    );
    if (existing !== null) {
      return this.#existing(input, existing);
    }
    const runDocument = await this.#runs.findOne(
      { _id: input.runId, ownerAid: input.ownerAid },
      { session },
    );
    if (runDocument === null) {
      return { kind: 'EvidenceRunNotFound' };
    }
    const run = decodeRunDocument(runDocument).run;
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
    if (stream === undefined || stream.binding.runId !== input.runId) {
      return { kind: 'EvidenceArtifactRejected', reason: 'RunBindingMismatch' };
    }
    const admission = admitEvidenceArtifact(stream, { byteLength: input.bytes.byteLength });
    switch (admission.kind) {
      case 'StreamSealed':
        return { kind: 'EvidenceStreamSealed' };
      case 'ArtifactLimitExceeded':
        return { kind: 'EvidenceArtifactConflict' };
      case 'RunByteBudgetExhausted':
        return { kind: 'RunEvidenceQuotaExceeded' };
      case 'Admitted':
        break;
    }
    const usageDocument = await this.#usage.findOne({ _id: evidenceUsageDocumentId }, { session });
    const usage = decodeEvidenceUsageDocument(usageDocument);
    const globalCeiling = run.binding.budget.acceptedEvidencePlusArtifactsGloballyBytes;
    if (usage.acceptedBytes + input.bytes.byteLength > globalCeiling) {
      return { kind: 'GlobalEvidenceQuotaExceeded' };
    }
    const usageUpdate = await this.#usage.updateOne(
      { _id: evidenceUsageDocumentId, version: usage.version },
      { $inc: { version: 1, acceptedBytes: input.bytes.byteLength } },
      { session },
    );
    if (usageUpdate.modifiedCount !== 1) {
      throw new EvidenceArtifactAdmissionAborted({ kind: 'EvidenceCursorConcurrentUpdate' });
    }
    const nextStream = encodeEvidenceStreamDocument(admission.stream);
    if (streamDocument === null) {
      await this.#streams.insertOne(nextStream, { session });
    } else {
      const streamUpdate = await this.#streams.replaceOne(
        { _id: stream.binding.streamId, version: stream.version },
        nextStream,
        { session },
      );
      if (streamUpdate.modifiedCount !== 1) {
        throw new EvidenceArtifactAdmissionAborted({ kind: 'EvidenceCursorConcurrentUpdate' });
      }
    }
    await this.#artifacts.insertOne(
      encodeEvidenceArtifactDocument({
        ownerAid: input.ownerAid,
        runId: input.runId,
        evidenceStreamId: run.currentExecution?.evidenceStreamId ?? run.binding.evidenceStreamId,
        artifact: input.artifact,
        bytes: input.bytes,
        acceptedAt: input.receivedAt,
      }),
      { session },
    );
    return {
      kind: 'EvidenceArtifactStored',
      acknowledgement: {
        version: 1,
        disposition: 'Stored',
        runId: input.runId,
        artifact: input.artifact,
        receivedAt: input.receivedAt,
      },
    };
  }

  #existing(
    input: EvidenceArtifactAdmissionInput,
    document: EvidenceArtifactDocument,
  ): EvidenceArtifactAdmission {
    const accepted = decodeEvidenceArtifactDocument(document);
    if (
      accepted.ownerAid !== input.ownerAid ||
      accepted.runId !== input.runId ||
      !isDeepStrictEqual(accepted.artifact, input.artifact) ||
      !isDeepStrictEqual(accepted.bytes, input.bytes)
    ) {
      return { kind: 'EvidenceArtifactConflict' };
    }
    return {
      kind: 'EvidenceArtifactAlreadyStored',
      acknowledgement: {
        version: 1,
        disposition: 'AlreadyStored',
        runId: accepted.runId,
        artifact: accepted.artifact,
        receivedAt: accepted.acceptedAt,
      },
    };
  }

  async #reconcile(input: EvidenceArtifactAdmissionInput): Promise<EvidenceArtifactAdmission> {
    try {
      const existing = await this.#artifacts.findOne({
        runId: input.runId,
        'artifact.d': input.artifact.d,
      });
      return existing === null
        ? { kind: 'EvidenceCursorConcurrentUpdate' }
        : this.#existing(input, existing);
    } catch {
      return { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' };
    }
  }
}
