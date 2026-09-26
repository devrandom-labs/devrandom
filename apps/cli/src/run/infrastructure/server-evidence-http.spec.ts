import { createServer } from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import {
  prepareEvidenceArtifact,
  prepareEvidenceBatch,
  prepareEvidenceEvent,
  type EvidenceBatchAcknowledgement,
} from '@devrandom/protocol';

import { decodeDevrandomServerOrigin } from '../../infrastructure/devrandom-server-http.js';
import { ServerEvidenceHttp } from './server-evidence-http.js';

const runId = '1cc482f1-98e9-4454-8e4c-5566cb47ce3d';
const streamId = 'a30aae94-a652-485f-a2cc-8980134f4acc';
const bearer = 'a'.repeat(43);
const said = (character: string) => `E${character.repeat(43)}`;

function fixture() {
  const bytes = new TextEncoder().encode('evidence output\n');
  const artifact = prepareEvidenceArtifact(bytes, 'text/plain; charset=utf-8');
  if (artifact.kind !== 'Prepared') {
    throw new Error('artifact fixture must prepare');
  }
  const event = prepareEvidenceEvent({
    version: 1,
    sequence: 0,
    predecessor: { kind: 'Genesis' },
    taskId: '4df838a8-5109-49fd-bdad-805880a3ecee',
    taskRevisionSaid: said('a'),
    runId,
    incarnationId: 'ee87e11d-fb5f-46b4-841f-8a7a5faad97c',
    harnessRevisionSaid: said('b'),
    personalAgentAid: said('c'),
    taskMandateSaid: said('d'),
    occurredAt: '2026-09-24T20:00:00.000Z',
    recordedAt: '2026-09-24T20:00:00.001Z',
    producer: { kind: 'EvidenceRecorder' },
    event: { kind: 'Observation', source: 'ToolEffect', artifactSaid: artifact.artifact.d },
  });
  if (event.kind !== 'Prepared') {
    throw new Error('event fixture must prepare');
  }
  const batch = prepareEvidenceBatch({
    version: 1,
    runId,
    evidenceStreamId: streamId,
    events: [event.event],
  });
  if (batch.kind !== 'Prepared') {
    throw new Error('batch fixture must prepare');
  }
  const acknowledgement: EvidenceBatchAcknowledgement = {
    version: 1,
    disposition: { kind: 'Accepted' },
    runId,
    evidenceStreamId: streamId,
    batchSaid: batch.batch.d,
    acceptedThroughSequence: 0,
    chainHeadSaid: event.event.d,
    receivedAt: '2026-09-24T20:00:01.000Z',
  };
  return {
    bytes,
    artifact: artifact.artifact,
    event: event.event,
    batch: batch.batch,
    acknowledgement,
  };
}

function origin() {
  const decoded = decodeDevrandomServerOrigin('http://127.0.0.1:3000');
  if (decoded.kind !== 'Accepted') {
    throw new Error('server origin fixture must decode');
  }
  return decoded.origin;
}

