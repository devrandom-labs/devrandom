import { describe, expect, it, vi } from 'vitest';

import { decodeDevrandomServerOrigin } from '../../infrastructure/devrandom-server-http.js';
import { ServerActivationPointer } from './server-activation-pointer.js';

const taskId = '4df838a8-5109-49fd-bdad-805880a3ecee';
const said = (letter: string) => `E${letter.repeat(43)}`;
const pointer = {
  version: 1 as const,
  kind: 'Initial' as const,
  taskId,
  taskRevisionSaid: said('t'),
  harnessLineageId: '5ebf49b9-df26-4a49-9194-da868f97cf9d',
  activeRevisionSaid: said('h'),
  pointerVersion: 1 as const,
};
const origin = decodeDevrandomServerOrigin('http://127.0.0.1:3211');
if (origin.kind !== 'Accepted') throw new Error('origin');

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

describe('owner-scoped current activation pointer', () => {
  it('reads the initial H1 pointer with the activation Work Access bearer', async () => {
    const fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      expect(input).toBe(`http://127.0.0.1:3211/api/tasks/${taskId}/activation`);
      expect(init).toMatchObject({
        method: 'GET',
        headers: { authorization: `Bearer ${'A'.repeat(43)}` },
      });
      return Promise.resolve(reply(200, pointer));
    });
    const reader = new ServerActivationPointer(origin.origin, 'A'.repeat(43), fetch);
    expect(await reader.inspect(taskId)).toEqual({ kind: 'Observed', pointer });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('never treats a substituted, pending or unavailable pointer as current truth', async () => {
    const substituted = new ServerActivationPointer(origin.origin, 'A'.repeat(43), () =>
      Promise.resolve(reply(200, { ...pointer, taskId: '11111111-1111-4111-8111-111111111111' })),
    );
    expect(await substituted.inspect(taskId)).toEqual({ kind: 'Unavailable' });
    const pending = new ServerActivationPointer(origin.origin, 'A'.repeat(43), () =>
      Promise.resolve(reply(409, { kind: 'Conflict' })),
    );
    expect(await pending.inspect(taskId)).toEqual({ kind: 'Missing' });
    const unavailable = new ServerActivationPointer(origin.origin, 'A'.repeat(43), () =>
      Promise.reject(new Error('offline')),
    );
    expect(await unavailable.inspect(taskId)).toEqual({ kind: 'Unavailable' });
  });
});
