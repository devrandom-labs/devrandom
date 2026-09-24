import { randomPasscode, ready, SignifyClient, Tier } from 'signify-ts';
import { describe, expect, it, vi } from 'vitest';

import { verifyNamedKeriIdentifier } from './keri-identifier.js';

async function disconnectedClient(): Promise<SignifyClient> {
  await ready();
  return new SignifyClient(
    'http://127.0.0.1:3901',
    randomPasscode(),
    Tier.low,
    'http://127.0.0.1:3903',
  );
}

describe('named KERI identifier verification', () => {
  it('reports that the named identifier is absent only for its exact KERIA 404', async () => {
    const client = await disconnectedClient();
    const fetch = vi
      .spyOn(client, 'fetch')
      .mockRejectedValue(
        new Error(
          'HTTP GET /identifiers/devrandom-issuer - 404 Not Found - identifier does not exist',
        ),
      );

    await expect(
      verifyNamedKeriIdentifier(client, 'devrandom-issuer', { kind: 'unwitnessed' }),
    ).rejects.toMatchObject({
      detail: {
        kind: 'identifier-conflict',
        alias: 'devrandom-issuer',
        reason: 'named identifier does not exist',
      },
    });
    expect(fetch).toHaveBeenCalledWith('/identifiers/devrandom-issuer', 'GET', null);
  });

  it('verifies the identifier returned by the exact named lookup', async () => {
    const client = await disconnectedClient();
    const fetch = vi.spyOn(client, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          name: 'devrandom-issuer',
          prefix: client.controller.pre,
          state: { i: client.controller.pre, bt: '0', b: [] },
          windexes: [],
        }),
      ),
    );

    await expect(
      verifyNamedKeriIdentifier(client, 'devrandom-issuer', { kind: 'unwitnessed' }),
    ).resolves.toEqual({
      alias: 'devrandom-issuer',
      aid: client.controller.pre,
    });
    expect(fetch).toHaveBeenCalledWith('/identifiers/devrandom-issuer', 'GET', null);
  });
});
