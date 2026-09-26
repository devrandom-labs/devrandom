import { describe, expect, it } from 'vitest';

import type { PresentMandateBody } from '@devrandom/protocol';

import {
  decodeDevrandomServerOrigin,
  type DevrandomFetch,
  type DevrandomServerOrigin,
} from '../../infrastructure/devrandom-server-http.js';
import { ServerMandatePresentationHttp } from './server-mandate-http.js';

const bearer = 'q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s';
const credentialSaid = `E${'c'.repeat(43)}`;
const grantSaid = `E${'g'.repeat(43)}`;
const presentationExpiresAt = '2026-09-24T14:30:00.000Z';

function serverOrigin(): DevrandomServerOrigin {
  const decoded = decodeDevrandomServerOrigin('https://server.example');
  if (decoded.kind !== 'Accepted') {
    throw new Error('expected server origin fixture to decode');
  }
  return decoded.origin;
}

describe('Devrandom Server mandate-presentation HTTP adapter', () => {
  it('binds the exact credential resource and preserves pending then admitted outcomes', async () => {
    const responses = [
      new Response(
        JSON.stringify({
          version: 1,
          kind: 'Admitting',
          mandateKind: 'TaskMandate',
          credentialSaid,
          grantSaid,
          presentationExpiresAt,
          operationName: 'exchange.123',
        }),
        { status: 202, headers: { 'cache-control': 'no-store' } },
      ),
      new Response(
        JSON.stringify({
          version: 1,
          kind: 'Admitted',
          mandateKind: 'TaskMandate',
          credentialSaid,
          grantSaid,
          presentationExpiresAt,
          admittedAt: '2026-09-24T14:01:00.000Z',
        }),
        { status: 200, headers: { 'cache-control': 'no-store' } },
      ),
    ];
    const requests: {
      readonly url: string;
      readonly method: string | undefined;
      readonly authorization: string | null;
      readonly body: string | undefined;
    }[] = [];
    const fetch: DevrandomFetch = (input, init) => {
      requests.push({
        url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        method: init?.method,
        authorization: new Headers(init?.headers).get('authorization'),
        body: typeof init?.body === 'string' ? init.body : undefined,
      });
      const response = responses.shift();
      return response === undefined
        ? Promise.reject(new Error('unexpected mandate-presentation request'))
        : Promise.resolve(response);
    };
    const presentations = new ServerMandatePresentationHttp(serverOrigin(), bearer, fetch);
    const command: PresentMandateBody = {
      version: 1,
      mandateKind: 'TaskMandate',
      grantSaid,
    };

    await expect(presentations.present(credentialSaid, command)).resolves.toMatchObject({
      kind: 'Pending',
      presentation: { kind: 'Admitting', operationName: 'exchange.123' },
    });
    await expect(presentations.present(credentialSaid, command)).resolves.toMatchObject({
      kind: 'Admitted',
      presentation: { kind: 'Admitted', credentialSaid },
    });
    expect(requests).toEqual([
      {
        url: `https://server.example/api/mandate-presentations/${credentialSaid}`,
        method: 'PUT',
        authorization: `Bearer ${bearer}`,
        body: JSON.stringify(command),
      },
      {
        url: `https://server.example/api/mandate-presentations/${credentialSaid}`,
        method: 'PUT',
        authorization: `Bearer ${bearer}`,
        body: JSON.stringify(command),
      },
    ]);
  });

  it('rejects a projection whose body identity disagrees with the requested credential', async () => {
    const fetch: DevrandomFetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            version: 1,
            kind: 'Admitted',
            mandateKind: 'TaskMandate',
            credentialSaid: `E${'x'.repeat(43)}`,
            grantSaid,
            presentationExpiresAt,
            admittedAt: '2026-09-24T14:01:00.000Z',
          }),
          { status: 200, headers: { 'cache-control': 'no-store' } },
        ),
      );

    await expect(
      new ServerMandatePresentationHttp(serverOrigin(), bearer, fetch).present(credentialSaid, {
        version: 1,
        mandateKind: 'TaskMandate',
        grantSaid,
      }),
    ).resolves.toEqual({ kind: 'ResponseInvalid' });
  });

  it('preserves typed mandate rejection instead of interpreting it as admission', async () => {
    const fetch: DevrandomFetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            type: 'https://devrandom.example/problems/mandate-presentation-rejected',
            title: 'Mandate presentation was rejected',
            status: 422,
            code: 'MandatePresentationRejected',
            correlationId: '4df838a8-5109-49fd-bdad-805880a3ecee',
            reason: 'CredentialBindingInvalid',
          }),
          { status: 422, headers: { 'cache-control': 'no-store' } },
        ),
      );

    await expect(
      new ServerMandatePresentationHttp(serverOrigin(), bearer, fetch).present(credentialSaid, {
        version: 1,
        mandateKind: 'TaskMandate',
        grantSaid,
      }),
    ).resolves.toMatchObject({
      kind: 'RequestRejected',
      problem: { code: 'MandatePresentationRejected', reason: 'CredentialBindingInvalid' },
    });
  });
});
