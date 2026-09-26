import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, expect, it, vi } from 'vitest';
import * as protocol from '@devrandom/protocol';
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
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('reuses verified uploads across 130-event inspections without hiding external corruption', () => {
  const stateRoot = root();
  const outbox = open(stateRoot);
  const database = new DatabaseSync(
    join(stateRoot, 'evaluations', binding.evaluationId, 'outbox.sqlite'),
  );
  const decode = vi.spyOn(protocol, 'decodeEvaluationEvidenceBatch');
  let previous: EvaluationEvidenceEvent | undefined;
  try {
    for (let index = 0; index < 130; index++) {
      const bytes = Buffer.from(`observation ${String(index).padStart(3, '0')}`);
      const raw = prepareEvidenceArtifact(bytes, 'text/plain; charset=utf-8');
      if (raw.kind !== 'Prepared') throw new Error('artifact');
      const next = event(
        index,
        previous === undefined ? { kind: 'Genesis' } : { kind: 'Previous', eventSaid: previous.d },
        { kind: 'ModelExchange', rawArtifactSaid: raw.artifact.d },
      );
      expect(
        outbox.stage({
          commandId: randomUUID(),
          fingerprint: `sha256:${'a'.repeat(64)}`,
          events: [next],
          publicArtifacts: [{ artifact: raw.artifact, bytes }],
          protectedArtifacts: [],
        }).kind,
      ).toBe('Staged');
      previous = next;
    }
    expect(outbox.position().kind).toBe('Position');
    decode.mockClear();
    const started = performance.now();
    for (let index = 0; index < 4; index++) {
      expect(outbox.position()).toMatchObject({ kind: 'Position', nextSequence: 130 });
      expect(outbox.following(null).kind).toBe('Found');
    }
    const repeatedDecodes = decode.mock.calls.length;
    console.info(
      JSON.stringify({
        fixture: 'sqlite-130-events',
        inspections: 8,
        milliseconds: performance.now() - started,
        repeatedDecodes,
      }),
    );

    const pending = outbox.pending();
    const found = outbox.following(null);
    if (pending.kind !== 'Pending' || found.kind !== 'Found') throw new Error('upload');
    const original = structuredClone(pending.upload);
    pending.upload.events.splice(0);
    found.upload.publicArtifacts.splice(0);
    expect(outbox.pending()).toEqual({ kind: 'Pending', upload: original });
    expect(outbox.position().kind).toBe('Position');

    // Substitute independently valid bytes and descriptor while preserving the
    // old event/batch identities. A cache keyed only by batch SAID misses this.
    const replacementBytes = Buffer.from('observation BAD');
    const replacement = prepareEvidenceArtifact(replacementBytes, 'text/plain; charset=utf-8');
    if (replacement.kind !== 'Prepared') throw new Error('replacement');
    const substituted = structuredClone(original);
    substituted.publicArtifacts[0] = {
      artifact: replacement.artifact,
      bytesBase64Url: replacementBytes.toString('base64url'),
    };
    const encoded = JSON.stringify(substituted);
    database
      .prepare('UPDATE uploads SET encoded_upload = ?, encoded_bytes = ? WHERE batch_said = ?')
      .run(encoded, Buffer.byteLength(encoded), original.batch.d);
    expect(outbox.position()).toEqual({ kind: 'Corrupt' });
    expect(outbox.following(null)).toEqual({ kind: 'Corrupt' });
    const restored = JSON.stringify(original);
    database
      .prepare('UPDATE uploads SET encoded_upload = ?, encoded_bytes = ? WHERE batch_said = ?')
      .run(restored, Buffer.byteLength(restored), original.batch.d);
    expect(outbox.position().kind).toBe('Position');

    for (const mutation of [
      'UPDATE uploads SET starting_sequence = -1 WHERE starting_sequence = 0',
      'UPDATE uploads SET ending_sequence = ending_sequence + 1 WHERE starting_sequence = 0',
      "UPDATE uploads SET chain_head_said = 'invalid' WHERE starting_sequence = 0",
      'UPDATE uploads SET encoded_bytes = encoded_bytes + 1 WHERE starting_sequence = 0',
      "UPDATE uploads SET acknowledgement = '{}' WHERE starting_sequence = 0",
      'UPDATE stream_state SET next_sequence = next_sequence + 1',
      "UPDATE artifacts SET custody = 'ProtectedCiphertext' WHERE artifact_said = (SELECT artifact_said FROM artifacts LIMIT 1)",
    ]) {
      database.exec('BEGIN IMMEDIATE');
      database.exec(mutation);
      database.exec('COMMIT');
      expect(outbox.position()).toEqual({ kind: 'Corrupt' });
      // Restore the committed external mutation without relying on data_version.
      database
        .prepare(
          'UPDATE uploads SET starting_sequence = 0, ending_sequence = ?, chain_head_said = ?, encoded_bytes = ?, acknowledgement = NULL WHERE batch_said = ?',
        )
        .run(
          original.batch.endingSequence,
          original.events.at(-1)?.d ?? '',
          Buffer.byteLength(restored),
          original.batch.d,
        );
      database.exec(
        "UPDATE stream_state SET next_sequence = 130; UPDATE artifacts SET custody = 'Public'",
      );
      expect(outbox.position().kind).toBe('Position');
    }
    expect(repeatedDecodes).toBe(0);
    decode.mockClear();
    const independent = open(stateRoot);
    expect(decode.mock.calls.length).toBe(130);
    independent.close();
  } finally {
    database.close();
    outbox.close();
  }
}, 60_000);

