import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';
import { prepareEvaluationEvidenceEvent, prepareEvidenceArtifact } from '@devrandom/protocol';

import type { ServerEvaluationHttp } from './server-evaluation-http.js';

import { HostedEvaluationEvidenceReading } from './hosted-evaluation-evidence-reading.js';

const said = (letter: string): string => `E${letter.repeat(43)}`;

function fixture() {
  const binding = {
    kind: 'Evaluation' as const,
    evaluationId: randomUUID(),
    evaluationLeaseId: randomUUID(),
    evidenceStreamId: randomUUID(),
    originRunId: randomUUID(),
    taskId: randomUUID(),
    taskRevisionSaid: said('t'),
    personalAgentAid: said('a'),
    taskMandateSaid: said('m'),
    harnessRevisionSaid: said('h'),
    phase: {
      kind: 'Trial' as const,
      manifestSaid: said('v'),
      arm: 'H1' as const,
      repetition: 1 as const,
      attempt: 1 as const,
    },
  };
  const first = prepareEvaluationEvidenceEvent({
    evaluationId: binding.evaluationId,
    streamId: binding.evidenceStreamId,
    originRunId: binding.originRunId,
    taskId: binding.taskId,
    taskRevisionSaid: binding.taskRevisionSaid,
    personalAgentAid: binding.personalAgentAid,
    taskMandateSaid: binding.taskMandateSaid,
    harnessRevisionSaid: binding.harnessRevisionSaid,
    phase: binding.phase,
    sequence: 0,
    previous: { kind: 'Genesis' },
    occurredAt: '2026-09-26T10:00:00.000Z',
    detail: { kind: 'TrialStopped', reason: 'Completed' },
  });
  if (first.kind !== 'Prepared') throw new Error(first.reason);
  return { binding, first: first.event };
}

describe('hosted accepted Evaluation evidence reading', () => {
  it('does not accept a claimed page whose event SAID or requested head differs', async () => {
    const { binding, first } = fixture();
    const readEvidencePage = vi.fn(() =>
      Promise.resolve({
        kind: 'Read' as const,
        page: {
          version: 1 as const,
          evaluationId: binding.evaluationId,
          streamId: binding.evidenceStreamId,
          afterSequence: -1,
          throughSequence: 0,
          throughHeadSaid: first.d,
          events: [
            { ...first, detail: { kind: 'TrialStopped' as const, reason: 'Invalid' as const } },
          ],
        },
      }),
    );
    const reading = new HostedEvaluationEvidenceReading({
      readEvidencePage,
      readPublicArtifact: vi.fn(),
    });
    const phase = binding.phase;
    const decodedBinding = {
      ...binding,
      phase: {
        attempt: phase.attempt,
        repetition: phase.repetition,
        arm: phase.arm,
        manifestSaid: phase.manifestSaid,
        kind: phase.kind,
      },
    };
    expect(
      await reading.openPrefix({ binding: decodedBinding, throughSequence: 0, headSaid: first.d }),
    ).toEqual({
      kind: 'Missing',
    });
    expect(readEvidencePage).toHaveBeenCalledOnce();
  });

  it('accepts only a complete exact accepted chain through the requested head', async () => {
    const { binding, first } = fixture();
    const readEvidencePage = vi.fn(() =>
      Promise.resolve({
        kind: 'Read' as const,
        page: {
          version: 1 as const,
          evaluationId: binding.evaluationId,
          streamId: binding.evidenceStreamId,
          afterSequence: -1,
          throughSequence: 0,
          throughHeadSaid: first.d,
          events: [first],
        },
      }),
    );
    const reading = new HostedEvaluationEvidenceReading({
      readEvidencePage,
      readPublicArtifact: vi.fn(),
    });
    const phase = binding.phase;
    const decodedBinding = {
      ...binding,
      phase: {
        attempt: phase.attempt,
        repetition: phase.repetition,
        arm: phase.arm,
        manifestSaid: phase.manifestSaid,
        kind: phase.kind,
      },
    };
    expect(
      await reading.openPrefix({ binding: decodedBinding, throughSequence: 0, headSaid: first.d }),
    ).toEqual({
      kind: 'Acknowledged',
      events: [first],
      throughSequence: 0,
      headSaid: first.d,
    });
  });

  it('rejects substituted public raw bytes even when the host claims they were read', async () => {
    const { binding } = fixture();
    const prepared = prepareEvidenceArtifact(
      new TextEncoder().encode('actual'),
      'application/json',
    );
    if (prepared.kind !== 'Prepared') throw new Error(prepared.reason);
    const reading = new HostedEvaluationEvidenceReading({
      readEvidencePage: vi.fn(),
      readPublicArtifact: vi.fn(() =>
        Promise.resolve({
          kind: 'Read' as const,
          artifact: prepared.artifact,
          bytes: new TextEncoder().encode('substituted'),
        }),
      ),
    });
    expect(
      await reading.openPublic({
        evaluationId: binding.evaluationId,
        artifactSaid: prepared.artifact.d,
      }),
    ).toEqual({ kind: 'Missing' });
  });
});

