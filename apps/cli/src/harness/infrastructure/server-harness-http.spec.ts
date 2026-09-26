import { describe, expect, it } from 'vitest';

import { baselineHarnessCommandFixture } from '../../../test/baseline-harness-fixture.js';
import {
  decodeDevrandomServerOrigin,
  type DevrandomFetch,
  type DevrandomServerOrigin,
} from '../../infrastructure/devrandom-server-http.js';
import { ServerHarnessHttp } from './server-harness-http.js';

const bearer = 'q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s';

function serverOrigin(): DevrandomServerOrigin {
  const decoded = decodeDevrandomServerOrigin('https://server.example');
  if (decoded.kind !== 'Accepted') {
    throw new Error('expected server origin fixture to decode');
  }
  return decoded.origin;
}

describe('Devrandom Server Harness HTTP adapter', () => {
  it('admits one exact H1 through its SAID path and Work Access bearer', async () => {
    const command = baselineHarnessCommandFixture();
    const projection = {
      version: 1 as const,
      ownerAid: 'EMstL6Th90iB6MpQkPjKN2ii7a5XcvA_PCHWHrAAD-l4',
      commandId: command.commandId,
      acceptedAt: '2026-09-24T19:00:00.000Z',
      revision: command.revision,
    };
    let request: { readonly url: string; readonly authorization: string | null } | undefined;
    const fetch: DevrandomFetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      request = { url, authorization: new Headers(init?.headers).get('authorization') };
      return Promise.resolve(
        new Response(JSON.stringify(projection), {
          status: 201,
          headers: { 'cache-control': 'no-store' },
        }),
      );
    };

    await expect(
      new ServerHarnessHttp(serverOrigin(), bearer, fetch).admit(command),
    ).resolves.toEqual({ kind: 'Created', projection });
    expect(request).toEqual({
      url: `https://server.example/api/harness-revisions/${command.revision.d}`,
      authorization: `Bearer ${bearer}`,
    });
  });

  it('preserves a typed lineage conflict', async () => {
    const command = baselineHarnessCommandFixture();
    const fetch: DevrandomFetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            type: 'https://devrandom.example/problems/harness-admission-conflict',
            title: 'Harness admission conflicts with durable state',
            status: 409,
            code: 'HarnessAdmissionConflict',
            correlationId: '44444444-4444-4444-8444-444444444444',
            reason: 'LineageConflict',
          }),
          { status: 409, headers: { 'cache-control': 'no-store' } },
        ),
      );

    await expect(
      new ServerHarnessHttp(serverOrigin(), bearer, fetch).admit(command),
    ).resolves.toMatchObject({ kind: 'RequestRejected', problem: { reason: 'LineageConflict' } });
  });
});
