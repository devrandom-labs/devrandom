import type { Collection, Db } from 'mongodb';
import { decodeRunSuccessorSegment } from '@devrandom/protocol';
import type { RunSuccessorSegments } from '../application/run-successor-segments.js';
import {
  runSuccessorSegmentsCollectionName,
  type RunSuccessorSegmentDocument,
} from './mongo-run-continuations.js';

export class MongoRunSuccessorSegments implements RunSuccessorSegments {
  readonly #segments: Collection<RunSuccessorSegmentDocument>;

  constructor(database: Db) {
    this.#segments = database.collection(runSuccessorSegmentsCollectionName);
  }

  async read(
    input: Parameters<RunSuccessorSegments['read']>[0],
  ): ReturnType<RunSuccessorSegments['read']> {
    try {
      const document = await this.#segments.findOne({
        _id: input.segmentSaid,
        ownerAid: input.ownerAid,
        runId: input.runId,
      });
      if (document === null) return { kind: 'NotFound' };
      const decoded = decodeRunSuccessorSegment(document.segment);
      if (
        decoded.kind !== 'Accepted' ||
        decoded.segment.d !== input.segmentSaid ||
        decoded.segment.ownerAid !== input.ownerAid ||
        decoded.segment.runId !== input.runId
      )
        return { kind: 'Unavailable' };
      return { kind: 'Found', segment: decoded.segment };
    } catch {
      return { kind: 'Unavailable' };
    }
  }
}