it.each([
  { reason: 'entry count', count: 4097, artifactBytes: 0 },
  { reason: 'encoded bytes', count: 33, artifactBytes: 384 * 1024 },
])(
  'evicts verified uploads at the $reason bound and revalidates evicted bytes',
  ({ count, artifactBytes }) => {
    const outbox = open(root());
    const decode = vi.spyOn(protocol, 'decodeEvaluationEvidenceBatch');
    let previous: EvaluationEvidenceEvent | undefined;
    try {
      for (let index = 0; index < count; index++) {
        const bytes = Buffer.alloc(artifactBytes, index);
        const raw = prepareEvidenceArtifact(bytes, 'application/octet-stream');
        if (raw.kind !== 'Prepared') throw new Error('artifact');
        const next = event(
          index,
          previous === undefined
            ? { kind: 'Genesis' }
            : { kind: 'Previous', eventSaid: previous.d },
          artifactBytes === 0
            ? {
                kind: 'UsageDebited',
                providerRequests: 1,
                inputTokens: 1,
                outputTokens: 1,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                spendMicroUsd: 1,
                elapsedMilliseconds: 1,
              }
            : { kind: 'ModelExchange', rawArtifactSaid: raw.artifact.d },
        );
        expect(
          outbox.stage({
            commandId: randomUUID(),
            fingerprint: `sha256:${'a'.repeat(64)}`,
            events: [next],
            publicArtifacts: artifactBytes === 0 ? [] : [{ artifact: raw.artifact, bytes }],
            protectedArtifacts: [],
          }).kind,
        ).toBe('Staged');
        previous = next;
      }
      expect(outbox.position().kind).toBe('Position');
      decode.mockClear();
      expect(outbox.pending().kind).toBe('Pending');
      expect(decode).toHaveBeenCalledTimes(1);
      expect(outbox.pending().kind).toBe('Pending');
      expect(decode).toHaveBeenCalledTimes(1);
    } finally {
      outbox.close();
    }
  },
  60_000,
);

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

it('exposes the exact durable position and a staged batch following a stopped head', () => {
  const outbox = open(root());
  expect(outbox.position()).toEqual({
    kind: 'Position',
    nextSequence: 0,
    chainHeadSaid: null,
    acknowledgedSequence: -1,
    acknowledgedHeadSaid: null,
  });
  const bytes = new TextEncoder().encode('source');
  const artifact = prepareEvidenceArtifact(bytes, 'text/plain; charset=utf-8');
  if (artifact.kind !== 'Prepared') throw new Error('fixture artifact rejected');
  const first = event(
    0,
    { kind: 'Genesis' },
    {
      kind: 'ModelExchange',
      rawArtifactSaid: artifact.artifact.d,
    },
  );
  expect(
    outbox.stage({
      commandId: randomUUID(),
      fingerprint: `sha256:${'a'.repeat(64)}`,
      events: [first],
      publicArtifacts: [{ artifact: artifact.artifact, bytes }],
      protectedArtifacts: [],
    }).kind,
  ).toBe('Staged');
  expect(outbox.position()).toMatchObject({
    kind: 'Position',
    nextSequence: 1,
    chainHeadSaid: first.d,
    acknowledgedSequence: -1,
  });
  expect(outbox.following(null)).toMatchObject({
    kind: 'Found',
    upload: { events: [first] },
    acknowledgement: null,
  });
  expect(outbox.following(first.d)).toEqual({ kind: 'Empty' });
  outbox.close();
});

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

