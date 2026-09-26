import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    expect(
      await recovered.acknowledge({
        evaluationId: binding.evaluationId,
        streamId: binding.streamId,
        fromSequence: 0,
        throughSequence: 0,
        expectedHeadSaid: prepared.event.d,
      }),
    ).toEqual({ kind: 'Acknowledged', throughSequence: 0, headSaid: prepared.event.d });
    expect(await recovered.record({ ...prepared.event, sequence: 1 })).toEqual({
      kind: 'Conflict',
    });
  } finally {
    opened.outbox.close();
    rmSync(root, { recursive: true, force: true });
  }
});