describe('Server Evidence HTTP adapter', () => {
  it('reports a connection lost during the response body as unavailable', async () => {
    const server = createServer((request, response) => {
      request.resume();
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': 'application/json',
        'content-length': '100',
      });
      response.write('{');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('missing HTTP address');
      const decoded = decodeDevrandomServerOrigin(`http://127.0.0.1:${String(address.port)}`);
      if (decoded.kind !== 'Accepted') throw new Error('invalid test origin');
      const evidence = new ServerEvidenceHttp(decoded.origin, bearer, async (input, init) => {
        const response = await fetch(input, init);
        server.closeAllConnections();
        return response;
      });
      await expect(
        evidence.reconcileSeal(runId, { version: 1, sealExchangeSaid: said('s') }),
      ).resolves.toEqual({ kind: 'ServerUnavailable' });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
    }
  });
  it('clears its request deadline after rejecting malformed JSON', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const evidence = new ServerEvidenceHttp(origin(), bearer, () =>
        Promise.resolve(
          new Response('{invalid', { status: 200, headers: { 'cache-control': 'no-store' } }),
        ),
      );
      await expect(
        evidence.reconcileSeal(runId, { version: 1, sealExchangeSaid: said('s') }),
      ).resolves.toEqual({ kind: 'ResponseInvalid' });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it.each(['Headers', 'Body'] as const)(
    'bounds a stalled %s response at the real HTTP boundary',
    async (stage) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const requested = Promise.withResolvers<undefined>();
      const received = Promise.withResolvers<undefined>();
      const server = createServer((request, response) => {
        request.resume();
        if (stage === 'Body') {
          response.writeHead(200, {
            'cache-control': 'no-store',
            'content-type': 'application/json',
          });
          response.write('{');
        }
        requested.resolve(undefined);
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      let pending: Promise<void> | undefined;
      try {
        const address = server.address();
        if (address === null || typeof address === 'string')
          throw new Error('missing HTTP address');
        const decoded = decodeDevrandomServerOrigin(`http://127.0.0.1:${String(address.port)}`);
        if (decoded.kind !== 'Accepted') throw new Error('invalid test origin');
        const evidence = new ServerEvidenceHttp(decoded.origin, bearer, async (input, init) => {
          const response = await fetch(input, init);
          received.resolve(undefined);
          return response;
        });
        const settled = vi.fn();
        pending = evidence
          .reconcileSeal(runId, { version: 1, sealExchangeSaid: said('s') })
          .then(settled);
        await requested.promise;
        if (stage === 'Body') await received.promise;
        await vi.advanceTimersByTimeAsync(9_999);
        expect(settled).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await new Promise((resolve) => setImmediate(resolve));
        expect(settled).toHaveBeenCalledExactlyOnceWith({ kind: 'ServerUnavailable' });
      } finally {
        server.closeAllConnections();
        await pending;
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error === undefined) resolve();
            else reject(error);
          });
        });
        vi.useRealTimers();
      }
    },
  );
  it.each(['artifact', 'batch'] as const)(
    'cancels an in-flight %s upload over HTTP',
    async (upload) => {
      const requested = Promise.withResolvers<undefined>();
      const server = createServer((request) => {
        request.resume();
        requested.resolve(undefined);
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const address = server.address();
        if (address === null || typeof address === 'string')
          throw new Error('missing HTTP address');
        const decoded = decodeDevrandomServerOrigin(`http://127.0.0.1:${String(address.port)}`);
        if (decoded.kind !== 'Accepted') throw new Error('invalid HTTP test origin');
        const evidence = new ServerEvidenceHttp(decoded.origin, bearer, fetch);
        const cancellation = new AbortController();
        const data = fixture();
        const pending =
          upload === 'artifact'
            ? evidence.storeArtifact(runId, data.artifact, data.bytes, cancellation.signal)
            : evidence.appendBatch(
                runId,
                { version: 1, batch: data.batch, events: [data.event] },
                cancellation.signal,
              );
        await requested.promise;
        cancellation.abort();
        await expect(pending).resolves.toEqual({ kind: 'ServerUnavailable' });
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          }),
        );
      }
    },
  );

  it('preserves a pending personal-agent evidence-seal reconciliation', async () => {
    const sealExchangeSaid = said('s');
    const stream = {
      version: 1 as const,
      runId,
      evidenceStreamId: streamId,
      cursor: {
        kind: 'Accepted' as const,
        eventCount: 1,
        acceptedThroughSequence: 0,
        chainHeadSaid: said('h'),
      },
      checkpoint: { kind: 'Accepted' as const, checkpointSaid: said('c') },
      seal: { kind: 'SealExchangePending' as const, sealExchangeSaid },
    };
    const fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe('PUT');
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${bearer}`);
      expect(init?.body).toBe(JSON.stringify({ version: 1, sealExchangeSaid }));
      return Promise.resolve(
        new Response(JSON.stringify(stream), {
          status: 202,
          headers: { 'cache-control': 'no-store', 'content-type': 'application/json' },
        }),
      );
    });
    const evidence = new ServerEvidenceHttp(origin(), bearer, fetch);

    await expect(evidence.reconcileSeal(runId, { version: 1, sealExchangeSaid })).resolves.toEqual({
      kind: 'Pending',
      stream,
    });
    expect(fetch).toHaveBeenCalledWith(
      `http://127.0.0.1:3000/api/runs/${runId}/evidence-seal`,
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('accepts status 200 only for the exact sealed stream', async () => {
    const sealExchangeSaid = said('s');
    const stream = {
      version: 1 as const,
      runId,
      evidenceStreamId: streamId,
      cursor: {
        kind: 'Accepted' as const,
        eventCount: 1,
        acceptedThroughSequence: 0,
        chainHeadSaid: said('h'),
      },
      checkpoint: { kind: 'Accepted' as const, checkpointSaid: said('c') },
      seal: {
        kind: 'Sealed' as const,
        sealExchangeSaid,
        eventCount: 1,
        finalSequence: 0,
        chainHeadSaid: said('h'),
        sealedAt: '2026-09-24T20:00:02.000Z',
      },
    };
    const fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(stream), {
          status: 200,
          headers: { 'cache-control': 'no-store', 'content-type': 'application/json' },
        }),
      ),
    );
    const evidence = new ServerEvidenceHttp(origin(), bearer, fetch);

    await expect(evidence.reconcileSeal(runId, { version: 1, sealExchangeSaid })).resolves.toEqual({
      kind: 'Sealed',
      stream,
    });
  });

  it('polls one bounded timeline page using only the opaque server cursor', async () => {
    const page = {
      version: 1 as const,
      stream: {
        version: 1 as const,
        runId,
        evidenceStreamId: streamId,
        cursor: { kind: 'Empty' as const },
        checkpoint: { kind: 'Absent' as const },
        seal: { kind: 'Unsealed' as const },
      },
      events: [],
      nextCursor: 'opaque-tail',
    };
    const fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe('GET');
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${bearer}`);
      return Promise.resolve(
        new Response(JSON.stringify(page), {
          status: 200,
          headers: { 'cache-control': 'no-store', 'content-type': 'application/json' },
        }),
      );
    });
    const evidence = new ServerEvidenceHttp(origin(), bearer, fetch);

    await expect(evidence.inspect(runId, { limit: 25, cursor: 'opaque-cursor' })).resolves.toEqual({
      kind: 'Found',
      page,
    });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      `http://127.0.0.1:3000/api/runs/${runId}/timeline?limit=25&cursor=opaque-cursor`,
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('uploads exact raw bytes with their artifact media type and validates the acknowledgement', async () => {
    const value = fixture();
    const fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(init?.method).toBe('PUT');
      expect(headers.get('authorization')).toBe(`Bearer ${bearer}`);
      expect(headers.get('content-type')).toBe(value.artifact.mediaType);
      expect(init?.body).toEqual(value.bytes);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            version: 1,
            disposition: 'Stored',
            runId,
            artifact: value.artifact,
            receivedAt: '2026-09-24T20:00:01.000Z',
          }),
          {
            status: 201,
            headers: { 'cache-control': 'no-store', 'content-type': 'application/json' },
          },
        ),
      );
    });
    const evidence = new ServerEvidenceHttp(origin(), bearer, fetch);

    await expect(evidence.storeArtifact(runId, value.artifact, value.bytes)).resolves.toMatchObject(
      {
        kind: 'Stored',
      },
    );
    expect(fetch).toHaveBeenCalledWith(
      `http://127.0.0.1:3000/api/runs/${runId}/artifacts/${value.artifact.d}`,
      expect.any(Object),
    );
  });

  it('appends the exact JSON batch and rejects an acknowledgement for another batch', async () => {
    const value = fixture();
    const fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ...value.acknowledgement, batchSaid: said('z') }), {
          status: 201,
          headers: { 'cache-control': 'no-store', 'content-type': 'application/json' },
        }),
      ),
    );
    const evidence = new ServerEvidenceHttp(origin(), bearer, fetch);

    await expect(
      evidence.appendBatch(runId, {
        version: 1,
        batch: value.batch,
        events: [value.event],
      }),
    ).resolves.toEqual({ kind: 'ResponseInvalid' });
  });

  it('retains the closed server conflict reason without exposing the Work Access bearer', async () => {
    const value = fixture();
    const problem = {
      type: 'https://devrandom.example/problems/evidence-conflict',
      title: 'Evidence delivery conflicts with the accepted stream',
      status: 409,
      code: 'EvidenceConflict',
      correlationId: 'ac68bb43-8a7b-4838-bcd6-98143fd372af',
      reason: 'SequenceGap',
      expectedStartingSequence: 2,
      receivedStartingSequence: 0,
    };
    const fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(problem), {
          status: 409,
          headers: { 'cache-control': 'no-store', 'content-type': 'application/json' },
        }),
      ),
    );
    const evidence = new ServerEvidenceHttp(origin(), bearer, fetch);

    const outcome = await evidence.appendBatch(runId, {
      version: 1,
      batch: value.batch,
      events: [value.event],
    });
    expect(outcome).toEqual({ kind: 'RequestRejected', problem });
    expect(JSON.stringify(outcome)).not.toContain(bearer);
  });
});
