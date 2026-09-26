import { createServer } from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import {
  runAdmissionExchangeSaid,
  runCommandId,
  runIncarnationId,
  runProjectionFixture,
} from '../../../test/run-fixture.js';
import {
  decodeDevrandomServerOrigin,
  type DevrandomFetch,
  type DevrandomServerOrigin,
} from '../../infrastructure/devrandom-server-http.js';
import { ServerRunHttp } from './server-run-http.js';

const bearer = 'q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s';

function serverOrigin(): DevrandomServerOrigin {
  const decoded = decodeDevrandomServerOrigin('https://server.example');
  if (decoded.kind !== 'Accepted') {
    throw new Error('expected server origin fixture');
  }
  return decoded.origin;
}

describe('Devrandom Server Run HTTP adapter', () => {
  it('rejects an unbound continuation command before transmitting authority', async () => {
    const fetch = vi.fn();
    const adapter = new ServerRunHttp(serverOrigin(), bearer, fetch);
    expect(
      await adapter.admitContinuation(runProjectionFixture().runId, {
        version: 1,
        expectedRunVersion: 1,
        predecessorCheckpointSaid: 'invalid',
        predecessorSealSaid: 'invalid',
        predecessorHeadSaid: 'invalid',
        successorIncarnationId: runIncarnationId,
        successorStreamId: runIncarnationId,
        expectedActivePointerVersion: 2,
        expectedActivationReceiptSaid: 'invalid',
      }),
    ).toEqual({ kind: 'InputInvalid' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(
    (['Inspect', 'Admit', 'AcquireLease', 'RenewLease'] as const).flatMap((operation) =>
      (['Headers', 'Body'] as const).map((stage) => ({ operation, stage })),
    ),
  )(
    'bounds $operation waiting for $stage at the real HTTP boundary',
    async ({ operation, stage }) => {
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
          throw new Error('Expected HTTP address');
        const decoded = decodeDevrandomServerOrigin(`http://127.0.0.1:${String(address.port)}`);
        if (decoded.kind !== 'Accepted') throw new Error('Expected loopback origin');
        const runs = new ServerRunHttp(decoded.origin, bearer, async (input, init) => {
          const response = await fetch(input, init);
          received.resolve(undefined);
          return response;
        });
        const run = runProjectionFixture();
        const outcome =
          operation === 'Inspect'
            ? runs.inspect(run.runId)
            : operation === 'Admit'
              ? runs.admit({
                  version: 1,
                  commandId: runCommandId,
                  admissionExchangeSaid: runAdmissionExchangeSaid,
                })
              : operation === 'AcquireLease'
                ? runs.acquireLease(run.runId, runIncarnationId, {
                    version: 1,
                    expectedRunVersion: 0,
                  })
                : runs.renewLease(run.runId, runIncarnationId, {
                    version: 1,
                    expectedRunVersion: 1,
                  });
        const settled = vi.fn();
        pending = outcome.then((value) => {
          settled(value);
        });
        await requested.promise;
        if (stage === 'Body') await received.promise;
        await vi.advanceTimersByTimeAsync(9999);
        expect(settled).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await new Promise((resolve) => setImmediate(resolve));
        expect(settled).toHaveBeenCalledExactlyOnceWith({ kind: 'ServerUnavailable' });
      } finally {
        server.closeAllConnections();
        await pending;
        await new Promise<void>((resolve, reject) =>
          server.close((error) => {
            if (error === undefined) resolve();
            else reject(error);
          }),
        );
        vi.useRealTimers();
      }
    },
  );

  it('inspects one authoritative owner-scoped Run through its exact public resource', async () => {
    const run = runProjectionFixture();
    let requested:
      | {
          readonly url: string;
          readonly method: string | undefined;
          readonly authorization: string | null;
        }
      | undefined;
    const fetch: DevrandomFetch = (input, init) => {
      requested = {
        url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        method: init?.method,
        authorization: new Headers(init?.headers).get('authorization'),
      };
      return Promise.resolve(
        new Response(JSON.stringify(run), {
          status: 200,
          headers: { 'cache-control': 'no-store' },
        }),
      );
    };

    await expect(
      new ServerRunHttp(serverOrigin(), bearer, fetch).inspect(run.runId),
    ).resolves.toEqual({ kind: 'Found', run });
    expect(requested).toEqual({
      url: `https://server.example/api/runs/${run.runId}`,
      method: 'GET',
      authorization: `Bearer ${bearer}`,
    });
  });

  it('preserves the persisted exchange-pending disposition', async () => {
    const projection = {
      version: 1 as const,
      disposition: 'RunAdmissionExchangePending' as const,
      commandId: runCommandId,
      admissionExchangeSaid: runAdmissionExchangeSaid,
    };
    const fetch: DevrandomFetch = () =>
      Promise.resolve(
        new Response(JSON.stringify(projection), {
          status: 202,
          headers: { 'cache-control': 'no-store' },
        }),
      );

    await expect(
      new ServerRunHttp(serverOrigin(), bearer, fetch).admit({
        version: 1,
        commandId: runCommandId,
        admissionExchangeSaid: runAdmissionExchangeSaid,
      }),
    ).resolves.toEqual({ kind: 'Pending', projection });
  });

  it('acquires the path-bound incarnation and validates the server-time deadline', async () => {
    const run = runProjectionFixture();
    const projection = {
      version: 1 as const,
      disposition: 'Acquired' as const,
      runId: run.runId,
      incarnationId: runIncarnationId,
      runVersion: 1,
      serverTime: '2026-09-24T20:00:00.000Z',
      expiresAt: '2026-09-24T20:00:45.000Z',
    };
    let requested:
      | {
          readonly url: string;
          readonly method: string | undefined;
          readonly authorization: string | null;
        }
      | undefined;
    const fetch: DevrandomFetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      requested = {
        url,
        method: init?.method,
        authorization: new Headers(init?.headers).get('authorization'),
      };
      return Promise.resolve(
        new Response(JSON.stringify(projection), {
          status: 201,
          headers: { 'cache-control': 'no-store' },
        }),
      );
    };

    await expect(
      new ServerRunHttp(serverOrigin(), bearer, fetch).acquireLease(run.runId, runIncarnationId, {
        version: 1,
        expectedRunVersion: 0,
      }),
    ).resolves.toEqual({ kind: 'Acquired', projection });
    expect(requested).toEqual({
      url: `https://server.example/api/runs/${run.runId}/incarnations/${runIncarnationId}`,
      method: 'PUT',
      authorization: `Bearer ${bearer}`,
    });
  });

  it.each(['Acquire', 'Renew'] as const)(
    'rejects an impossible calendar instant in the public %s lease response',
    async (operation) => {
      const run = runProjectionFixture();
      const serverTime = '2027-02-30T20:00:00.000Z';
      const expiresAt = '2027-03-02T20:00:45.000Z';
      const fetch: DevrandomFetch = () =>
        Promise.resolve(
          operation === 'Acquire'
            ? new Response(
                JSON.stringify({
                  version: 1,
                  disposition: 'Acquired',
                  runId: run.runId,
                  incarnationId: runIncarnationId,
                  runVersion: 1,
                  serverTime,
                  expiresAt,
                }),
                { status: 201, headers: { 'cache-control': 'no-store' } },
              )
            : new Response(null, {
                status: 204,
                headers: {
                  'cache-control': 'no-store',
                  'x-devrandom-server-time': serverTime,
                  'x-devrandom-lease-expires-at': expiresAt,
                  'x-devrandom-run-version': '2',
                },
              }),
        );
      const hosted = new ServerRunHttp(serverOrigin(), bearer, fetch);
      const result =
        operation === 'Acquire'
          ? hosted.acquireLease(run.runId, runIncarnationId, {
              version: 1,
              expectedRunVersion: 0,
            })
          : hosted.renewLease(run.runId, runIncarnationId, {
              version: 1,
              expectedRunVersion: 1,
            });
      await expect(result).resolves.toEqual({ kind: 'ResponseInvalid' });
    },
  );

  it('reconciles the same first lease over HTTP after the server commits and loses its reply', async () => {
    const run = runProjectionFixture();
    const projection = {
      version: 1 as const,
      disposition: 'Acquired' as const,
      runId: run.runId,
      incarnationId: runIncarnationId,
      runVersion: 1,
      serverTime: '2026-09-24T20:00:00.000Z',
      expiresAt: '2026-09-24T20:00:45.000Z',
    };
    const requests: {
      readonly method: string | undefined;
      readonly path: string | undefined;
      readonly body: string;
    }[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      request.on('end', () => {
        requests.push({
          method: request.method,
          path: request.url,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        if (requests.length === 1) {
          request.socket.destroy();
          return;
        }
        response.writeHead(200, {
          'cache-control': 'no-store',
          'content-type': 'application/json',
        });
        response.end(JSON.stringify(projection));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('Expected HTTP address');
      const decoded = decodeDevrandomServerOrigin(`http://127.0.0.1:${String(address.port)}`);
      if (decoded.kind !== 'Accepted') throw new Error('Expected loopback origin');
      const hosted = new ServerRunHttp(decoded.origin, bearer, fetch);
      const command = { version: 1 as const, expectedRunVersion: 0 };
      await expect(hosted.acquireLease(run.runId, runIncarnationId, command)).resolves.toEqual({
        kind: 'ServerUnavailable',
      });
      await expect(hosted.acquireLease(run.runId, runIncarnationId, command)).resolves.toEqual({
        kind: 'Reconciled',
        projection,
      });
      expect(requests).toEqual([
        {
          method: 'PUT',
          path: `/api/runs/${run.runId}/incarnations/${runIncarnationId}`,
          body: JSON.stringify(command),
        },
        {
          method: 'PUT',
          path: `/api/runs/${run.runId}/incarnations/${runIncarnationId}`,
          body: JSON.stringify(command),
        },
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        }),
      );
    }
  });

  it('decodes a no-body renewal receipt from the exact typed headers', async () => {
    const run = runProjectionFixture();
    const fetch: DevrandomFetch = () =>
      Promise.resolve(
        new Response(null, {
          status: 204,
          headers: {
            'cache-control': 'no-store',
            'x-devrandom-server-time': '2026-09-24T20:00:15.000Z',
            'x-devrandom-lease-expires-at': '2026-09-24T20:01:00.000Z',
            'x-devrandom-run-version': '2',
          },
        }),
      );

    await expect(
      new ServerRunHttp(serverOrigin(), bearer, fetch).renewLease(run.runId, runIncarnationId, {
        version: 1,
        expectedRunVersion: 1,
      }),
    ).resolves.toEqual({
      kind: 'Renewed',
      receipt: {
        version: 1,
        runId: run.runId,
        incarnationId: runIncarnationId,
        runVersion: 2,
        serverTime: '2026-09-24T20:00:15.000Z',
        expiresAt: '2026-09-24T20:01:00.000Z',
      },
    });
  });
});
