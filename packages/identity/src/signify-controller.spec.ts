import { createServer } from 'node:http';

import { ready } from 'signify-ts';
import { describe, expect, it } from 'vitest';

import { IdentityFailure } from './identity-error.js';
import { connectSignifyController } from './signify-controller.js';

describe('Signify controller HTTP boundary', () => {
  it.each(['Headers', 'Body'] as const)(
    'terminates a native SDK connection stalled at %s',
    async (stage) => {
      await ready();
      let requests = 0;
      const server = createServer((request, response) => {
        request.resume();
        requests += 1;
        if (stage === 'Body') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.write('{');
        }
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      let pending: Promise<{ readonly kind: string }> | undefined;
      let watchdog: NodeJS.Timeout | undefined;
      try {
        const address = server.address();
        if (address === null || typeof address === 'string')
          throw new Error('Missing HTTP address');
        const origin = `http://127.0.0.1:${String(address.port)}`;
        const started = performance.now();
        pending = connectSignifyController({
          adminUrl: origin,
          bootUrl: origin,
          bran: '0123456789abcdefghijk',
          securityTier: 'low',
        }).then(
          () => ({ kind: 'UnexpectedConnection' }),
          (cause: unknown) => ({
            kind: cause instanceof IdentityFailure ? cause.detail.kind : 'UnexpectedFailure',
          }),
        );
        const bounded = new Promise<{ readonly kind: string }>((resolve) => {
          watchdog = setTimeout(() => {
            resolve({ kind: 'UnboundedSdkRequest' });
          }, 12_000);
        });
        expect(await Promise.race([pending, bounded])).toEqual({ kind: 'keria-unavailable' });
        expect(requests).toBe(1);
        expect(performance.now() - started).toBeGreaterThanOrEqual(9_000);
      } finally {
        clearTimeout(watchdog);
        server.closeAllConnections();
        await pending;
        await new Promise<void>((resolve, reject) =>
          server.close((error) => {
            if (error === undefined) resolve();
            else reject(error);
          }),
        );
      }
    },
    15_000,
  );
});
