import { expect, it } from 'vitest';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { prepareEvidenceArtifact, type EvidenceEvent } from '@devrandom/protocol';
import { calibrationTranscript } from './calibration-transcript.js';

function fixture() {
  const message = {
    ...fauxAssistantMessage(''),
    content: [
      {
        type: 'thinking',
        thinking: 'complete original reasoning',
        thinkingSignature: '{"type":"reasoning","summary":[]}',
      },
    ],
    stopReason: 'length',
  };
  const bytes = Buffer.from(JSON.stringify({ message, usageReceipt: { retained: true } }));
  const prepared = prepareEvidenceArtifact(bytes, 'application/json');
  if (prepared.kind !== 'Prepared') throw Error('artifact');
  const events = [
    {
      sequence: 0,
      event: {
        kind: 'ModelRequest',
        piSessionId: 'session',
        modelTurnId: 'session:0',
        provider: message.provider,
        model: message.model,
      },
    },
    {
      sequence: 1,
      occurredAt: '2026-09-26T00:00:00.000Z',
      event: {
        kind: 'ModelMessageCompleted',
        piSessionId: 'session',
        modelTurnId: 'session:0',
        messageArtifactSaid: prepared.artifact.d,
        disposition: 'Completed',
      },
    },
  ] as EvidenceEvent[];
  return { message, events, artifacts: [{ artifact: prepared.artifact, bytes }] };
}
it('restores complete raw reasoning and the exact frozen-worker continuation prompt', () => {
  const f = fixture();
  const restored = calibrationTranscript(f);
  expect(restored).toEqual({
    kind: 'Restored',
    messages: [
      f.message,
      {
        role: 'user',
        content: 'Continue the same task using public feedback. Submit the current work.',
        timestamp: Date.parse(f.events[1]?.occurredAt ?? ''),
      },
    ],
  });
});
it('rejects absent or substituted raw artifacts and mismatched Pi turn identity', () => {
  const f = fixture();
  const raw = f.artifacts[0];
  if (raw === undefined) throw Error('raw');
  expect(calibrationTranscript({ ...f, artifacts: [] }).kind).toBe('Rejected');
  expect(
    calibrationTranscript({ ...f, artifacts: [{ ...raw, bytes: Buffer.from('{}') }] }).kind,
  ).toBe('Rejected');
  const changed = structuredClone(f.events);
  if (changed[1]?.event.kind === 'ModelMessageCompleted')
    changed[1].event.modelTurnId = 'another-turn';
  expect(calibrationTranscript({ ...f, events: changed }).kind).toBe('Rejected');
});
it('reconstructs exact completed read output without executing any historical tool', () => {
  const f = fixture();
  const message = {
    ...f.message,
    content: [
      { type: 'toolCall', id: 'call', name: 'read_file', arguments: { path: 'src/lib.rs' } },
    ],
    stopReason: 'toolUse',
  };
  const modelBytes = Buffer.from(JSON.stringify({ message }));
  const prepared = prepareEvidenceArtifact(modelBytes, 'application/json');
  const outputBytes = Buffer.from('entire original file\n');
  const output = prepareEvidenceArtifact(outputBytes, 'text/plain; charset=utf-8');
  if (prepared.kind !== 'Prepared' || output.kind !== 'Prepared') throw Error('artifact');
  const events = structuredClone(f.events);
  if (events[1]?.event.kind !== 'ModelMessageCompleted') throw Error('message');
  events[1].event.messageArtifactSaid = prepared.artifact.d;
  const attribution = {
    piSessionId: 'session',
    modelTurnId: 'session:0',
    toolCallId: 'call',
    tool: 'read_file',
  };
  events.push(
    ...([
      { event: { kind: 'ToolProposed', ...attribution } },
      { event: { kind: 'ToolAuthorized', ...attribution } },
      {
        occurredAt: '2026-09-26T00:00:01.000Z',
        event: {
          kind: 'EffectCompleted',
          ...attribution,
          outputArtifactSaids: [output.artifact.d],
        },
      },
    ] as EvidenceEvent[]),
  );
  const artifacts = [
    { artifact: prepared.artifact, bytes: modelBytes },
    { artifact: output.artifact, bytes: outputBytes },
  ];
  expect(calibrationTranscript({ events, artifacts })).toEqual({
    kind: 'Restored',
    messages: [
      message,
      {
        role: 'toolResult',
        toolCallId: 'call',
        toolName: 'read_file',
        content: [
          {
            type: 'text',
            text: `entire original file\n\nOutput artifact SAIDs: ${output.artifact.d}`,
          },
        ],
        isError: false,
        timestamp: Date.parse('2026-09-26T00:00:01.000Z'),
      },
    ],
  });
  expect(calibrationTranscript({ events: events.slice(0, -1), artifacts }).kind).toBe('Rejected');
  expect(calibrationTranscript({ events, artifacts: artifacts.slice(0, 1) }).kind).toBe('Rejected');
});
