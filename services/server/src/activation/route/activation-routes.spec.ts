import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import {
  prepareActivationCommitCommand,
  preparePromotionSelectionRecord,
} from '@devrandom/protocol';

import { activationRoutes } from './activation-routes.js';

const said = (letter: string): string => `E${letter.repeat(43)}`;

function command() {
  const selection = preparePromotionSelectionRecord({
    taskId: '22222222-2222-4222-8222-222222222222',
    taskRevisionSaid: said('t'),
    harnessLineageId: '33333333-3333-4333-8333-333333333333',
    expectedIncumbentRevisionSaid: said('h'),
    expectedPointerVersion: 1,
    evaluationManifestSaid: said('m'),
    evaluationClosureSaid: said('e'),
    hypothesisSaid: said('i'),
    selection: { kind: 'RetainIncumbent' },
  });
  if (selection.kind !== 'Prepared') throw new Error(selection.reason);
  const prepared = prepareActivationCommitCommand({
    version: 1,
    commandId: '11111111-1111-4111-8111-111111111111',
    taskId: selection.record.taskId,
    taskRevisionSaid: selection.record.taskRevisionSaid,
    harnessLineageId: selection.record.harnessLineageId,
    expectedIncumbentRevisionSaid: selection.record.expectedIncumbentRevisionSaid,
    expectedPointerVersion: 1,
    evaluationManifestSaid: selection.record.evaluationManifestSaid,
    evaluationClosureSaid: selection.record.evaluationClosureSaid,
    exactPromotionMandateSaid: said('a'),
    agentProposalExchangeSaid: said('p'),
    governorDecisionExchangeSaid: said('g'),
    selectionRecord: selection.record,
    disposition: { kind: 'RetainIncumbent', selectionEvidenceSaid: selection.record.d },
  });
  if (prepared.kind !== 'Prepared') throw new Error(prepared.reason);
  return prepared.command;
}

describe('activation public HTTP boundary', () => {
  it("reads only the owner's committed active pointer for recovery", async () => {
    const taskId = command().taskId;
    const pointer = {
      version: 1 as const,
      kind: 'Committed' as const,
      taskId,
      taskRevisionSaid: said('t'),
      harnessLineageId: '33333333-3333-4333-8333-333333333333',
      activeRevisionSaid: said('h'),
      pointerVersion: 2,
      commandId: '11111111-1111-4111-8111-111111111111',
      decisionReceiptSaid: said('r'),
      disposition: 'Retained' as const,
    };
    const readCurrent = vi.fn(() => Promise.resolve({ kind: 'Read' as const, pointer }));
    const server = Fastify();
    server.register(
      activationRoutes(
        Object.assign(
          {
            access: {
              authorize: ({ bearerSecret }: { readonly bearerSecret: string }) =>
                Promise.resolve(
                  bearerSecret === 'a'.repeat(43)
                    ? { kind: 'Authorized' as const, ownerAid: said('o') }
                    : { kind: 'Denied' as const },
                ),
            },
            activation: { commit: () => Promise.resolve({ kind: 'Unavailable' as const }) },
            now: () => '2026-09-26T10:00:00.000Z',
            newCorrelationId: () => 'correlation',
          },
          { reading: { readCurrent } },
        ),
      ),
    );
    try {
      const url = `/api/tasks/${taskId}/activation`;
      const address = await server.listen({ host: '127.0.0.1', port: 0 });
      const accepted = await fetch(`${address}${url}`, {
        headers: { authorization: `Bearer ${'a'.repeat(43)}` },
      });
      expect(accepted.status).toBe(200);
      expect(accepted.headers.get('cache-control')).toBe('no-store');
      expect(await accepted.json()).toEqual(pointer);
      expect(readCurrent).toHaveBeenCalledWith({ ownerAid: said('o'), taskId });
      const denied = await fetch(`${address}${url}`, {
        headers: { authorization: `Bearer ${'b'.repeat(43)}` },
      });
      expect(denied.status).toBe(403);
      expect(readCurrent).toHaveBeenCalledOnce();
    } finally {
      await server.close();
    }
  });

  it('requires dedicated scope and exact Task binding before calling commit', async () => {
    const input = command();
    const commit = vi.fn(() => Promise.resolve({ kind: 'Conflict' as const }));
    const authorize = vi.fn(() =>
      Promise.resolve({ kind: 'Authorized' as const, ownerAid: said('o') }),
    );
    const server = Fastify();
    server.register(
      activationRoutes({
        access: { authorize },
        activation: { commit },
        reading: { readCurrent: () => Promise.resolve({ kind: 'Unavailable' }) },
        now: () => '2026-09-26T10:00:00.000Z',
        newCorrelationId: () => 'correlation',
      }),
    );
    try {
      const mismatched = await server.inject({
        method: 'PUT',
        url: '/api/tasks/44444444-4444-4444-8444-444444444444/activation',
        headers: { authorization: `Bearer ${'a'.repeat(43)}` },
        payload: input,
      });
      expect(mismatched.statusCode).toBe(400);
      expect(commit).not.toHaveBeenCalled();
      expect(authorize).toHaveBeenCalledWith({
        bearerSecret: 'a'.repeat(43),
        scope: 'activation:commit',
        observedAt: '2026-09-26T10:00:00.000Z',
      });
      const accepted = await server.inject({
        method: 'PUT',
        url: `/api/tasks/${input.taskId}/activation`,
        headers: { authorization: `Bearer ${'a'.repeat(43)}` },
        payload: input,
      });
      expect(accepted.statusCode).toBe(409);
      expect(commit).toHaveBeenCalledWith({ ownerAid: said('o'), command: input });
    } finally {
      await server.close();
    }
  });
});
