import { createServer, type Server } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import {
  IssuerRegistrationHttp,
  IssuerRegistrationHttpFailure,
} from './issuer-registration-http.js';

const servers: Server[] = [];
const registrationId = 'a'.repeat(32);
const cliCapability = `cli_${'c'.repeat(43)}`;
const browserCapability = `browser_${'b'.repeat(43)}`;
const creationKey = `registration_${'r'.repeat(43)}`;

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error === undefined) {
              resolve();
            } else {
              reject(error);
            }
          });
        }),
    ),
  );
});

async function issuer(responseHeaders: Readonly<{ readonly cacheControl?: string }> = {}) {
  const server = createServer((_request, response) => {
    response.statusCode = 201;
    response.setHeader('content-type', 'application/json');
    if (responseHeaders.cacheControl !== undefined) {
      response.setHeader('cache-control', responseHeaders.cacheControl);
    }
    response.end(
      JSON.stringify({
        registrationId,
        cliCapability,
        browserUrl: `http://site.test/#/registration/${registrationId}?capability=${browserCapability}`,
        challengeWords: ['amber', 'cabin', 'delta'],
        issuerAid: 'EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk',
        issuerOobi:
          'http://keria.test/oobi/EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk/agent/EJlw5Fw9LKH1CYFEkGiDUlx0cHozvXb7hfqhSoMsH6bs',
        expiresAt: '2026-09-24T12:05:00.000Z',
        pollIntervalMs: 1_000,
      }),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('test issuer did not bind an IP port');
  }
  return `http://127.0.0.1:${String(address.port)}`;
}

describe('issuer registration HTTP conversation', () => {
  it('accepts an exact no-store Registration Session response over a real socket', async () => {
    const client = new IssuerRegistrationHttp(await issuer({ cacheControl: 'no-store' }));

    await expect(
      client.create(
        {
          protocolVersion: 1,
          userAid: 'EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz',
          userAgentOobi:
            'http://keria.test/oobi/EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz/agent/EJlw5Fw9LKH1CYFEkGiDUlx0cHozvXb7hfqhSoMsH6bs',
        },
        creationKey,
      ),
    ).resolves.toMatchObject({ registrationId, cliCapability });
  });

  it('rejects a response that could be retained by an intermediary', async () => {
    const client = new IssuerRegistrationHttp(await issuer());

    await expect(
      client.create(
        {
          protocolVersion: 1,
          userAid: 'EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz',
          userAgentOobi:
            'http://keria.test/oobi/EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz/agent/EJlw5Fw9LKH1CYFEkGiDUlx0cHozvXb7hfqhSoMsH6bs',
        },
        creationKey,
      ),
    ).rejects.toBeInstanceOf(IssuerRegistrationHttpFailure);
  });
});
