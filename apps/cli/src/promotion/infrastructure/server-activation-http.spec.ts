import {
  issuerAid,
  personalAgentAid,
  type IssuerActivationReceiptExchange,
} from '@devrandom/identity';
import {
  activationReceiptPayload,
  prepareActivationCommitCommand,
  preparePromotionSelectionRecord,
} from '@devrandom/protocol';
import { describe, expect, it, vi } from 'vitest';

import { decodeDevrandomServerOrigin } from '../../infrastructure/devrandom-server-http.js';
import { ServerActivationHttp } from './server-activation-http.js';

const said = (letter: string) => `E${letter.repeat(43)}`;
const issuer = issuerAid('EHcQUn2xY9KN1yv6FP0c6-pxej14Z8JDD3IYLddg0wOh');
const agent = personalAgentAid('EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz');
const selected = preparePromotionSelectionRecord({
  taskId: '4df838a8-5109-49fd-bdad-805880a3ecee',
  taskRevisionSaid: said('t'),
  harnessLineageId: '5ebf49b9-df26-4a49-9194-da868f97cf9d',
  expectedIncumbentRevisionSaid: said('h'),
  expectedPointerVersion: 1,
  evaluationManifestSaid: said('m'),
  evaluationClosureSaid: said('e'),
  hypothesisSaid: said('i'),
  selection: { kind: 'RetainIncumbent' },
});
if (selected.kind !== 'Prepared') throw new Error('selection fixture rejected');
const prepared = prepareActivationCommitCommand({
  version: 1,
  commandId: '6eb93221-1ad0-4555-9aa3-b2ff2ed541a6',
  taskId: selected.record.taskId,
  taskRevisionSaid: selected.record.taskRevisionSaid,
  harnessLineageId: selected.record.harnessLineageId,
  expectedIncumbentRevisionSaid: selected.record.expectedIncumbentRevisionSaid,
  expectedPointerVersion: 1,
  evaluationManifestSaid: selected.record.evaluationManifestSaid,
  evaluationClosureSaid: selected.record.evaluationClosureSaid,
  exactPromotionMandateSaid: said('a'),
  agentProposalExchangeSaid: said('p'),
  governorDecisionExchangeSaid: said('g'),
  selectionRecord: selected.record,
  disposition: { kind: 'RetainIncumbent', selectionEvidenceSaid: selected.record.d },
});
if (prepared.kind !== 'Prepared') throw new Error('command fixture rejected');
const command = prepared.command;
const receipt = {
  kind: 'Committed' as const,
  decisionReceiptSaid: said('R'),
  activeRevisionSaid: command.expectedIncumbentRevisionSaid,
  pointerVersion: 2,
  disposition: 'Retained' as const,
};
const origin = decodeDevrandomServerOrigin('http://127.0.0.1:3211');
if (origin.kind !== 'Accepted') throw new Error('server origin fixture rejected');

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

describe('hosted activation HTTP and issuer receipt', () => {
  it('requires native issuer receipt and idempotent durable readback after first commit', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response(201, receipt))
      .mockResolvedValueOnce(response(200, { ...receipt, kind: 'AlreadyCommitted' }));
    const inspect = vi.fn<IssuerActivationReceiptExchange['inspect']>(() =>
      Promise.resolve({
        kind: 'Verified',
        exchangeSaid: receipt.decisionReceiptSaid,
        payload: activationReceiptPayload(command),
      }),
    );
    const http = new ServerActivationHttp(
      origin.origin,
      'A'.repeat(43),
      fetch,
      { inspect },
      issuer,
      agent,
    );
    expect(await http.commit(command)).toEqual(receipt);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(inspect).toHaveBeenCalledWith({
      exchangeSaid: receipt.decisionReceiptSaid,
      sourceAid: issuer,
      recipientAid: agent,
      payload: activationReceiptPayload(command),
    });
    expect(fetch.mock.calls[0]?.[0]).toBe(
      `http://127.0.0.1:3211/api/tasks/${command.taskId}/activation`,
    );
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'PUT',
      headers: { authorization: `Bearer ${'A'.repeat(43)}` },
    });
  });

  it('never treats an unsigned, mismatched or unconfirmed response as a committed pointer', async () => {
    const inspect = vi.fn<IssuerActivationReceiptExchange['inspect']>(() =>
      Promise.resolve({ kind: 'Pending' }),
    );
    const unsignedFetch = vi.fn().mockResolvedValue(response(201, receipt));
    const unsigned = new ServerActivationHttp(
      origin.origin,
      'A'.repeat(43),
      unsignedFetch,
      { inspect },
      issuer,
      agent,
    );
    expect(await unsigned.commit(command)).toEqual({ kind: 'Unavailable' });
    expect(unsignedFetch).toHaveBeenCalledTimes(1);
    const mismatchFetch = vi
      .fn()
      .mockResolvedValue(response(201, { ...receipt, pointerVersion: 3 }));
    const mismatch = new ServerActivationHttp(
      origin.origin,
      'A'.repeat(43),
      mismatchFetch,
      { inspect },
      issuer,
      agent,
    );
    expect(await mismatch.commit(command)).toEqual({ kind: 'Unavailable' });
    expect(inspect).toHaveBeenCalledTimes(1);
    const committedFetch = vi
      .fn()
      .mockResolvedValueOnce(response(201, receipt))
      .mockResolvedValueOnce(
        response(200, { ...receipt, kind: 'AlreadyCommitted', activeRevisionSaid: said('q') }),
      );
    inspect.mockResolvedValueOnce({
      kind: 'Verified',
      exchangeSaid: receipt.decisionReceiptSaid,
      payload: activationReceiptPayload(command),
    });
    const drifted = new ServerActivationHttp(
      origin.origin,
      'A'.repeat(43),
      committedFetch,
      { inspect },
      issuer,
      agent,
    );
    expect(await drifted.commit(command)).toEqual({ kind: 'Unavailable' });
  });
});