function eventInput(event: ReturnType<typeof fixture>['first']) {
  const { d: _said, version: _version, ...input } = event;
  expect(_said).toHaveLength(44);
  expect(_version).toBe(1);
  return input;
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing test fixture');
  return value;
}

function chain(length: number) {
  const { binding, first } = fixture();
  const events = [first];
  for (let sequence = 1; sequence < length; sequence++) {
    const prepared = prepareEvaluationEvidenceEvent({
      ...eventInput(first),
      sequence,
      previous: { kind: 'Previous', eventSaid: required(events[sequence - 1]).d },
    });
    if (prepared.kind !== 'Prepared') throw new Error(prepared.reason);
    events.push(prepared.event);
  }
  const readEvidencePage = vi.fn<ServerEvaluationHttp['readEvidencePage']>(
    (input: {
      evaluationId: string;
      afterSequence: number;
      throughSequence: number;
      throughHeadSaid: string;
    }) =>
      Promise.resolve({
        kind: 'Read' as const,
        page: {
          version: 1 as const,
          ...input,
          streamId: binding.evidenceStreamId,
          events: events.slice(
            input.afterSequence + 1,
            Math.min(input.afterSequence + 33, input.throughSequence + 1),
          ),
        },
      }),
  );
  const reading = new HostedEvaluationEvidenceReading({
    readEvidencePage,
    readPublicArtifact: vi.fn(),
  });
  const open = (sequence: number) =>
    reading.openPrefix({
      binding,
      throughSequence: sequence,
      headSaid: required(events[sequence]).d,
    });
  return { binding, events, readEvidencePage, reading, open };
}

