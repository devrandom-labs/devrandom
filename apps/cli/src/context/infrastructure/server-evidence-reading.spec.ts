import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';
import { prepareEvaluationSourceInventory, prepareEvidenceArtifact } from '@devrandom/protocol';

import { decodeDevrandomServerOrigin } from '../../infrastructure/devrandom-server-http.js';
import { ServerEvidenceReading } from './server-evidence-reading.js';

const said = (letter: string): string => `E${letter.repeat(43)}`;
const ownerAid = said('o');
const taskId = randomUUID();
const episodeSaid = said('e');
const evidenceSaid = said('r');
const preparedInventory = prepareEvaluationSourceInventory({
  taskId,
  taskRevisionSaid: said('t'),
  ownerAid,
  repositoryResourceSaid: said('s'),
  corpusSaid: said('c'),
  experienceMandateSaid: said('m'),
  sources: [
    {
      episodeSaid,
      rawEvidenceSaid: evidenceSaid,
      ownerAid,
      repositoryResourceSaid: said('s'),
      corpusSaid: said('c'),
      disclosure: 'AuthorizedAnalogy',
    },
  ],
});
if (preparedInventory.kind !== 'Prepared') throw new Error(preparedInventory.reason);
const inventory = preparedInventory.inventory;
const reading = {
  taskId,
  sourceInventorySaid: inventory.d,
  evidenceSaid,
  offset: 2,
  maximumBytes: 4,
};
function origin() {
  const decoded = decodeDevrandomServerOrigin('http://127.0.0.1:3211');
  if (decoded.kind !== 'Accepted') throw new Error('origin rejected');
  return decoded.origin;
}
function problem(code: string, status: number): Response {
  return new Response(
    JSON.stringify({
      code,
      correlationId: randomUUID(),
      status,
      title: code,
      type: `https://devrandom.example/problems/${code.toLowerCase()}`,
    }),
    { status, headers: { 'cache-control': 'no-store' } },
  );
}

it('denies a different Task or source inventory before sending an exact read', async () => {
  let requests = 0;
  const adapter = new ServerEvidenceReading(origin(), 'b'.repeat(43), inventory, () => {
    requests += 1;
    throw new Error('wrong scope reached HTTP');
  });
  expect(await adapter.read({ ...reading, taskId: randomUUID() })).toEqual({ kind: 'Denied' });
  expect(await adapter.read({ ...reading, sourceInventorySaid: said('x') })).toEqual({
    kind: 'Denied',
  });
  expect(await adapter.read({ ...reading, evidenceSaid: said('x') })).toEqual({
    kind: 'NotFound',
  });
  expect(requests).toBe(0);
});

it('returns a bounded raw slice only with the matching source and exact read-receipt SAID', async () => {
  const allBytes = new TextEncoder().encode('raw-content');
  const bytes = allBytes.subarray(reading.offset, reading.offset + reading.maximumBytes);
  const receiptBytes = new TextEncoder().encode(
    JSON.stringify({
      ownerAid,
      taskId,
      sourceInventorySaid: inventory.d,
      episodeSaid,
      evidenceSaid,
      offset: reading.offset,
      returnedBytes: bytes.byteLength,
      totalBytes: allBytes.byteLength,
    }),
  );
  const receipt = prepareEvidenceArtifact(receiptBytes, 'application/json');
  if (receipt.kind !== 'Prepared') throw new Error(receipt.reason);
  const adapter = new ServerEvidenceReading(origin(), 'b'.repeat(43), inventory, (url, init) => {
    expect(url).toBe('http://127.0.0.1:3211/api/evidence/read');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${'b'.repeat(43)}`);
    expect(init?.body).toBe(JSON.stringify({ version: 1, ...reading }));
    expect(typeof init?.body === 'string' ? init.body : '').not.toMatch(
      /atlas|mongodb|vector|ownerAid/u,
    );
    return Promise.resolve(
      new Response(
        JSON.stringify({
          version: 1,
          kind: 'Read',
          bytesBase64Url: Buffer.from(bytes).toString('base64url'),
          totalBytes: allBytes.byteLength,
          sourceSaid: episodeSaid,
          readReceiptSaid: receipt.artifact.d,
        }),
        { status: 200, headers: { 'cache-control': 'no-store' } },
      ),
    );
  });
  expect(await adapter.read(reading)).toEqual({
    kind: 'Read',
    bytes,
    totalBytes: allBytes.byteLength,
    sourceSaid: episodeSaid,
    readReceiptSaid: receipt.artifact.d,
  });
});

it('reports missing raw custody and rejects a forged read receipt', async () => {
  const missing = new ServerEvidenceReading(origin(), 'b'.repeat(43), inventory, () =>
    Promise.resolve(problem('EvidenceReadNotFound', 404)),
  );
  expect(await missing.read(reading)).toEqual({ kind: 'NotFound' });
  const forged = new ServerEvidenceReading(origin(), 'b'.repeat(43), inventory, () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          version: 1,
          kind: 'Read',
          bytesBase64Url: Buffer.from('wxyz').toString('base64url'),
          totalBytes: 11,
          sourceSaid: episodeSaid,
          readReceiptSaid: said('f'),
        }),
        { status: 200, headers: { 'cache-control': 'no-store' } },
      ),
    ),
  );
  expect(await forged.read(reading)).toEqual({ kind: 'Unavailable' });
});

it('rejects a changed episode identity and noncanonical raw bytes', async () => {
  const changedEpisode = new ServerEvidenceReading(origin(), 'b'.repeat(43), inventory, () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          version: 1,
          kind: 'Read',
          bytesBase64Url: Buffer.from('wxyz').toString('base64url'),
          totalBytes: 11,
          sourceSaid: said('x'),
          readReceiptSaid: said('q'),
        }),
        { status: 200, headers: { 'cache-control': 'no-store' } },
      ),
    ),
  );
  expect(await changedEpisode.read(reading)).toEqual({ kind: 'Unavailable' });
  const padded = new ServerEvidenceReading(origin(), 'b'.repeat(43), inventory, () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          version: 1,
          kind: 'Read',
          bytesBase64Url: 'd3h5eg==',
          totalBytes: 11,
          sourceSaid: episodeSaid,
          readReceiptSaid: said('q'),
        }),
        { status: 200, headers: { 'cache-control': 'no-store' } },
      ),
    ),
  );
  expect(await padded.read(reading)).toEqual({ kind: 'Unavailable' });
});
