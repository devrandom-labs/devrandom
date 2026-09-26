import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, expect, it } from 'vitest';
import {
  prepareEvaluationEvidenceEvent,
  prepareEvidenceArtifact,
  prepareProtectedEvaluationArtifact,
  type EvaluationEvidenceEvent,
} from '@devrandom/protocol';

import {
  SqliteEvaluationEvidenceOutbox,
  type EvaluationEvidenceBinding,
} from './sqlite-evaluation-evidence-outbox.js';

const said = (letter: string): string => `E${letter.repeat(43)}`;
const binding: EvaluationEvidenceBinding = {
  ownerAid: said('o'),
  evaluationId: randomUUID(),
  streamId: randomUUID(),
  originRunId: randomUUID(),
  taskId: randomUUID(),
  taskRevisionSaid: said('t'),
  personalAgentAid: said('a'),
  taskMandateSaid: said('m'),
};
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'devrandom-evaluation-outbox-'));
  roots.push(path);
  return path;
}

function event(
  sequence: number,
  previous: { kind: 'Genesis' } | { kind: 'Previous'; eventSaid: string },
  detail:
    | { kind: 'ModelExchange'; rawArtifactSaid: string }
    | {
        kind: 'UsageDebited';
        providerRequests: number;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        spendMicroUsd: number;
        elapsedMilliseconds: number;
      },
): EvaluationEvidenceEvent {
  const prepared = prepareEvaluationEvidenceEvent({
    evaluationId: binding.evaluationId,
    streamId: binding.streamId,
    originRunId: binding.originRunId,
    taskId: binding.taskId,
    taskRevisionSaid: binding.taskRevisionSaid,
    personalAgentAid: binding.personalAgentAid,
    taskMandateSaid: binding.taskMandateSaid,
    harnessRevisionSaid: said('h'),
    phase: { kind: 'Research', policySaid: said('p'), role: 'DiagnosticRefiner' },
    sequence,
    previous,
    occurredAt: '2026-09-26T05:00:00.000Z',
    detail,
  });
  if (prepared.kind !== 'Prepared') throw new Error(prepared.reason);
  return prepared.event;
}

function open(stateRoot: string): SqliteEvaluationEvidenceOutbox {
  const opening = SqliteEvaluationEvidenceOutbox.open(stateRoot, binding);
  if (opening.kind !== 'Opened') throw new Error(opening.kind);
  return opening.outbox;
}

it('restores exact raw bytes and the oldest unacknowledged batch after restart', () => {
  const stateRoot = root();
  const outbox = open(stateRoot);
  const bytes = new TextEncoder().encode('model exchange raw bytes');
  const preparedArtifact = prepareEvidenceArtifact(bytes, 'text/plain; charset=utf-8');
  if (preparedArtifact.kind !== 'Prepared') throw new Error(preparedArtifact.reason);
  const first = event(
    0,
    { kind: 'Genesis' },
    {
      kind: 'ModelExchange',
      rawArtifactSaid: preparedArtifact.artifact.d,
    },
  );
  const firstInput = {
    commandId: randomUUID(),
    fingerprint: `sha256:${'a'.repeat(64)}`,
    events: [first],
    publicArtifacts: [{ artifact: preparedArtifact.artifact, bytes }],
    protectedArtifacts: [],
  };
  expect(outbox.stage(firstInput).kind).toBe('Staged');
  expect(outbox.stage(firstInput).kind).toBe('AlreadyStaged');
  const second = event(
    1,
    { kind: 'Previous', eventSaid: first.d },
    {
      kind: 'ModelExchange',
      rawArtifactSaid: preparedArtifact.artifact.d,
    },
  );
  expect(
    outbox.stage({
      commandId: randomUUID(),
      fingerprint: `sha256:${'b'.repeat(64)}`,
      events: [second],
      publicArtifacts: [],
      protectedArtifacts: [],
    }).kind,
  ).toBe('Staged');
  const beforeRestart = outbox.pending();
  expect(beforeRestart.kind).toBe('Pending');
  outbox.close();
  const recovered = open(stateRoot);
  const oldest = recovered.pending();
  expect(oldest).toEqual(beforeRestart);
  if (oldest.kind !== 'Pending') throw new Error(oldest.kind);
  expect(oldest.upload.publicArtifacts[0]?.bytesBase64Url).toBe(
    Buffer.from(bytes).toString('base64url'),
  );
  const nextBatch = recovered.stage({
    commandId: randomUUID(),
    fingerprint: `sha256:${'c'.repeat(64)}`,
    events: [second],
    publicArtifacts: [],
    protectedArtifacts: [],
  });
  expect(nextBatch.kind).toBe('Conflict');
  expect(
    recovered.acknowledge({
      version: 1,
      disposition: 'Accepted',
      evaluationId: binding.evaluationId,
      streamId: binding.streamId,
      batchSaid: said('f'),
      acceptedThroughSequence: 1,
      chainHeadSaid: second.d,
    }),
  ).toEqual({ kind: 'Conflict' });
  const firstAck = {
    version: 1 as const,
    disposition: 'AlreadyAccepted' as const,
    evaluationId: binding.evaluationId,
    streamId: binding.streamId,
    batchSaid: oldest.upload.batch.d,
    acceptedThroughSequence: 0,
    chainHeadSaid: first.d,
  };
  expect(recovered.acknowledge(firstAck)).toEqual({ kind: 'Recorded' });
  expect(recovered.acknowledge(firstAck)).toEqual({ kind: 'AlreadyRecorded' });
  const pendingSecond = recovered.pending();
  expect(pendingSecond.kind).toBe('Pending');
  if (pendingSecond.kind !== 'Pending') throw new Error(pendingSecond.kind);
  expect(pendingSecond.upload.batch.startingSequence).toBe(1);
  expect(
    recovered.acknowledge({
      ...firstAck,
      batchSaid: pendingSecond.upload.batch.d,
      acceptedThroughSequence: 1,
      chainHeadSaid: second.d,
    }),
  ).toEqual({ kind: 'Recorded' });
  expect(recovered.pending()).toEqual({ kind: 'Empty' });
  recovered.close();
});

