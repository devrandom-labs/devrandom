import { validateExecutionBinding, type EvaluationExecutionBinding } from '@devrandom/domain';
import {
  decodeEvidenceArtifact,
  decodeEvaluationEvidenceEvent,
  type EvidenceArtifact,
  type EvaluationEvidenceEvent,
} from '@devrandom/protocol';

import type { ServerEvaluationHttp } from './server-evaluation-http.js';

type ReadingHttp = Pick<ServerEvaluationHttp, 'readEvidencePage' | 'readPublicArtifact'>;

const maximumCachedBytes = 8 * 1024 * 1024;
const maximumCachedArtifacts = 128;

/**
 * Immutable read acceleration, never current permission or position evidence.
 * Callers must still check hosted authority, lease, position and manifest afresh.
 * Retain this reader within one evaluation operation; no process-global cache.
 */
export class HostedEvaluationEvidenceReading {
  readonly #http: ReadingHttp;
  #prefix: { scope: string; events: readonly EvaluationEvidenceEvent[] } | undefined;
  readonly #artifacts = new Map<string, { artifact: EvidenceArtifact; bytes: Uint8Array }>();
  #artifactBytes = 0;

  constructor(http: ReadingHttp) {
    this.#http = http;
  }

  async openPrefix(input: {
    readonly binding: EvaluationExecutionBinding;
    readonly throughSequence: number;
    readonly headSaid: string;
  }): Promise<
    | {
        readonly kind: 'Acknowledged';
        readonly events: readonly EvaluationEvidenceEvent[];
        readonly throughSequence: number;
        readonly headSaid: string;
      }
    | { readonly kind: 'Missing' | 'Unavailable' }
  > {
    const { binding, throughSequence, headSaid } = input;
    if (
      validateExecutionBinding(binding).kind !== 'Accepted' ||
      !Number.isSafeInteger(throughSequence) ||
      throughSequence < 0 ||
      throughSequence > 9_999 ||
      !/^[A-Z][A-Za-z0-9_-]{43}$/u.test(headSaid)
    )
      return { kind: 'Missing' };
    // Phase/revision may change along a stream; they are checked against the exact
    // requested head below. All other execution identities bind prefix reuse.
    const scope = JSON.stringify([
      binding.evaluationId,
      binding.evidenceStreamId,
      binding.evaluationLeaseId,
      binding.originRunId,
      binding.taskId,
      binding.taskRevisionSaid,
      binding.personalAgentAid,
      binding.taskMandateSaid,
    ]);
    const cached = this.#prefix?.scope === scope ? this.#prefix.events : [];
    if (cached[throughSequence] !== undefined && cached[throughSequence].d !== headSaid)
      return { kind: 'Missing' };
    const events: EvaluationEvidenceEvent[] = cached.slice(0, throughSequence + 1);
    while (events.length <= throughSequence) {
      const afterSequence = events.length - 1;
      const page = await this.#http.readEvidencePage({
        evaluationId: binding.evaluationId,
        afterSequence,
        throughSequence,
        throughHeadSaid: headSaid,
      });
      if (page.kind === 'Unavailable') return { kind: 'Unavailable' };
      if (page.kind !== 'Read') return { kind: 'Missing' };
      if (
        page.page.evaluationId !== binding.evaluationId ||
        page.page.afterSequence !== afterSequence ||
        page.page.throughSequence !== throughSequence ||
        page.page.throughHeadSaid !== headSaid ||
        page.page.streamId !== binding.evidenceStreamId ||
        page.page.events.length !== Math.min(32, throughSequence - afterSequence)
      )
        return { kind: 'Missing' };
      for (const event of page.page.events) {
        const predecessor = events.at(-1);
        if (
          decodeEvaluationEvidenceEvent(event).kind !== 'Accepted' ||
          event.sequence !== events.length ||
          event.evaluationId !== binding.evaluationId ||
          event.streamId !== binding.evidenceStreamId ||
          event.originRunId !== binding.originRunId ||
          event.taskId !== binding.taskId ||
          event.taskRevisionSaid !== binding.taskRevisionSaid ||
          event.personalAgentAid !== binding.personalAgentAid ||
          event.taskMandateSaid !== binding.taskMandateSaid ||
          (predecessor === undefined
            ? event.previous.kind !== 'Genesis'
            : event.previous.kind !== 'Previous' || event.previous.eventSaid !== predecessor.d)
        )
          return { kind: 'Missing' };
        events.push(structuredClone(event));
      }
    }
    const head = events.at(-1);
    if (
      head?.d !== headSaid ||
      head.sequence !== throughSequence ||
      head.harnessRevisionSaid !== binding.harnessRevisionSaid ||
      JSON.stringify(head.phase) !== JSON.stringify(binding.phase)
    )
      return { kind: 'Missing' };
    // Only a complete content-verified, hosted-acknowledged chain is reusable.
    // One scope, at most 10,000 events (input bound), and 8 MiB encoded content.
    // Historical exact reads do not move the retained watermark backwards.
    if (
      events.length > cached.length &&
      Buffer.byteLength(JSON.stringify(events)) <= maximumCachedBytes
    ) {
      const current = this.#prefix?.scope === scope ? this.#prefix.events : [];
      const overlap = Math.min(current.length, events.length) - 1;
      if (overlap >= 0 && current[overlap]?.d !== events[overlap]?.d) return { kind: 'Missing' };
      if (events.length > current.length) this.#prefix = { scope, events };
    }
    return { kind: 'Acknowledged', events: structuredClone(events), throughSequence, headSaid };
  }

  async openPublic(input: {
    readonly evaluationId: string;
    readonly artifactSaid: string;
  }): Promise<
    | { readonly kind: 'Opened'; readonly artifact: EvidenceArtifact; readonly bytes: Uint8Array }
    | { readonly kind: 'Missing' | 'Unavailable' }
  > {
    const key = JSON.stringify([input.evaluationId, input.artifactSaid]);
    const cached = this.#artifacts.get(key);
    if (cached !== undefined) {
      this.#artifacts.delete(key);
      this.#artifacts.set(key, cached);
      return { kind: 'Opened', ...structuredClone(cached) };
    }
    const opened = await this.#http.readPublicArtifact(input);
    if (opened.kind === 'Unavailable') return { kind: 'Unavailable' };
    if (
      opened.kind !== 'Read' ||
      opened.artifact.d !== input.artifactSaid ||
      decodeEvidenceArtifact(opened.artifact, opened.bytes).kind !== 'Accepted'
    )
      return { kind: 'Missing' };
    const content = structuredClone({ artifact: opened.artifact, bytes: opened.bytes });
    // Count and raw-byte bounds also cover zero-byte artifacts. Artifact metadata
    // is bounded by decodeEvidenceArtifact. Concurrent misses replace one entry.
    const previous = this.#artifacts.get(key);
    if (previous !== undefined) this.#artifactBytes -= previous.bytes.byteLength;
    this.#artifacts.delete(key);
    this.#artifacts.set(key, content);
    this.#artifactBytes += content.bytes.byteLength;
    while (
      this.#artifacts.size > maximumCachedArtifacts ||
      this.#artifactBytes > maximumCachedBytes
    ) {
      const oldest = this.#artifacts.entries().next().value;
      if (oldest === undefined) break;
      this.#artifacts.delete(oldest[0]);
      this.#artifactBytes -= oldest[1].bytes.byteLength;
    }
    return { kind: 'Opened', ...structuredClone(content) };
  }
}
