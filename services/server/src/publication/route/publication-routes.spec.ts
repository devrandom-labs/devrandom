import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { prepareHarnessPackage, type PublishedHarness } from '@devrandom/protocol';
import { publicationRoutes } from './publication-routes.js';
describe('public publication HTTP boundary', () => {
  it('listens on localhost and returns only the exact public package without task or activation authority', async () => {
    const prepared = prepareHarnessPackage({
      publisherAid: `E${'a'.repeat(43)}`,
      sourceRevisionSaid: `E${'b'.repeat(43)}`,
      behavior: { kind: 'Instruction', text: 'Run public verification before completion.' },
    });
    if (prepared.kind !== 'Prepared') throw new Error('package');
    const published: PublishedHarness = {
      package: prepared.package,
      signature: { exchange: {}, signatures: ['A'.repeat(88)], keyStateSaid: `E${'c'.repeat(43)}` },
    };
    const authorize = vi.fn().mockResolvedValue({ kind: 'Denied' });
    const publish = vi.fn().mockResolvedValue({ kind: 'Rejected' });
    const server = Fastify();
    server.register(
      publicationRoutes({
        access: { authorize },
        publication: {
          publish,
          read: (packageSaid) =>
            Promise.resolve(
              packageSaid === prepared.package.d ? { kind: 'Read', published } : { kind: 'Absent' },
            ),
        },
        now: () => new Date().toISOString(),
      }),
    );
    try {
      const origin = await server.listen({ host: '127.0.0.1', port: 0 });
      const response = await fetch(`${origin}/api/harness-packages/${prepared.package.d}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(published);
      expect(authorize).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      expect((await fetch(`${origin}/api/harness-packages/E${'d'.repeat(43)}`)).status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