describe('immutable hosted evidence reuse', () => {
  it('fetches a verified 65-event prefix once, then only its extension (9 mock HTTP reads become 4)', async () => {
    const { open, readEvidencePage } = chain(66);
    expect((await open(64)).kind).toBe('Acknowledged');
    expect((await open(64)).kind).toBe('Acknowledged');
    expect(readEvidencePage).toHaveBeenCalledTimes(3);
    expect((await open(65)).kind).toBe('Acknowledged');
    expect(readEvidencePage).toHaveBeenCalledTimes(4);
    // Exact historical reads cannot roll the retained prefix back.
    expect((await open(0)).kind).toBe('Acknowledged');
    expect((await open(65)).kind).toBe('Acknowledged');
    expect(readEvidencePage).toHaveBeenCalledTimes(4);
    expect(readEvidencePage.mock.lastCall?.[0].afterSequence).toBe(64);
  });

  it('isolates returned events and rejects wrong scope, head, phase and a forked extension', async () => {
    const { open, reading, binding, events } = chain(3);
    const accepted = await open(1);
    expect(accepted.kind).toBe('Acknowledged');
    if (accepted.kind !== 'Acknowledged') throw new Error('prefix');
    Object.assign(required(accepted.events[0]), { taskId: randomUUID() });
    expect((await open(1)).kind).toBe('Acknowledged');
    for (const changed of [
      { evaluationId: randomUUID() },
      { evidenceStreamId: randomUUID() },
      { taskId: randomUUID() },
      { harnessRevisionSaid: said('x') },
      { phase: { ...binding.phase, repetition: 2 as const } },
    ]) {
      expect(
        (
          await reading.openPrefix({
            binding: { ...binding, ...changed },
            throughSequence: 1,
            headSaid: required(events[1]).d,
          })
        ).kind,
      ).toBe('Missing');
    }
    expect(
      (await reading.openPrefix({ binding, throughSequence: 1, headSaid: said('x') })).kind,
    ).toBe('Missing');
    const fork = prepareEvaluationEvidenceEvent({
      ...eventInput(required(events[2])),
      previous: { kind: 'Previous', eventSaid: said('x') },
    });
    if (fork.kind !== 'Prepared') throw new Error(fork.reason);
    events[2] = fork.event;
    expect((await open(2)).kind).toBe('Missing');
    expect((await open(1)).kind).toBe('Acknowledged');
  });

  it('never retains a partial prefix when its final acknowledgement is unavailable', async () => {
    const { open, readEvidencePage } = chain(33);
    const original = required(readEvidencePage.getMockImplementation());
    readEvidencePage
      .mockImplementationOnce(original)
      .mockImplementationOnce(() => Promise.resolve({ kind: 'Unavailable' }));
    expect((await open(32)).kind).toBe('Unavailable');
    expect((await open(32)).kind).toBe('Acknowledged');
    expect(readEvidencePage.mock.calls.map(([input]) => input.afterSequence)).toEqual([
      -1, 31, -1, 31,
    ]);
  });

  it('bounds retained prefixes to one scope and refetches on scope eviction', async () => {
    const a = chain(1);
    const b = chain(1);
    a.readEvidencePage
      .mockImplementationOnce(required(a.readEvidencePage.getMockImplementation()))
      .mockImplementationOnce(required(b.readEvidencePage.getMockImplementation()));
    expect((await a.open(0)).kind).toBe('Acknowledged');
    expect(
      (
        await a.reading.openPrefix({
          binding: b.binding,
          throughSequence: 0,
          headSaid: required(b.events[0]).d,
        })
      ).kind,
    ).toBe('Acknowledged');
    expect((await a.open(0)).kind).toBe('Acknowledged');
    expect(a.readEvidencePage).toHaveBeenCalledTimes(3);
  });

  it.each([1, 512 * 1024])(
    'bounds artifact count and bytes with correct eviction fallback (%i-byte artifacts)',
    async (size) => {
      const evaluationId = randomUUID();
      const artifacts = Array.from({ length: size === 1 ? 129 : 17 }, (_, ordinal) => {
        const bytes = new Uint8Array(size).fill(ordinal);
        const prepared = prepareEvidenceArtifact(bytes, 'application/json');
        if (prepared.kind !== 'Prepared') throw new Error(prepared.reason);
        return { artifact: prepared.artifact, bytes };
      });
      const readPublicArtifact = vi.fn<ServerEvaluationHttp['readPublicArtifact']>(
        (input: { evaluationId: string; artifactSaid: string }) => {
          const artifact = required(
            artifacts.find((entry) => entry.artifact.d === input.artifactSaid),
          );
          return Promise.resolve({ kind: 'Read' as const, ...artifact });
        },
      );
      const reading = new HostedEvaluationEvidenceReading({
        readEvidencePage: vi.fn(),
        readPublicArtifact,
      });
      const open = (ordinal: number) =>
        reading.openPublic({ evaluationId, artifactSaid: required(artifacts[ordinal]).artifact.d });
      const first = await open(0);
      if (first.kind !== 'Opened') throw new Error('artifact');
      first.bytes.fill(255);
      Object.assign(first.artifact, { mediaType: 'text/plain' });
      const repeated = await open(0);
      expect(repeated.kind).toBe('Opened');
      if (repeated.kind === 'Opened') expect(repeated.bytes.every((byte) => byte === 0)).toBe(true);
      expect(readPublicArtifact).toHaveBeenCalledTimes(1);
      for (let i = 1; i < artifacts.length; i++) expect((await open(i)).kind).toBe('Opened');
      expect((await open(0)).kind).toBe('Opened');
      expect(readPublicArtifact).toHaveBeenCalledTimes(artifacts.length + 1);
      await reading.openPublic({
        evaluationId: randomUUID(),
        artifactSaid: required(artifacts[0]).artifact.d,
      });
      expect(readPublicArtifact).toHaveBeenCalledTimes(artifacts.length + 2);
      readPublicArtifact.mockResolvedValueOnce({ kind: 'Unavailable' });
      expect((await open(1)).kind).toBe('Unavailable');
    },
  );

  it('does not retain prefixes over the byte bound and preserves uncached exact reads', async () => {
    const { open, events, readEvidencePage, reading, binding } = chain(10_000);
    expect(Buffer.byteLength(JSON.stringify(events))).toBeGreaterThan(8 * 1024 * 1024);
    expect((await open(9_999)).kind).toBe('Acknowledged');
    expect((await open(9_999)).kind).toBe('Acknowledged');
    expect(readEvidencePage).toHaveBeenCalledTimes(626);
    expect(
      (
        await reading.openPrefix({
          binding,
          throughSequence: 10_000,
          headSaid: required(events.at(-1)).d,
        })
      ).kind,
    ).toBe('Missing');
    expect(readEvidencePage).toHaveBeenCalledTimes(626);
  });

  it('does not share artifact membership between evaluations or reader instances', async () => {
    const prepared = prepareEvidenceArtifact(new Uint8Array([1]), 'application/json');
    if (prepared.kind !== 'Prepared') throw new Error(prepared.reason);
    const readPublicArtifact = vi
      .fn<ServerEvaluationHttp['readPublicArtifact']>()
      .mockResolvedValueOnce({
        kind: 'Read',
        artifact: prepared.artifact,
        bytes: new Uint8Array([1]),
      })
      .mockResolvedValue({ kind: 'Denied' });
    const http = { readPublicArtifact, readEvidencePage: vi.fn() };
    const reading = new HostedEvaluationEvidenceReading(http);
    const input = { evaluationId: randomUUID(), artifactSaid: prepared.artifact.d };
    expect((await reading.openPublic(input)).kind).toBe('Opened');
    expect((await reading.openPublic(input)).kind).toBe('Opened');
    expect((await reading.openPublic({ ...input, evaluationId: randomUUID() })).kind).toBe(
      'Missing',
    );
    expect((await new HostedEvaluationEvidenceReading(http).openPublic(input)).kind).toBe(
      'Missing',
    );
    expect(readPublicArtifact).toHaveBeenCalledTimes(3);
  });

  it('does not cache unacknowledged artifacts or transport failures', async () => {
    const { binding } = fixture();
    const readPublicArtifact = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'Missing' })
      .mockResolvedValueOnce({ kind: 'Unavailable' });
    const reading = new HostedEvaluationEvidenceReading({
      readEvidencePage: vi.fn(),
      readPublicArtifact,
    });
    const input = { evaluationId: binding.evaluationId, artifactSaid: said('x') };
    expect(await reading.openPublic(input)).toEqual({ kind: 'Missing' });
    expect(await reading.openPublic(input)).toEqual({ kind: 'Unavailable' });
    expect(readPublicArtifact).toHaveBeenCalledTimes(2);
  });
});