it('retains both provider report and receipt bytes through local acknowledgement recording and restart', () => {
  const stateRoot = root();
  const outbox = open(stateRoot);
  const reportBytes = new TextEncoder().encode('{"provider":"concentrate"}');
  const receiptBytes = new TextEncoder().encode('{"kind":"EvaluationProviderUsageReceipt"}');
  const report = prepareEvidenceArtifact(reportBytes, 'application/json');
  const receipt = prepareEvidenceArtifact(receiptBytes, 'application/json');
  if (report.kind !== 'Prepared' || receipt.kind !== 'Prepared')
    throw new Error('provider fixture artifact rejected');
  const trialEvent = (
    sequence: number,
    prior: EvaluationEvidenceEvent | undefined,
    detail: EvaluationEvidenceEvent['detail'],
  ) => {
    const prepared = prepareEvaluationEvidenceEvent({
      evaluationId: binding.evaluationId,
      streamId: binding.streamId,
      originRunId: binding.originRunId,
      taskId: binding.taskId,
      taskRevisionSaid: binding.taskRevisionSaid,
      personalAgentAid: binding.personalAgentAid,
      taskMandateSaid: binding.taskMandateSaid,
      harnessRevisionSaid: said('h'),
      phase: { kind: 'Trial', manifestSaid: said('m'), arm: 'H1', repetition: 1, attempt: 1 },
      sequence,
      previous:
        prior === undefined ? { kind: 'Genesis' } : { kind: 'Previous', eventSaid: prior.d },
      occurredAt: '2026-09-26T05:00:00.000Z',
      detail,
    });
    if (prepared.kind !== 'Prepared') throw new Error(prepared.reason);
    return prepared.event;
  };
  const capturedReport = trialEvent(0, undefined, {
    kind: 'ArtifactCaptured',
    artifactSaid: report.artifact.d,
    custody: 'Public',
  });
  expect(
    outbox.stage({
      commandId: randomUUID(),
      fingerprint: `sha256:${'a'.repeat(64)}`,
      events: [capturedReport],
      publicArtifacts: [{ artifact: report.artifact, bytes: reportBytes }],
      protectedArtifacts: [],
    }).kind,
  ).toBe('Staged');
  const verifiedTooSoon = trialEvent(1, capturedReport, {
    kind: 'ProviderUsageVerified',
    modelExchangeEventSaid: said('x'),
    receiptArtifactSaid: receipt.artifact.d,
    providerReportArtifactSaid: report.artifact.d,
    requestOrdinal: 0,
  });
  expect(
    outbox.stage({
      commandId: randomUUID(),
      fingerprint: `sha256:${'b'.repeat(64)}`,
      events: [verifiedTooSoon],
      publicArtifacts: [],
      protectedArtifacts: [],
    }),
  ).toEqual({ kind: 'Rejected' });
  const capturedReceipt = trialEvent(1, capturedReport, {
    kind: 'ArtifactCaptured',
    artifactSaid: receipt.artifact.d,
    custody: 'Public',
  });
  expect(
    outbox.stage({
      commandId: randomUUID(),
      fingerprint: `sha256:${'c'.repeat(64)}`,
      events: [capturedReceipt],
      publicArtifacts: [{ artifact: receipt.artifact, bytes: receiptBytes }],
      protectedArtifacts: [],
    }).kind,
  ).toBe('Staged');
  const verified = trialEvent(2, capturedReceipt, verifiedTooSoon.detail);
  expect(
    outbox.stage({
      commandId: randomUUID(),
      fingerprint: `sha256:${'d'.repeat(64)}`,
      events: [verified],
      publicArtifacts: [],
      protectedArtifacts: [],
    }).kind,
  ).toBe('Staged');
  for (const [sequence, head] of [capturedReport, capturedReceipt, verified].entries()) {
    const pending = outbox.pending();
    expect(pending.kind).toBe('Pending');
    if (pending.kind !== 'Pending') throw new Error(pending.kind);
    expect(
      outbox.acknowledge({
        version: 1,
        disposition: 'Accepted',
        evaluationId: binding.evaluationId,
        streamId: binding.streamId,
        batchSaid: pending.upload.batch.d,
        acceptedThroughSequence: sequence,
        chainHeadSaid: head.d,
      }),
    ).toEqual({ kind: 'Recorded' });
  }
  outbox.close();
  const reopened = open(stateRoot);
  expect(reopened.position()).toMatchObject({
    acknowledgedSequence: 2,
    acknowledgedHeadSaid: verified.d,
  });
  expect(reopened.pending()).toEqual({ kind: 'Empty' });
  reopened.close();
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

it('reopens only hosted-acknowledged protected ciphertext by exact SAID and rejects substituted custody', () => {
  const stateRoot = root();
  const prepared = prepareProtectedEvaluationArtifact({
    evaluationId: binding.evaluationId,
    objectSaid: said('x'),
    purpose: 'OracleObservation',
    segment: 0,
    nonce: 'a'.repeat(16),
    tag: 'b'.repeat(22),
    ciphertext: 'YWJjZA',
    plaintextByteCount: 4,
  });
  if (prepared.kind !== 'Prepared') throw new Error(prepared.reason);
  const captured = prepareEvaluationEvidenceEvent({
    evaluationId: binding.evaluationId,
    streamId: binding.streamId,
    originRunId: binding.originRunId,
    taskId: binding.taskId,
    taskRevisionSaid: binding.taskRevisionSaid,
    personalAgentAid: binding.personalAgentAid,
    taskMandateSaid: binding.taskMandateSaid,
    harnessRevisionSaid: said('h'),
    phase: { kind: 'Trial', manifestSaid: said('m'), arm: 'H1', repetition: 1, attempt: 1 },
    sequence: 0,
    previous: { kind: 'Genesis' },
    occurredAt: '2026-09-26T05:00:00.000Z',
    detail: {
      kind: 'ArtifactCaptured',
      artifactSaid: prepared.artifact.d,
      custody: 'ProtectedCiphertext',
    },
  });
  if (captured.kind !== 'Prepared') throw new Error(captured.reason);
  const outbox = open(stateRoot);
  expect(
    outbox.stage({
      commandId: randomUUID(),
      fingerprint: `sha256:${'a'.repeat(64)}`,
      events: [captured.event],
      publicArtifacts: [],
      protectedArtifacts: [prepared.artifact],
    }).kind,
  ).toBe('Staged');
  expect(outbox.protectedArtifact(prepared.artifact.d)).toEqual({ kind: 'Missing' });
  const pending = outbox.pending();
  if (pending.kind !== 'Pending') throw new Error(pending.kind);
  expect(
    outbox.acknowledge({
      version: 1,
      disposition: 'Accepted',
      evaluationId: binding.evaluationId,
      streamId: binding.streamId,
      batchSaid: pending.upload.batch.d,
      acceptedThroughSequence: 0,
      chainHeadSaid: captured.event.d,
    }),
  ).toEqual({ kind: 'Recorded' });
  outbox.close();

  const reopened = open(stateRoot);
  expect(reopened.protectedArtifact(prepared.artifact.d)).toEqual({
    kind: 'Found',
    artifact: prepared.artifact,
  });
  const exposed = reopened.protectedArtifact(prepared.artifact.d);
  if (exposed.kind !== 'Found') throw new Error('protected artifact');
  Object.assign(exposed.artifact, { ciphertext: 'changed' });
  expect(reopened.protectedArtifact(prepared.artifact.d)).toEqual({
    kind: 'Found',
    artifact: prepared.artifact,
  });
  expect(reopened.protectedArtifact(said('z'))).toEqual({ kind: 'Missing' });
  const database = new DatabaseSync(
    join(stateRoot, 'evaluations', binding.evaluationId, 'outbox.sqlite'),
  );
  database
    .prepare('UPDATE artifacts SET custody = ? WHERE artifact_said = ?')
    .run('Public', prepared.artifact.d);
  database.close();
  expect(reopened.protectedArtifact(prepared.artifact.d)).toEqual({ kind: 'Corrupt' });
  reopened.close();
});

it('retains raw bytes before an event and recovers only unstaged artifacts after reopening', () => {
  const stateRoot = root();
  let outbox = open(stateRoot);
  const bytes = new TextEncoder().encode('parent observation before event');
  const prepared = prepareEvidenceArtifact(bytes, 'text/plain; charset=utf-8');
  if (prepared.kind !== 'Prepared') throw new Error('artifact');
  expect(outbox.retainPublicArtifact({ artifact: prepared.artifact, bytes })).toEqual({
    kind: 'Stored',
  });
  outbox.close();
  outbox = open(stateRoot);
  const first = event(
    0,
    { kind: 'Genesis' },
    { kind: 'ModelExchange', rawArtifactSaid: prepared.artifact.d },
  );
  expect(outbox.unstagedPublicArtifacts()).toEqual({
    kind: 'Found',
    artifacts: [{ artifact: prepared.artifact, bytes }],
  });
  expect(
    outbox.stage({
      commandId: randomUUID(),
      fingerprint: 'sha256:' + '1'.repeat(64),
      events: [first],
      publicArtifacts: [{ artifact: prepared.artifact, bytes }],
      protectedArtifacts: [],
    }),
  ).toMatchObject({ kind: 'Staged' });
  expect(outbox.unstagedPublicArtifacts()).toEqual({ kind: 'Found', artifacts: [] });
  expect(outbox.retainPublicArtifact({ artifact: prepared.artifact, bytes })).toEqual({
    kind: 'Stored',
  });
  expect(outbox.unstagedPublicArtifacts()).toEqual({ kind: 'Found', artifacts: [] });
  expect(
    outbox.retainPublicArtifact({ artifact: prepared.artifact, bytes: new Uint8Array([1]) }),
  ).toEqual({ kind: 'Rejected' });
  outbox.close();
});
