import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { prepareEvaluationEvidenceEvent } from '@devrandom/protocol';
import { expect, it, vi } from 'vitest';
import { SqliteEvaluationEvidenceOutbox } from './sqlite-evaluation-evidence-outbox.js';
import type { ServerEvaluationHttp } from './server-evaluation-http.js';
import { SqliteHostedEvaluationEvidence } from './sqlite-hosted-evaluation-evidence.js';

it('retries the exact durable batch after a lost response and does not duplicate raw artifacts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'devrandom-evaluation-delivery-'));
  const said = (s: string) => `E${s.repeat(43)}`;
  const binding = {
    ownerAid: said('o'),
    evaluationId: randomUUID(),
    streamId: randomUUID(),
    originRunId: randomUUID(),
    taskId: randomUUID(),
    taskRevisionSaid: said('t'),
    personalAgentAid: said('a'),
    taskMandateSaid: said('m'),
  };
  const opened = SqliteEvaluationEvidenceOutbox.open(root, binding);
  if (opened.kind !== 'Opened') throw new Error('outbox');
  const appendEvidence = vi
    .fn()
    .mockResolvedValueOnce({ kind: 'Unavailable' })
    .mockImplementation((upload: Parameters<ServerEvaluationHttp['appendEvidence']>[0]) =>
      Promise.resolve({
        kind: 'Acknowledged',
        acknowledgement: {
          version: 1,
          disposition: 'AlreadyAccepted',
          evaluationId: binding.evaluationId,
          streamId: binding.streamId,
          batchSaid: upload.batch.d,
          acceptedThroughSequence: upload.batch.endingSequence,
          chainHeadSaid: upload.events.at(-1)?.d,
        },
      }),
    );
  try {
    const adapter = new SqliteHostedEvaluationEvidence(opened.outbox, { appendEvidence });
    const raw = await adapter.rawArtifacts.record({
      bytes: new TextEncoder().encode('native observation'),
      mediaType: 'text/plain; charset=utf-8',
    });
    if (raw.kind !== 'Stored') throw new Error('raw');
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
      occurredAt: '2026-09-26T12:00:00.000Z',
      detail: { kind: 'ArtifactCaptured', artifactSaid: raw.artifact.d, custody: 'Public' },
    });
    if (prepared.kind !== 'Prepared') throw new Error('event');
    expect(await adapter.record(prepared.event)).toEqual({ kind: 'Unavailable' });
    const recovered = new SqliteHostedEvaluationEvidence(opened.outbox, { appendEvidence });
    expect(await recovered.record(prepared.event)).toEqual({
      kind: 'Recorded',
      sequence: 0,
      headSaid: prepared.event.d,
    });
    expect(appendEvidence.mock.calls[1]?.[0]).toEqual(appendEvidence.mock.calls[0]?.[0]);
    const following = vi.spyOn(opened.outbox, 'following');
    expect(
      await recovered.acknowledge({
        evaluationId: binding.evaluationId,
        streamId: binding.streamId,
        fromSequence: 0,
        throughSequence: 0,
        expectedHeadSaid: prepared.event.d,
      }),
    ).toEqual({ kind: 'Acknowledged', throughSequence: 0, headSaid: prepared.event.d });
    expect(following).not.toHaveBeenCalled();
    expect(
      await recovered.acknowledge({
        evaluationId: randomUUID(),
        streamId: binding.streamId,
        fromSequence: 0,
        throughSequence: 0,
        expectedHeadSaid: prepared.event.d,
      }),
    ).toEqual({ kind: 'Conflict' });
    expect(await recovered.record({ ...prepared.event, sequence: 1 })).toEqual({
      kind: 'Conflict',
    });
    let headSaid = prepared.event.d;
    for (let sequence = 1; sequence < 130; sequence++) {
      const artifact = await recovered.rawArtifacts.record({
        bytes: new TextEncoder().encode(`native observation ${String(sequence)}`),
        mediaType: 'text/plain; charset=utf-8',
      });
      if (artifact.kind !== 'Stored') throw new Error('raw');
      const event = prepareEvaluationEvidenceEvent({
        evaluationId: binding.evaluationId,
        streamId: binding.streamId,
        originRunId: binding.originRunId,
        taskId: binding.taskId,
        taskRevisionSaid: binding.taskRevisionSaid,
        personalAgentAid: binding.personalAgentAid,
        taskMandateSaid: binding.taskMandateSaid,
        harnessRevisionSaid: said('h'),
        phase: prepared.event.phase,
        occurredAt: prepared.event.occurredAt,
        sequence,
        previous: { kind: 'Previous', eventSaid: headSaid },
        detail: { kind: 'ArtifactCaptured', artifactSaid: artifact.artifact.d, custody: 'Public' },
      });
      if (event.kind !== 'Prepared') throw new Error('event');
      expect((await recovered.record(event.event)).kind).toBe('Recorded');
      headSaid = event.event.d;
    }
    following.mockClear();
    const position = vi.spyOn(opened.outbox, 'position');
    const inspection = vi.spyOn(opened.outbox, 'acknowledgedPrefix');
    const prefix = {
      evaluationId: binding.evaluationId,
      streamId: binding.streamId,
      fromSequence: 0,
      throughSequence: 129,
      expectedHeadSaid: headSaid,
    };
    expect(await recovered.acknowledge(prefix)).toEqual({
      kind: 'Acknowledged',
      throughSequence: 129,
      headSaid,
    });
    expect(inspection).toHaveBeenCalledTimes(1);
    expect(following).not.toHaveBeenCalled();
    expect(position).not.toHaveBeenCalled();
    for (const mismatch of [
      { streamId: randomUUID() },
      { expectedHeadSaid: prepared.event.d },
      { throughSequence: 128 },
      { fromSequence: -1 },
      { fromSequence: 130 },
    ])
      expect(await recovered.acknowledge({ ...prefix, ...mismatch })).toEqual({ kind: 'Conflict' });
    const database = new DatabaseSync(
      join(root, 'evaluations', binding.evaluationId, 'outbox.sqlite'),
    );
    try {
      database
        .prepare(
          "UPDATE uploads SET acknowledgement = json_set(acknowledgement, '$.chainHeadSaid', ?) WHERE ending_sequence = 0",
        )
        .run(said('f'));
      expect(await recovered.acknowledge(prefix)).toEqual({ kind: 'Unavailable' });
    } finally {
      database.close();
    }
  } finally {
    opened.outbox.close();
    rmSync(root, { recursive: true, force: true });
  }
});
