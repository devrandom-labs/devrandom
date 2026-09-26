import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  decodeEvaluationEvidenceEvent,
  prepareEvidenceArtifact,
  type EvaluationEvidenceEvent,
} from '@devrandom/protocol';
import type { EvaluationEvidence, EvaluationRawArtifacts } from '@devrandom/runtime';
import type { ServerEvaluationHttp } from './server-evaluation-http.js';
import {
  evaluationArtifactReferences,
  type SqliteEvaluationEvidenceOutbox,
} from './sqlite-evaluation-evidence-outbox.js';

type Recording = Awaited<ReturnType<EvaluationEvidence['record']>>;
/** Durable local artifact and event custody followed by exact authenticated hosted delivery. */
export class SqliteHostedEvaluationEvidence implements EvaluationEvidence {
  readonly #outbox: SqliteEvaluationEvidenceOutbox;
  readonly #hosted: Pick<ServerEvaluationHttp, 'appendEvidence'>;
  readonly rawArtifacts: EvaluationRawArtifacts;
  constructor(
    outbox: SqliteEvaluationEvidenceOutbox,
    hosted: Pick<ServerEvaluationHttp, 'appendEvidence'>,
  ) {
    this.#outbox = outbox;
    this.#hosted = hosted;
    this.rawArtifacts = {
      record: (input) => {
        const prepared = prepareEvidenceArtifact(input.bytes, input.mediaType);
        if (prepared.kind !== 'Prepared') return Promise.resolve({ kind: 'TooLarge' });
        const retained = this.#outbox.retainPublicArtifact({
          artifact: prepared.artifact,
          bytes: input.bytes,
        });
        return Promise.resolve(
          retained.kind === 'Stored'
            ? { kind: 'Stored', artifact: prepared.artifact }
            : retained.kind === 'QuotaExceeded'
              ? { kind: 'TooLarge' }
              : retained.kind === 'Rejected'
                ? { kind: 'Rejected' }
                : { kind: 'Unavailable' },
        );
      },
    };
  }
  async record(event: EvaluationEvidenceEvent): Promise<Recording> {
    if (decodeEvaluationEvidenceEvent(event).kind !== 'Accepted') return { kind: 'Conflict' };
    try {
      const predecessor = event.previous.kind === 'Genesis' ? null : event.previous.eventSaid;
      const previous = this.#outbox.following(predecessor);
      if (previous.kind === 'Corrupt') return { kind: 'Unavailable' };
      if (previous.kind === 'Found') {
        if (
          previous.upload.events.length !== 1 ||
          !isDeepStrictEqual(previous.upload.events[0], event)
        )
          return { kind: 'Conflict' };
      } else {
        const position = this.#outbox.position();
        if (position.kind !== 'Position') return { kind: 'Unavailable' };
        if (position.nextSequence !== event.sequence || position.chainHeadSaid !== predecessor)
          return { kind: 'Gap' };
        const raw = this.#outbox.unstagedPublicArtifacts();
        if (raw.kind !== 'Found') return { kind: 'Unavailable' };
        const references = new Set(evaluationArtifactReferences(event));
        const artifacts = raw.artifacts.filter((item) => references.has(item.artifact.d));
        const staged = this.#outbox.stage({
          commandId: randomUUID(),
          fingerprint: `sha256:${createHash('sha256').update(JSON.stringify(event)).digest('hex')}`,
          events: [event],
          publicArtifacts: artifacts,
          protectedArtifacts: [],
        });
        if (staged.kind !== 'Staged' && staged.kind !== 'AlreadyStaged')
          return staged.kind === 'QuotaExceeded'
            ? { kind: 'QuotaExceeded' }
            : staged.kind === 'Conflict'
              ? { kind: 'Conflict' }
              : { kind: 'Unavailable' };
      }
      const flushed = await this.flush();
      if (flushed.kind !== 'Acknowledged') return flushed;
      const recorded = this.#outbox.following(predecessor);
      if (
        recorded.kind !== 'Found' ||
        recorded.acknowledgement === null ||
        recorded.acknowledgement.chainHeadSaid !== event.d
      )
        return { kind: 'Unavailable' };
      return { kind: 'Recorded', sequence: event.sequence, headSaid: event.d };
    } catch {
      return { kind: 'Unavailable' };
    }
  }
  async flush(): Promise<
    | { readonly kind: 'Acknowledged' }
    | Extract<Recording, { kind: 'Conflict' | 'Gap' | 'QuotaExceeded' | 'Unavailable' }>
  > {
    try {
      for (let attempt = 0; attempt < 10000; attempt++) {
        const pending = this.#outbox.pending();
        if (pending.kind === 'Empty') return { kind: 'Acknowledged' };
        if (pending.kind !== 'Pending') return { kind: 'Unavailable' };
        const delivered = await this.#hosted.appendEvidence(pending.upload);
        if (delivered.kind !== 'Acknowledged')
          return delivered.kind === 'Conflict'
            ? { kind: 'Conflict' }
            : delivered.kind === 'QuotaExceeded'
              ? { kind: 'QuotaExceeded' }
              : { kind: 'Unavailable' };
        const receipt = this.#outbox.acknowledge(delivered.acknowledgement);
        if (receipt.kind !== 'Recorded' && receipt.kind !== 'AlreadyRecorded')
          return { kind: 'Conflict' };
      }
      return { kind: 'Unavailable' };
    } catch {
      return { kind: 'Unavailable' };
    }
  }
  async acknowledge(
    input: Parameters<EvaluationEvidence['acknowledge']>[0],
  ): ReturnType<EvaluationEvidence['acknowledge']> {
    const flushed = await this.flush();
    if (flushed.kind !== 'Acknowledged')
      return flushed.kind === 'QuotaExceeded' ? { kind: 'Unavailable' } : { kind: flushed.kind };
    const position = this.#outbox.position();
    if (position.kind !== 'Position') return { kind: 'Unavailable' };
    if (
      position.acknowledgedSequence !== input.throughSequence ||
      position.acknowledgedHeadSaid !== input.expectedHeadSaid ||
      input.fromSequence < 0 ||
      input.fromSequence > input.throughSequence
    )
      return { kind: 'Conflict' };
    // Resolve the exact acknowledged upload, rather than accepting a foreign id with
    // a coincidentally matching numeric cursor.
    let predecessor: string | null = null;
    for (let index = 0; index <= input.throughSequence; index++) {
      const next = this.#outbox.following(predecessor);
      if (next.kind !== 'Found' || next.acknowledgement === null) return { kind: 'Gap' };
      if (
        next.upload.batch.evaluationId !== input.evaluationId ||
        next.upload.batch.streamId !== input.streamId
      )
        return { kind: 'Conflict' };
      if (next.acknowledgement.chainHeadSaid === input.expectedHeadSaid)
        return {
          kind: 'Acknowledged',
          throughSequence: input.throughSequence,
          headSaid: input.expectedHeadSaid,
        };
      predecessor = next.acknowledgement.chainHeadSaid;
    }
    return { kind: 'Gap' };
  }
}
