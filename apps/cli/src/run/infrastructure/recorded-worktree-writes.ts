import {
  decodeEvidenceArtifact,
  identifyCheckpointFileContent,
  type EvidenceEvent,
  type VerifiedCheckpoint,
} from '@devrandom/protocol';
import type { EvidenceRecorder } from '@devrandom/runtime';

interface ModelArtifact {
  readonly message?: unknown;
}
interface ModelMessage {
  readonly content?: unknown;
}
interface ModelToolCall {
  readonly type?: unknown;
  readonly id?: unknown;
  readonly name?: unknown;
  readonly arguments?: unknown;
}
interface WriteArguments {
  readonly path?: unknown;
  readonly content?: unknown;
}
function object(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads recorded Pi messages; never replays a write or infers an unobserved effect. */
export function recordedWorktreeWritesMatch(input: {
  readonly events: readonly EvidenceEvent[];
  readonly evidence: Pick<EvidenceRecorder, 'artifact'>;
  readonly repository: Extract<VerifiedCheckpoint, { version: 1 }>['repository'];
}): boolean {
  const messages = new Map<string, EvidenceEvent>();
  const writes = new Map<string, string>();
  const completed = new Set<string>();
  try {
    for (const observation of input.events) {
      const detail = observation.event;
      if (detail.kind === 'ModelMessageCompleted' && observation.producer.kind === 'PiExecutor')
        messages.set(detail.modelTurnId, observation);
      if (detail.kind !== 'EffectCompleted' || detail.requiredCapability !== 'EditRepository')
        continue;
      if (detail.tool !== 'write_file' || observation.producer.kind !== 'ToolGateway') return false;
      const messageEvent = messages.get(detail.modelTurnId)?.event;
      if (
        messageEvent?.kind !== 'ModelMessageCompleted' ||
        messageEvent.piSessionId !== detail.piSessionId
      )
        return false;
      const raw = input.evidence.artifact(messageEvent.messageArtifactSaid);
      if (
        raw.kind !== 'Read' ||
        raw.artifact.d !== messageEvent.messageArtifactSaid ||
        decodeEvidenceArtifact(raw.artifact, raw.bytes).kind !== 'Accepted'
      )
        return false;
      const value: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(raw.bytes),
      );
      const message = object(value) ? (value as ModelArtifact).message : undefined;
      const content = object(message) ? (message as ModelMessage).content : undefined;
      if (!Array.isArray(content)) return false;
      const calls = content.filter(
        (item: unknown) =>
          object(item) &&
          (item as ModelToolCall).type === 'toolCall' &&
          (item as ModelToolCall).id === detail.toolCallId,
      );
      if (calls.length !== 1) return false;
      const call = calls[0] as ModelToolCall;
      if (call.name !== 'write_file' || !object(call.arguments)) return false;
      const args = call.arguments as WriteArguments;
      if (
        typeof args.path !== 'string' ||
        typeof args.content !== 'string' ||
        detail.resource !== `repository://${args.path}`
      )
        return false;
      const identified = identifyCheckpointFileContent(new TextEncoder().encode(args.content));
      if (identified.kind !== 'Identified') return false;
      writes.set(args.path, identified.contentSaid);
      completed.add(`${detail.modelTurnId}:${detail.toolCallId}`);
    }
    if (
      input.events.some(
        ({ event }) =>
          event.kind === 'ToolAuthorized' &&
          event.requiredCapability === 'EditRepository' &&
          !completed.has(`${event.modelTurnId}:${event.toolCallId}`),
      )
    )
      return false;
    return (
      writes.size === input.repository.changedFiles.length &&
      input.repository.changedFiles.every(
        (file) =>
          (file.disposition === 'Added' || file.disposition === 'Modified') &&
          file.mode === '100644' &&
          writes.get(file.path) === file.contentSaid,
      )
    );
  } catch {
    return false;
  }
}
