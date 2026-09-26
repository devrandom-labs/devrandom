import type { Collection, Db } from 'mongodb';

import type { RunArtifactReading } from '../application/read-run-artifact.js';
import { runsCollectionName } from '../../run/infrastructure/mongo-runs.js';
import { decodeRunDocument, type RunDocument } from '../../run/infrastructure/run-document.js';
import {
  decodeEvidenceArtifactDocument,
  evidenceArtifactDocumentId,
  type EvidenceArtifactDocument,
} from './evidence-artifact-document.js';
import { evidenceCollectionNames } from './evidence-storage-contract.js';
import {
  decodeEvidenceStreamDocument,
  type EvidenceStreamDocument,
} from './evidence-stream-document.js';

/** Reads only an artifact bound to the requested owner's current Run and evidence stream. */
export class MongoRunArtifactReading implements RunArtifactReading {
  readonly #runs: Collection<RunDocument>;
  readonly #streams: Collection<EvidenceStreamDocument>;
  readonly #artifacts: Collection<EvidenceArtifactDocument>;

  constructor(database: Db) {
    this.#runs = database.collection(runsCollectionName);
    this.#streams = database.collection(evidenceCollectionNames.streams);
    this.#artifacts = database.collection(evidenceCollectionNames.artifacts);
  }

  async read(input: Parameters<RunArtifactReading['read']>[0]) {
    try {
      const locatedRun = await this.#runs.findOne({ _id: input.runId, ownerAid: input.ownerAid });
      if (locatedRun === null) return { kind: 'NotFound' } as const;
      const run = decodeRunDocument(locatedRun).run;
      if (run.binding.runId !== input.runId || run.binding.ownerAid !== input.ownerAid)
        return { kind: 'Unavailable' } as const;
      const locatedStream = await this.#streams.findOne({
        _id: run.binding.evidenceStreamId,
        'binding.runId': input.runId,
        'binding.ownerAid': input.ownerAid,
      });
      if (locatedStream === null) return { kind: 'NotFound' } as const;
      const stream = decodeEvidenceStreamDocument(locatedStream);
      if (
        stream.binding.streamId !== run.binding.evidenceStreamId ||
        stream.binding.runId !== input.runId ||
        stream.binding.ownerAid !== input.ownerAid ||
        stream.binding.taskId !== run.binding.taskId ||
        stream.binding.taskRevisionSaid !== run.binding.taskRevisionSaid ||
        stream.binding.personalAgentAid !== run.binding.personalAgentAid ||
        stream.binding.taskMandateSaid !== run.binding.taskMandateSaid
      )
        return { kind: 'Unavailable' } as const;
      const locatedArtifact = await this.#artifacts.findOne({
        _id: evidenceArtifactDocumentId(input.runId, input.artifactSaid),
        ownerAid: input.ownerAid,
        runId: input.runId,
        evidenceStreamId: stream.binding.streamId,
        'artifact.d': input.artifactSaid,
      });
      if (locatedArtifact === null) return { kind: 'NotFound' } as const;
      const raw = decodeEvidenceArtifactDocument(locatedArtifact);
      if (
        raw.ownerAid !== input.ownerAid ||
        raw.runId !== input.runId ||
        raw.evidenceStreamId !== stream.binding.streamId ||
        raw.artifact.d !== input.artifactSaid
      )
        return { kind: 'Unavailable' } as const;
      return { kind: 'Read', artifact: raw.artifact, bytes: raw.bytes } as const;
    } catch {
      return { kind: 'Unavailable' } as const;
    }
  }
}
