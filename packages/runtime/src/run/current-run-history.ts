import { isDeepStrictEqual } from 'node:util';
import type { Run } from '@devrandom/domain';
import type { CurrentRunHistory } from './successor-run-behavior.js';
import {
  selectVersionedFormatHistory,
  validVersionedHistoryPolicy,
  type PublicHistorySource,
  type ReviewedHistoryProjection,
  type VersionedFormatHistoryPolicy,
} from '../context/application/select-versioned-format-history.js';

export interface AuthorizedRunHistory {
  read(input: {
    readonly run: Run;
    readonly sourceInventorySaid: string;
    readonly formatMarker: string;
    readonly signal: AbortSignal;
  }): Promise<
    | { readonly kind: 'Read'; readonly sources: readonly PublicHistorySource[] }
    | { readonly kind: 'Rejected' }
  >;
}

const interrupted = (signal: AbortSignal) => signal.aborted;

/** Executes the same reviewed C3 algorithm at each relevant provider boundary using current public custody. */
export class ReviewedCurrentRunHistory implements CurrentRunHistory {
  readonly #reading: AuthorizedRunHistory;
  readonly #projection: ReviewedHistoryProjection;
  constructor(reading: AuthorizedRunHistory, projection: ReviewedHistoryProjection) {
    this.#reading = reading;
    this.#projection = projection;
  }
  async select(
    input: Parameters<CurrentRunHistory['select']>[0],
  ): ReturnType<CurrentRunHistory['select']> {
    try {
      const document: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(input.configuration.bytes),
      );
      if (
        typeof document !== 'object' ||
        document === null ||
        !('version' in document) ||
        document.version !== 1 ||
        !('arm' in document) ||
        document.arm !== 'C3'
      )
        return { kind: 'Rejected' };
      const policy = document as VersionedFormatHistoryPolicy;
      const implementation: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(input.implementation.bytes),
      );
      if (
        !validVersionedHistoryPolicy(policy) ||
        !isDeepStrictEqual(implementation, {
          version: 1,
          kind: 'VersionedFormatContextSelection',
          algorithm: 'ExactPublicHistoryV1',
        }) ||
        input.successor.binding.arm !== 'C3' ||
        interrupted(input.signal)
      )
        return { kind: 'Rejected' };
      if (
        !policy.triggerPaths.includes(input.edit.path) ||
        !input.edit.content.includes(policy.formatMarker)
      )
        return {
          kind: 'Selected',
          context: input.context,
          receiptBytes: Buffer.from(
            JSON.stringify({ version: 1, kind: 'RunHistoryNotTriggered', path: input.edit.path }),
            'utf8',
          ),
        };
      const sources = await this.#reading.read({
        run: input.run,
        sourceInventorySaid: input.successor.binding.sourceInventorySaid,
        formatMarker: policy.formatMarker,
        signal: input.signal,
      });
      if (sources.kind !== 'Read') return { kind: 'Rejected' };
      const selected = await selectVersionedFormatHistory(
        {
          policy,
          taskId: input.run.binding.taskId,
          taskRevisionSaid: input.run.binding.taskRevisionSaid,
          sourceInventorySaid: input.successor.binding.sourceInventorySaid,
          edit: input.edit,
          sources: sources.sources,
        },
        this.#projection,
      );
      if (selected.kind !== 'Selected' || interrupted(input.signal)) return { kind: 'Rejected' };
      return {
        kind: 'Selected',
        context: {
          ...input.context,
          messages: [
            ...input.context.messages,
            {
              role: 'user',
              content: `Reviewed public history for versioned-format edit:\n${selected.contextText}`,
              timestamp: Date.now(),
            },
          ],
        },
        receiptBytes: Buffer.from(
          JSON.stringify({
            version: 1,
            kind: 'RunPublicHistorySelected',
            runId: input.run.binding.runId,
            segmentSaid: input.run.currentExecution?.segmentSaid,
            successorRevisionSaid: input.successor.successorRevisionSaid,
            sourceInventorySaid: input.successor.binding.sourceInventorySaid,
            selection: selected,
          }),
          'utf8',
        ),
      };
    } catch {
      return { kind: 'Rejected' };
    }
  }
}
