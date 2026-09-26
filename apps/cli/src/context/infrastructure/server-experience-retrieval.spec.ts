import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';
import { prepareEvaluationSourceInventory, prepareEvidenceArtifact } from '@devrandom/protocol';

import { decodeDevrandomServerOrigin } from '../../infrastructure/devrandom-server-http.js';
import { ServerExperienceRetrieval } from './server-experience-retrieval.js';

const said = (letter: string): string => `E${letter.repeat(43)}`;
const taskId = randomUUID();
const taskRevisionSaid = said('t');
const ownerAid = said('o');
const corpusSaid = said('c');
const source = { episodeSaid: said('e'), rawEvidenceSaid: said('r'), score: 0.92 };
const preparedInventory = prepareEvaluationSourceInventory({
  taskId,
  taskRevisionSaid,
  ownerAid,
  repositoryResourceSaid: said('s'),
  corpusSaid,
  experienceMandateSaid: said('m'),
  sources: [
    {
      episodeSaid: source.episodeSaid,
      rawEvidenceSaid: source.rawEvidenceSaid,
      ownerAid,
      repositoryResourceSaid: said('s'),
      corpusSaid,
      disclosure: 'AuthorizedAnalogy',
    },
  ],
});
if (preparedInventory.kind !== 'Prepared') throw new Error(preparedInventory.reason);
const inventory = preparedInventory.inventory;
const query = {
  taskId,
  taskRevisionSaid,
  sourceInventorySaid: inventory.d,
  corpusSaid,
  failureQuery: 'legacy parser rejects a CESR receipt',
  maximumResults: 3 as const,
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

it('denies a different Task revision or inventory before any HTTP request', async () => {
  let requests = 0;
  const adapter = new ServerExperienceRetrieval(origin(), 'b'.repeat(43), inventory, () => {
    requests += 1;
    throw new Error('wrong scope reached HTTP');
  });
  expect(await adapter.retrieve({ ...query, taskRevisionSaid: said('x') })).toEqual({
    kind: 'Denied',
  });
  expect(await adapter.retrieve({ ...query, sourceInventorySaid: said('x') })).toEqual({
    kind: 'Denied',
  });
  expect(requests).toBe(0);
  expect(
    () =>
      new ServerExperienceRetrieval(
        origin(),
        'b'.repeat(43),
        { ...inventory, corpusSaid: said('x') },
        () => Promise.reject(new Error('never')),
      ),
  ).toThrow('Context source inventory invalid');
});

it('preserves an irrelevant result as a distinct fail-closed outcome', async () => {
  const adapter = new ServerExperienceRetrieval(
    origin(),
    'b'.repeat(43),
    inventory,
    (url, init) => {
      expect(url).toBe('http://127.0.0.1:3211/api/experience/query');
      expect(init?.method).toBe('POST');
      return Promise.resolve(problem('ExperienceIrrelevant', 422));
    },
  );
  expect(await adapter.retrieve(query)).toEqual({ kind: 'Irrelevant' });
});

it('reports an unready Atlas index without exposing any synthetic hit', async () => {
  const adapter = new ServerExperienceRetrieval(origin(), 'b'.repeat(43), inventory, () =>
    Promise.resolve(problem('ExperienceIndexNotReady', 503)),
  );
  expect(await adapter.retrieve(query)).toEqual({ kind: 'IndexNotReady' });
});

it('retrieves only inventory-matching hits backed by an exact raw query receipt', async () => {
  const receiptBytes = new TextEncoder().encode(
    JSON.stringify({
      ownerAid,
      taskId,
      sourceInventorySaid: inventory.d,
      corpusSaid,
      failureQuery: query.failureQuery,
      sources: [source],
      chargedMicroUsd: 4,
      indexName: 'devrandom-experience',
      modelId: 'pinned-semantic-model',
      modelVersion: 'v1',
    }),
  );
  const artifact = prepareEvidenceArtifact(receiptBytes, 'application/json');
  if (artifact.kind !== 'Prepared') throw new Error(artifact.reason);
  const response = {
    version: 1 as const,
    kind: 'Retrieved' as const,
    sources: [source],
    queryReceiptSaid: artifact.artifact.d,
    chargedMicroUsd: 4,
  };
  let requests = 0;
  const adapter = new ServerExperienceRetrieval(
    origin(),
    'b'.repeat(43),
    inventory,
    (url, init) => {
      requests += 1;
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${'b'.repeat(43)}`);
      if (requests === 1) {
        expect(url).toBe('http://127.0.0.1:3211/api/experience/query');
        expect(init?.body).toBe(
          JSON.stringify({
            version: 1,
            taskId,
            sourceInventorySaid: inventory.d,
            corpusSaid,
            failureQuery: query.failureQuery,
            maximumResults: 3,
          }),
        );
        expect(typeof init?.body === 'string' ? init.body : '').not.toMatch(
          /atlas|mongodb|vector|ownerAid/u,
        );
        return Promise.resolve(
          new Response(JSON.stringify(response), {
            status: 200,
            headers: { 'cache-control': 'no-store' },
          }),
        );
      }
      expect(url).toBe(
        `http://127.0.0.1:3211/api/experience/query-receipts/${artifact.artifact.d}?taskId=${taskId}&sourceInventorySaid=${inventory.d}&offset=0&maximumBytes=32768`,
      );
      expect(init?.method).toBe('GET');
      return Promise.resolve(
        new Response(
          JSON.stringify({
            version: 1,
            kind: 'Read',
            artifact: artifact.artifact,
            totalBytes: receiptBytes.byteLength,
            offset: 0,
            bytesBase64Url: Buffer.from(receiptBytes).toString('base64url'),
          }),
          { status: 200, headers: { 'cache-control': 'no-store' } },
        ),
      );
    },
  );
  expect(await adapter.retrieve(query)).toEqual({
    kind: 'Retrieved',
    sources: [source],
    queryReceiptSaid: artifact.artifact.d,
    chargedMicroUsd: 4,
  });
  expect(requests).toBe(2);
});

