import { validateExecutionBinding, type EvaluationExecutionBinding } from '@devrandom/domain';
import {
  decodeEvidenceArtifact,
  decodeEvaluationEvidenceEvent,
  type EvidenceArtifact,
  type EvaluationEvidenceEvent,
} from '@devrandom/protocol';

import type { ServerEvaluationHttp } from './server-evaluation-http.js';

type ReadingHttp = Pick<ServerEvaluationHttp, 'readEvidencePage' | 'readPublicArtifact'>;

/** CLI driving adapter for exact owner-authorized hosted Evaluation reads. */
export class HostedEvaluationEvidenceReading {
  readonly #http: ReadingHttp;

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
    const events: EvaluationEvidenceEvent[] = [];
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
        events.push(event);
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
    return { kind: 'Acknowledged', events, throughSequence, headSaid };
  }

  async openPublic(input: {
    readonly evaluationId: string;
    readonly artifactSaid: string;
  }): Promise<
    | { readonly kind: 'Opened'; readonly artifact: EvidenceArtifact; readonly bytes: Uint8Array }
    | { readonly kind: 'Missing' | 'Unavailable' }
  > {
    const opened = await this.#http.readPublicArtifact(input);
    if (opened.kind === 'Unavailable') return { kind: 'Unavailable' };
    if (
      opened.kind !== 'Read' ||
      opened.artifact.d !== input.artifactSaid ||
      decodeEvidenceArtifact(opened.artifact, opened.bytes).kind !== 'Accepted'
    )
      return { kind: 'Missing' };
    return { kind: 'Opened', artifact: opened.artifact, bytes: opened.bytes };
  }
}
