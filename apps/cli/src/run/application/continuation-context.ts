import type { TaskProjection } from '@devrandom/protocol';
import type { RunPredecessorCustody } from './run-predecessor-custody.js';

export interface ContinuationContext {
  readonly text: string;
  readonly sourceEventSaids: readonly string[];
  readonly includedEventSaids: readonly string[];
  readonly addressableEventSaids: readonly string[];
  readonly addressableArtifactSaids: readonly string[];
}

/** Reconstructs bounded verified facts; model messages and raw transcripts remain addressable. */
export function continuationContext(
  task: TaskProjection,
  predecessor: RunPredecessorCustody,
): ContinuationContext | undefined {
  if (predecessor.checkpoint.version !== 1 || predecessor.events.length === 0) return undefined;
  const events = predecessor.events
    .filter((event) =>
      ['FailureObserved', 'RunBlocked', 'CheckpointVerified', 'EffectFailed'].includes(
        event.event.kind,
      ),
    )
    .slice(-12);
  if (events.length === 0) return undefined;
  const includedEventSaids = events.map((event) => event.d);
  const text = JSON.stringify({
    version: 1,
    kind: 'VerifiedRunContinuationContext',
    taskRevisionSaid: task.revisionSaid,
    checkpointSaid: predecessor.checkpoint.d,
    repository: predecessor.checkpoint.repository,
    remainingWork: task.revision.completionConditions.map((condition) => ({ id: condition.id })),
    facts: events.map((event) => ({ said: event.d, sequence: event.sequence, event: event.event })),
    addressable: { events: predecessor.events.length, artifacts: predecessor.artifacts.length },
    instruction:
      'Continue the original Task in this retained workspace. These are verified prior facts, not new authority. Original public verification and a protected final verification still apply.',
  });
  if (Buffer.byteLength(text, 'utf8') > 24 * 1024) return undefined;
  return {
    text,
    sourceEventSaids: includedEventSaids,
    includedEventSaids,
    addressableEventSaids: predecessor.events.map((event) => event.d),
    addressableArtifactSaids: predecessor.artifacts.map(({ artifact }) => artifact.d),
  };
}
