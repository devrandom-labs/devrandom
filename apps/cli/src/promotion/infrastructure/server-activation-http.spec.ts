import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
import { PromotionCommandFile } from './promotion-command-file.js';

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
  it('reopens the exact staged CAS after a lost HTTP reply and requires the issuer key on retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devrandom-promotion-retry-'));
    const issuerKey = generateKeyPairSync('ed25519');
    const agentKey = generateKeyPairSync('ed25519');
    const receiptPayload = activationReceiptPayload(command);
    const signedBytes = Buffer.from(
      JSON.stringify({
        sourceAid: issuer,
        recipientAid: agent,
        payload: receiptPayload,
      }),
    );
    let signature = sign(null, signedBytes, issuerKey.privateKey);
    let commits = 0;
    const requests: string[] = [];
    // Disposable HTTP/CAS and Ed25519 fixture, not a KERIA or Mongo acceptance claim.
    const server = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        body += chunk;
      });
      request.on('end', () => {
        requests.push(body);
        if (
          request.method !== 'PUT' ||
          request.url !== `/api/tasks/${command.taskId}/activation` ||
          request.headers.authorization !== `Bearer ${'A'.repeat(43)}` ||
          body !== JSON.stringify(command)
        ) {
          response.writeHead(409).end();
          return;
        }
        if (commits === 0) {
          commits += 1;
          request.socket.destroy(); // durable commit happened, acknowledgement did not.
          return;
        }
        response.writeHead(200, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        });
        response.end(JSON.stringify({ ...receipt, kind: 'AlreadyCommitted' }));
      });
    });
    try {
      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (address === null || typeof address === 'string')
        throw new Error('HTTP fixture did not listen');
      const decoded = decodeDevrandomServerOrigin(`http://127.0.0.1:${String(address.port)}`);
      if (decoded.kind !== 'Accepted') throw new Error('HTTP fixture origin rejected');
      const inspect: IssuerActivationReceiptExchange['inspect'] = (expected) =>
        Promise.resolve(
          expected.exchangeSaid === receipt.decisionReceiptSaid &&
            signedBytes.equals(
              Buffer.from(
                JSON.stringify({
                  sourceAid: expected.sourceAid,
                  recipientAid: expected.recipientAid,
                  payload: expected.payload,
                }),
              ),
            ) &&
            verify(null, signedBytes, issuerKey.publicKey, signature)
            ? {
                kind: 'Verified',
                exchangeSaid: receipt.decisionReceiptSaid,
                payload: receiptPayload,
              }
            : { kind: 'Rejected', reason: 'Binding' },
        );
      const connect = () =>
        new ServerActivationHttp(decoded.origin, 'A'.repeat(43), fetch, { inspect }, issuer, agent);
      const directory = join(root, 'commands');
      expect(await new PromotionCommandFile(directory).stage(command)).toBe('Staged');
      expect(await connect().commit(command)).toEqual({ kind: 'Unavailable' });
      expect(commits).toBe(1);
      const reopened = await new PromotionCommandFile(directory).inspect(command.commandId);
      if (reopened.kind !== 'Staged') throw new Error('original CAS command lost');
      expect(reopened.command).toEqual(command);
      expect(await connect().commit(reopened.command)).toEqual({
        ...receipt,
        kind: 'AlreadyCommitted',
      });
      expect(requests).toEqual([JSON.stringify(command), JSON.stringify(command)]);

      signature = sign(null, signedBytes, agentKey.privateKey);
      expect(await connect().commit(reopened.command)).toEqual({ kind: 'Unavailable' });
      signature = sign(null, signedBytes, issuerKey.privateKey);
      expect(await connect().commit(reopened.command)).toEqual({
        ...receipt,
        kind: 'AlreadyCommitted',
      });
      expect(commits).toBe(1);
      expect(await new PromotionCommandFile(directory).inspect(command.commandId)).toEqual(
        reopened,
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      await rm(root, { recursive: true, force: true });
    }
  });

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
