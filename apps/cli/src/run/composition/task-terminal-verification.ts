import type { ProtectedCredentials } from '@devrandom/domain';
import {
  decodeRunProjection,
  type TaskProjection,
  type EvidenceEvent,
  type EvidenceStreamProjection,
} from '@devrandom/protocol';
import type { HostedRunStatuses, HostedRunTimelines } from '../application/task-run-observation.js';
import { verifyTerminalSubmission } from '../application/verify-terminal-submission.js';
import { SqliteEvidenceOutboxes } from '../infrastructure/sqlite-evidence-outbox.js';

/** Fresh authenticated inspection of accepted terminal proof, with no executor or repeated oracle call. */
export class TaskTerminalVerificationComposition {
  readonly #stateRoot: string;
  constructor(stateRoot: string) {
    this.#stateRoot = stateRoot;
  }
  async verify(
    input: {
      readonly ownerAid: string;
      readonly task: TaskProjection;
      readonly runId: string;
      readonly runs: HostedRunStatuses;
      readonly evidence: HostedRunTimelines;
      readonly protectedCredentials: ProtectedCredentials;
    },
    signal: AbortSignal,
  ): Promise<ReturnType<typeof verifyTerminalSubmission> | { readonly kind: 'Unavailable' }> {
    try {
      if (input.task.lifecycle.kind !== 'Completed' || input.task.ownerAid !== input.ownerAid)
        return { kind: 'Rejected' };
      const hosted = await input.runs.inspect(input.runId);
      if (hosted.kind !== 'Found') return { kind: 'Unavailable' };
      const decoded = decodeRunProjection(hosted.run);
      if (
        decoded.kind !== 'Accepted' ||
        decoded.run.binding.ownerAid !== input.ownerAid ||
        decoded.run.binding.taskId !== input.task.taskId ||
        decoded.run.binding.taskRevisionSaid !== input.task.revisionSaid
      )
        return { kind: 'Rejected' };
      const events: EvidenceEvent[] = [];
      let stream: EvidenceStreamProjection | undefined;
      let cursor: string | undefined;
      const cursors = new Set<string>();
      do {
        signal.throwIfAborted();
        const page = await input.evidence.inspect(input.runId, {
          limit: 100,
          ...(cursor === undefined ? {} : { cursor }),
        });
        if (page.kind !== 'Found') return { kind: 'Unavailable' };
        if (stream !== undefined && JSON.stringify(stream) !== JSON.stringify(page.page.stream))
          return { kind: 'Rejected' };
        stream = page.page.stream;
        events.push(...page.page.events.map(({ event }) => event));
        if (events.length > 100000) return { kind: 'Rejected' };
        if (
          stream.cursor.kind === 'Accepted' &&
          events.at(-1)?.sequence === stream.cursor.acceptedThroughSequence
        )
          break;
        cursor = page.page.nextCursor ?? undefined;
        if (cursor !== undefined) {
          if (cursors.has(cursor)) return { kind: 'Rejected' };
          cursors.add(cursor);
        }
      } while (cursor !== undefined);
      const custody = new SqliteEvidenceOutboxes(
        () => new Date().toISOString(),
        input.protectedCredentials,
      ).readSubmission({ run: decoded.run, stateRoot: this.#stateRoot, stream, events });
      return custody.kind === 'Read'
        ? verifyTerminalSubmission(decoded.run, custody.custody)
        : { kind: 'Rejected' };
    } catch {
      return { kind: 'Unavailable' };
    }
  }
}