it('rejects missing or substituted raw artifact bytes before staging', () => {
  const outbox = open(root());
  const bytes = new TextEncoder().encode('actual raw bytes');
  const preparedArtifact = prepareEvidenceArtifact(bytes, 'text/plain; charset=utf-8');
  if (preparedArtifact.kind !== 'Prepared') throw new Error(preparedArtifact.reason);
  const first = event(
    0,
    { kind: 'Genesis' },
    {
      kind: 'ModelExchange',
      rawArtifactSaid: preparedArtifact.artifact.d,
    },
  );
  const input = {
    commandId: randomUUID(),
    fingerprint: `sha256:${'a'.repeat(64)}`,
    events: [first],
    protectedArtifacts: [],
  };
  expect(outbox.stage({ ...input, publicArtifacts: [] })).toEqual({ kind: 'Rejected' });
  expect(
    outbox.stage({
      ...input,
      publicArtifacts: [
        { artifact: preparedArtifact.artifact, bytes: new TextEncoder().encode('forged') },
      ],
    }),
  ).toEqual({ kind: 'Rejected' });
  expect(outbox.pending()).toEqual({ kind: 'Empty' });
  outbox.close();
});

it('rejects a changed owner and refuses to resume a modified durable upload', () => {
  const stateRoot = root();
  const outbox = open(stateRoot);
  const first = event(
    0,
    { kind: 'Genesis' },
    {
      kind: 'UsageDebited',
      providerRequests: 1,
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      spendMicroUsd: 1,
      elapsedMilliseconds: 1,
    },
  );
  expect(
    outbox.stage({
      commandId: randomUUID(),
      fingerprint: `sha256:${'a'.repeat(64)}`,
      events: [first],
      publicArtifacts: [],
      protectedArtifacts: [],
    }).kind,
  ).toBe('Staged');
  outbox.close();
  expect(
    SqliteEvaluationEvidenceOutbox.open(stateRoot, { ...binding, ownerAid: said('x') }),
  ).toEqual({
    kind: 'Corrupt',
  });
  const path = join(stateRoot, 'evaluations', binding.evaluationId, 'outbox.sqlite');
  const database = new DatabaseSync(path);
  database.prepare('UPDATE uploads SET chain_head_said = ?').run(said('f'));
  database.close();
  expect(SqliteEvaluationEvidenceOutbox.open(stateRoot, binding)).toEqual({ kind: 'Corrupt' });
});

it('refuses an encoded protected artifact request above the hosted body limit', () => {
  const outbox = open(root());
  const protectedArtifact = prepareProtectedEvaluationArtifact({
    evaluationId: binding.evaluationId,
    objectSaid: said('x'),
    purpose: 'TrialHoldout',
    segment: 0,
    nonce: 'a'.repeat(16),
    tag: 'b'.repeat(22),
    ciphertext: Buffer.alloc(500 * 1024, 1).toString('base64url'),
    plaintextByteCount: 500 * 1024,
  });
  if (protectedArtifact.kind !== 'Prepared') throw new Error(protectedArtifact.reason);
  const prepared = prepareEvaluationEvidenceEvent({
    evaluationId: binding.evaluationId,
    streamId: binding.streamId,
    originRunId: binding.originRunId,
    taskId: binding.taskId,
    taskRevisionSaid: binding.taskRevisionSaid,
    personalAgentAid: binding.personalAgentAid,
    taskMandateSaid: binding.taskMandateSaid,
    harnessRevisionSaid: said('h'),
    phase: { kind: 'Research', policySaid: said('p'), role: 'DiagnosticRefiner' },
    sequence: 0,
    previous: { kind: 'Genesis' },
    occurredAt: '2026-09-26T05:00:00.000Z',
    detail: {
      kind: 'ArtifactCaptured',
      artifactSaid: protectedArtifact.artifact.d,
      custody: 'ProtectedCiphertext',
    },
  });
  if (prepared.kind !== 'Prepared') throw new Error(prepared.reason);
  expect(
    outbox.stage({
      commandId: randomUUID(),
      fingerprint: `sha256:${'a'.repeat(64)}`,
      events: [prepared.event],
      publicArtifacts: [],
      protectedArtifacts: [protectedArtifact.artifact],
    }),
  ).toEqual({ kind: 'QuotaExceeded' });
  expect(outbox.pending()).toEqual({ kind: 'Empty' });
  outbox.close();
});
