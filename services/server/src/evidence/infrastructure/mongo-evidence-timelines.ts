import type { Collection, Db, Filter } from 'mongodb';

import type { AcceptedEvidenceEventProjection } from '@devrandom/protocol';

import type { EvidenceTimelines } from '../application/evidence-timelines.js';
import { runsCollectionName } from '../../run/infrastructure/mongo-runs.js';
import { decodeRunDocument, type RunDocument } from '../../run/infrastructure/run-document.js';
import {
  decodeEvidenceEventDocument,
  type EvidenceEventDocument,
} from './evidence-event-document.js';
import { evidenceCollectionNames } from './evidence-storage-contract.js';
import {
  decodeEvidenceStreamDocument,
  type EvidenceStreamDocument,
} from './evidence-stream-document.js';

const maximumBufferedProjectionBytes = 1_000_000;

export class MongoEvidenceTimelines implements EvidenceTimelines {
  readonly #runs: Collection<RunDocument>;
  readonly #streams: Collection<EvidenceStreamDocument>;
  readonly #events: Collection<EvidenceEventDocument>;

  constructor(database: Db) {
    this.#runs = database.collection<RunDocument>(runsCollectionName);
    this.#streams = database.collection<EvidenceStreamDocument>(evidenceCollectionNames.streams);
    this.#events = database.collection<EvidenceEventDocument>(evidenceCollectionNames.events);
  }

  async read(input: {
    readonly ownerAid: string;
    readonly runId: string;
    readonly limit: number;
    readonly afterSequence: number | null;
  }) {
    try {
      const runDocument = await this.#runs.findOne({ _id: input.runId, ownerAid: input.ownerAid });
      if (runDocument === null) {
        return { kind: 'EvidenceRunNotFound' } as const;
      }
      const run = decodeRunDocument(runDocument).run;
      const streamDocument = await this.#streams.findOne({
        _id: run.binding.evidenceStreamId,
        'binding.ownerAid': input.ownerAid,
      });
      if (streamDocument === null) {
        return {
          kind: 'EvidenceTimelineNotStarted',
          runId: run.binding.runId,
          evidenceStreamId: run.binding.evidenceStreamId,
        } as const;
      }
      const stream = decodeEvidenceStreamDocument(streamDocument);
      if (stream.binding.runId !== input.runId) {
        return { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' } as const;
      }
      const filter: Filter<EvidenceEventDocument> = {
        ownerAid: input.ownerAid,
        runId: input.runId,
        evidenceStreamId: stream.binding.streamId,
        ...(input.afterSequence === null ? {} : { sequence: { $gt: input.afterSequence } }),
      };
      const cursor = this.#events
        .find(filter)
        .sort({ sequence: 1 })
        .limit(input.limit + 1);
      const events: AcceptedEvidenceEventProjection[] = [];
      let projectedBytes = 0;
      let hasMore = false;
      try {
        for await (const document of cursor) {
          const accepted = decodeEvidenceEventDocument(document);
          const projection: AcceptedEvidenceEventProjection = {
            version: 1,
            event: accepted.event,
            receivedAt: accepted.receivedAt,
          };
          const nextBytes = new TextEncoder().encode(JSON.stringify(projection)).byteLength;
          if (
            events.length >= input.limit ||
            projectedBytes + nextBytes > maximumBufferedProjectionBytes
          ) {
            hasMore = true;
            break;
          }
          events.push(projection);
          projectedBytes += nextBytes;
        }
      } finally {
        await cursor.close();
      }
      return { kind: 'EvidenceTimelineRead', stream, events, hasMore } as const;
    } catch {
      return { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' } as const;
    }
  }
}
