import type { AssistantMessage, Message } from '@earendil-works/pi-ai';
import {
  decodeEvidenceArtifact,
  type EvidenceArtifact,
  type EvidenceEvent,
} from '@devrandom/protocol';

const record = (value: unknown): value is { readonly [key: string]: unknown } =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
function assistant(value: unknown): value is AssistantMessage {
  return (
    record(value) &&
    value.role === 'assistant' &&
    typeof value.api === 'string' &&
    typeof value.provider === 'string' &&
    typeof value.model === 'string' &&
    typeof value.timestamp === 'number' &&
    Number.isFinite(value.timestamp) &&
    record(value.usage) &&
    Array.isArray(value.content) &&
    ['stop', 'length', 'toolUse'].includes(String(value.stopReason)) &&
    value.content.every(
      (part: unknown) =>
        record(part) &&
        ((part.type === 'text' && typeof part.text === 'string') ||
          (part.type === 'thinking' &&
            typeof part.thinking === 'string' &&
            (part.thinkingSignature === undefined || typeof part.thinkingSignature === 'string')) ||
          (part.type === 'toolCall' &&
            typeof part.id === 'string' &&
            typeof part.name === 'string' &&
            record(part.arguments))),
    )
  );
}

/** Reconstitutes provider messages and evidence-bound tool feedback without replaying effects. */
export function calibrationTranscript(input: {
  readonly events: readonly EvidenceEvent[];
  readonly artifacts: readonly {
    readonly artifact: EvidenceArtifact;
    readonly bytes: Uint8Array;
  }[];
}):
  | { readonly kind: 'Restored'; readonly messages: readonly Message[] }
  | { readonly kind: 'Rejected' } {
  try {
    const messages: Message[] = [];
    let request: Extract<EvidenceEvent['event'], { kind: 'ModelRequest' }> | undefined;
    let completed: Extract<EvidenceEvent['event'], { kind: 'ModelMessageCompleted' }> | undefined;
    const pending = new Map<
      string,
      { readonly name: string; proposed: boolean; authorized: boolean }
    >();
    const bytes = (said: string): Uint8Array | undefined => {
      const matches = input.artifacts.filter(({ artifact }) => artifact.d === said);
      const raw = matches[0];
      return matches.length === 1 &&
        raw !== undefined &&
        raw.artifact.d === said &&
        decodeEvidenceArtifact(raw.artifact, raw.bytes).kind === 'Accepted'
        ? raw.bytes
        : undefined;
    };
    for (const evidence of input.events) {
      const event = evidence.event;
      if (event.kind === 'ModelRequest') {
        if (request !== undefined || pending.size !== 0) return { kind: 'Rejected' };
        request = event;
      } else if (event.kind === 'ModelMessageCompleted') {
        if (
          request === undefined ||
          event.disposition !== 'Completed' ||
          event.piSessionId !== request.piSessionId ||
          event.modelTurnId !== request.modelTurnId
        )
          return { kind: 'Rejected' };
        const raw = bytes(event.messageArtifactSaid);
        if (raw === undefined) return { kind: 'Rejected' };
        const document: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
        if (
          !record(document) ||
          !assistant(document.message) ||
          document.message.provider !== request.provider ||
          document.message.model !== request.model
        )
          return { kind: 'Rejected' };
        const message = document.message;
        messages.push(message);
        completed = event;
        request = undefined;
        for (const part of message.content) {
          if (part.type !== 'toolCall') continue;
          if (
            pending.has(part.id) ||
            ![
              'read_file',
              'list_files',
              'search_repository',
              'write_file',
              'replace_text',
              'run_tests',
            ].includes(part.name)
          )
            return { kind: 'Rejected' };
          pending.set(part.id, { name: part.name, proposed: false, authorized: false });
        }
        if (pending.size === 0)
          messages.push({
            role: 'user',
            content: 'Continue the same task using public feedback. Submit the current work.',
            timestamp: Date.parse(evidence.occurredAt),
          });
      } else if (
        event.kind === 'ToolProposed' ||
        event.kind === 'ToolAuthorized' ||
        event.kind === 'EffectCompleted' ||
        event.kind === 'EffectFailed' ||
        event.kind === 'ToolRejected'
      ) {
        const call = pending.get(event.toolCallId);
        if (
          call === undefined ||
          completed === undefined ||
          event.piSessionId !== completed.piSessionId ||
          event.modelTurnId !== completed.modelTurnId ||
          event.tool !== call.name
        )
          return { kind: 'Rejected' };
        if (event.kind === 'ToolProposed') {
          if (call.proposed) return { kind: 'Rejected' };
          call.proposed = true;
        } else if (event.kind === 'ToolAuthorized') {
          if (!call.proposed || call.authorized) return { kind: 'Rejected' };
          call.authorized = true;
        } else {
          if (event.kind === 'ToolRejected' && (!call.proposed || call.authorized))
            return { kind: 'Rejected' };
          if (event.kind !== 'ToolRejected' && !call.authorized) return { kind: 'Rejected' };
          let result: string;
          if (event.kind === 'ToolRejected') {
            if (
              !['ResourceDenied', 'CapabilityNotGranted', 'ArgumentsInvalid'].includes(event.reason)
            )
              return { kind: 'Rejected' };
            result = `Tool rejected: ${event.reason}`;
          } else {
            const outputs = event.outputArtifactSaids.map((said) => bytes(said));
            if (outputs.some((raw) => raw === undefined)) return { kind: 'Rejected' };
            const references = event.outputArtifactSaids.join(', ') || 'none';
            if (['read_file', 'list_files', 'search_repository'].includes(event.tool)) {
              if (event.kind !== 'EffectCompleted' || outputs.length !== 1)
                return { kind: 'Rejected' };
              const raw = outputs[0];
              if (raw === undefined) return { kind: 'Rejected' };
              const content = new TextDecoder('utf-8', {
                fatal: true,
                ignoreBOM: event.tool !== 'read_file',
              }).decode(raw);
              result = `${content}\nOutput artifact SAIDs: ${references}`;
            } else if (event.tool === 'write_file' || event.tool === 'replace_text') {
              if (
                event.kind !== 'EffectCompleted' ||
                outputs.length !== 0 ||
                !event.resource.startsWith('repository://')
              )
                return { kind: 'Rejected' };
              result = `${event.tool === 'write_file' ? 'Wrote' : 'Replaced text in'} ${event.resource}.\nOutput artifact SAIDs: none`;
            } else if (event.tool === 'run_tests') {
              if (outputs.length !== 2 || !event.resource.startsWith('command://'))
                return { kind: 'Rejected' };
              const stdout = outputs[0];
              const stderr = outputs[1];
              if (stdout === undefined || stderr === undefined) return { kind: 'Rejected' };
              const stdoutText = new TextDecoder('utf-8', { fatal: true }).decode(stdout);
              const stderrText = new TextDecoder('utf-8', { fatal: true }).decode(stderr);
              result = `Recovered ${event.kind === 'EffectFailed' ? `failed (${event.failure})` : 'completed'} command ${event.resource} from recorded stdout and stderr.\nstdout:\n${stdoutText}\nstderr:\n${stderrText}\nOutput artifact SAIDs: ${references}`;
            } else return { kind: 'Rejected' };
          }
          messages.push({
            role: 'toolResult',
            toolCallId: event.toolCallId,
            toolName: event.tool,
            content: [
              {
                type: 'text',
                text: result,
              },
            ],
            isError: false,
            timestamp: Date.parse(evidence.occurredAt),
          });
          pending.delete(event.toolCallId);
        }
      } else if (event.kind === 'ApprovalRequired') return { kind: 'Rejected' };
    }
    return request === undefined && pending.size === 0 && messages.length > 0
      ? { kind: 'Restored', messages }
      : { kind: 'Rejected' };
  } catch {
    return { kind: 'Rejected' };
  }
}
