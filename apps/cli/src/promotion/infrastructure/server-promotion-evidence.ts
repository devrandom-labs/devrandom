import { validateExecutionBinding } from '@devrandom/domain';
import {
  decodeEvaluationEvidenceEvent,
  decodeEvidenceArtifact,
  type EvaluationEvidenceEvent,
} from '@devrandom/protocol';

import type { PromotionAcceptedEvidenceReading } from '../application/open-promotion-custody.js';
import type { ServerEvaluationHttp } from '../../harness/infrastructure/server-evaluation-http.js';

/** Reopens the entire hosted accepted prefix across bounded owner-scoped HTTP pages. */
export class ServerPromotionEvidence implements PromotionAcceptedEvidenceReading {
  readonly #server: Pick<ServerEvaluationHttp, 'readEvidencePage' | 'readPublicArtifact'>;

  constructor(server: Pick<ServerEvaluationHttp, 'readEvidencePage' | 'readPublicArtifact'>) {
    this.#server = server;
  }

  async openPrefix(
    input: Parameters<PromotionAcceptedEvidenceReading['openPrefix']>[0],
  ): ReturnType<PromotionAcceptedEvidenceReading['openPrefix']> {
    if (
      validateExecutionBinding(input.binding).kind !== 'Accepted' ||
      !Number.isSafeInteger(input.throughSequence) ||
      input.throughSequence < 0 ||
      input.throughSequence > 9_999 ||
      !/^[A-Z][A-Za-z0-9_-]{43}$/u.test(input.headSaid)
    )
      return { kind: 'Missing' };
    const events: EvaluationEvidenceEvent[] = [];
    let previousSaid: string | undefined;
    while (events.length <= input.throughSequence) {
      const afterSequence = events.length - 1;
      let response: Awaited<ReturnType<ServerEvaluationHttp['readEvidencePage']>>;
      try {
        response = await this.#server.readEvidencePage({
          evaluationId: input.binding.evaluationId,
          afterSequence,
          throughSequence: input.throughSequence,
          throughHeadSaid: input.headSaid,
        });
      } catch {
        return { kind: 'Unavailable' };
      }
      if (response.kind === 'Unavailable') return { kind: 'Unavailable' };
      if (response.kind !== 'Read') return { kind: 'Missing' };
      const page = response.page;
      if (
        page.evaluationId !== input.binding.evaluationId ||
        page.streamId !== input.binding.evidenceStreamId ||
        page.afterSequence !== afterSequence ||
        page.throughSequence !== input.throughSequence ||
        page.throughHeadSaid !== input.headSaid ||
        page.events.length !== Math.min(32, input.throughSequence - afterSequence)
      )
        return { kind: 'Missing' };
      for (const event of page.events) {
        if (
          decodeEvaluationEvidenceEvent(event).kind !== 'Accepted' ||
          event.sequence !== events.length ||
          event.evaluationId !== input.binding.evaluationId ||
          event.streamId !== input.binding.evidenceStreamId ||
          event.originRunId !== input.binding.originRunId ||
          event.taskId !== input.binding.taskId ||
          event.taskRevisionSaid !== input.binding.taskRevisionSaid ||
          event.personalAgentAid !== input.binding.personalAgentAid ||
          event.taskMandateSaid !== input.binding.taskMandateSaid ||
          (event.phase.kind === 'Trial' &&
            (input.binding.phase.kind !== 'Trial' ||
              event.phase.manifestSaid !== input.binding.phase.manifestSaid)) ||
          (previousSaid === undefined
            ? event.previous.kind !== 'Genesis'
            : event.previous.kind !== 'Previous' || event.previous.eventSaid !== previousSaid)
        )
          return { kind: 'Missing' };
        events.push(event);
        previousSaid = event.d;
      }
    }
    return previousSaid === input.headSaid ? { kind: 'Acknowledged', events } : { kind: 'Missing' };
  }

  async openPublic(
    input: Parameters<PromotionAcceptedEvidenceReading['openPublic']>[0],
  ): ReturnType<PromotionAcceptedEvidenceReading['openPublic']> {
    try {
      const response = await this.#server.readPublicArtifact(input);
      if (response.kind === 'Unavailable') return { kind: 'Unavailable' };
      return response.kind === 'Read' &&
        response.artifact.d === input.artifactSaid &&
        decodeEvidenceArtifact(response.artifact, response.bytes).kind === 'Accepted'
        ? { kind: 'Opened', artifact: response.artifact, bytes: response.bytes }
        : { kind: 'Missing' };
    } catch {
      return { kind: 'Unavailable' };
    }
  }
}