it('does not expose a hit when its exact receipt is missing or describes a different corpus', async () => {
  const response = {
    version: 1,
    kind: 'Retrieved',
    sources: [source],
    queryReceiptSaid: said('q'),
    chargedMicroUsd: 4,
  };
  const missing = new ServerExperienceRetrieval(origin(), 'b'.repeat(43), inventory, (url) =>
    Promise.resolve(
      typeof url === 'string' && url.endsWith('/api/experience/query')
        ? new Response(JSON.stringify(response), {
            status: 200,
            headers: { 'cache-control': 'no-store' },
          })
        : problem('ExperienceDenied', 403),
    ),
  );
  expect(await missing.retrieve(query)).toEqual({ kind: 'Denied' });
  const wrongCorpusBytes = new TextEncoder().encode(
    JSON.stringify({
      ownerAid,
      taskId,
      sourceInventorySaid: inventory.d,
      corpusSaid: said('x'),
      failureQuery: query.failureQuery,
      sources: [source],
      chargedMicroUsd: 4,
      indexName: 'devrandom-experience',
      modelId: 'pinned-semantic-model',
      modelVersion: 'v1',
    }),
  );
  const wrongCorpusArtifact = prepareEvidenceArtifact(wrongCorpusBytes, 'application/json');
  if (wrongCorpusArtifact.kind !== 'Prepared') throw new Error(wrongCorpusArtifact.reason);
  const changed = new ServerExperienceRetrieval(origin(), 'b'.repeat(43), inventory, (url) =>
    Promise.resolve(
      typeof url === 'string' && url.endsWith('/api/experience/query')
        ? new Response(
            JSON.stringify({ ...response, queryReceiptSaid: wrongCorpusArtifact.artifact.d }),
            {
              status: 200,
              headers: { 'cache-control': 'no-store' },
            },
          )
        : new Response(
            JSON.stringify({
              version: 1,
              kind: 'Read',
              artifact: wrongCorpusArtifact.artifact,
              totalBytes: wrongCorpusBytes.byteLength,
              offset: 0,
              bytesBase64Url: Buffer.from(wrongCorpusBytes).toString('base64url'),
            }),
            { status: 200, headers: { 'cache-control': 'no-store' } },
          ),
    ),
  );
  expect(await changed.retrieve(query)).toEqual({ kind: 'Unavailable' });
});

it('rejects a returned episode outside the exact authorized source inventory', async () => {
  let requests = 0;
  const adapter = new ServerExperienceRetrieval(origin(), 'b'.repeat(43), inventory, () => {
    requests += 1;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          version: 1,
          kind: 'Retrieved',
          sources: [{ episodeSaid: said('x'), rawEvidenceSaid: said('y'), score: 0.98 }],
          queryReceiptSaid: said('q'),
          chargedMicroUsd: 4,
        }),
        { status: 200, headers: { 'cache-control': 'no-store' } },
      ),
    );
  });
  expect(await adapter.retrieve(query)).toEqual({ kind: 'Denied' });
  expect(requests).toBe(1);
});
