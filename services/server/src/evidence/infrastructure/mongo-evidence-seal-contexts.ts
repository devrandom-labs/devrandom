import type { Collection, Db } from 'mongodb';

import type { EvidenceSealContexts } from '../application/evidence-seals.js';
import { runsCollectionName } from '../../run/infrastructure/mongo-runs.js';
import { decodeRunDocument, type RunDocument } from '../../run/infrastructure/run-document.js';
import { evidenceCollectionNames } from './evidence-storage-contract.js';
import {
  decodeEvidenceStreamDocument,
  type EvidenceStreamDocument,
} from './evidence-stream-document.js';
import { initialEvidenceStream } from './evidence-stream-binding.js';

export class MongoEvidenceSealContexts implements EvidenceSealContexts {
  readonly #runs: Collection<RunDocument>;
  readonly #streams: Collection<EvidenceStreamDocument>;

  constructor(database: Db) {
    this.#runs = database.collection<RunDocument>(runsCollectionName);
    this.#streams = database.collection<EvidenceStreamDocument>(evidenceCollectionNames.streams);
  }

  async inspect(input: { readonly ownerAid: string; readonly runId: string }) {
    try {
      const runDocument = await this.#runs.findOne({ _id: input.runId, ownerAid: input.ownerAid });
      if (runDocument === null) {
        return { kind: 'EvidenceRunNotFound' } as const;
      }
      const run = decodeRunDocument(runDocument).run;
      const document = await this.#streams.findOne({
        _id: run.binding.evidenceStreamId,
        'binding.ownerAid': input.ownerAid,
      });
      const stream =
        document === null ? initialEvidenceStream(run) : decodeEvidenceStreamDocument(document);
      return stream === undefined || stream.binding.runId !== run.binding.runId
        ? ({ kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' } as const)
        : ({ kind: 'EvidenceSealContextFound', run, stream } as const);
    } catch {
      return { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' } as const;
    }
  }
}
