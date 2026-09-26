import { randomUUID } from 'node:crypto';

import { Binary, type Db } from 'mongodb';
import { describe, expect, it, vi } from 'vitest';

import { prepareEvaluationSourceInventory, prepareEvidenceArtifact } from '@devrandom/protocol';

import { readExperienceQueryReceipt } from '../application/read-query-receipt.js';
import { MongoExperienceQueryReceipts } from './mongo-query-receipt-reading.js';

const said = (letter: string): string => `E${letter.repeat(43)}`;
const ownerAid = said('o');
const taskId = randomUUID();
const taskRevisionSaid = said('t');
const repositoryResourceSaid = said('r');
const corpusSaid = said('c');
const mandateSaid = said('m');
const episodeSaid = said('e');
const rawEvidenceSaid = said('a');
const profile = {
  indexName: 'experience-v1',
  modelId: 'reviewed-model',
  modelVersion: '1',
  dimensions: 3,
  minimumScore: 0.7,
  maximumEmbeddingChargeMicroUsd: 100,
};
const scope = {
  ownerAid,
  taskId,
  taskRevisionSaid,
  repositoryResourceSaid,
  allowedCorpusSaid: corpusSaid,
  mandate: { kind: 'AuthorizedExperience' as const, mandateSaid },
};
const prepared = prepareEvaluationSourceInventory({
  taskId,
  taskRevisionSaid,
  ownerAid,
  repositoryResourceSaid,
  corpusSaid,
  experienceMandateSaid: mandateSaid,
  sources: [
    {
      episodeSaid,
      rawEvidenceSaid,
      ownerAid,
      repositoryResourceSaid,
      corpusSaid,
      disclosure: 'AuthorizedAnalogy',
    },
  ],
});
if (prepared.kind !== 'Prepared') throw new Error('Inventory fixture rejected');
const inventory = prepared.inventory;

function fixture() {
  const sources = [{ episodeSaid, rawEvidenceSaid, score: 0.91 }];
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      ownerAid,
      taskId,
      sourceInventorySaid: inventory.d,
      corpusSaid,
      failureQuery: 'legacy parser failure',
      sources,
      chargedMicroUsd: 1,
      indexName: profile.indexName,
      modelId: profile.modelId,
      modelVersion: profile.modelVersion,
    }),
  );
  const preparedArtifact = prepareEvidenceArtifact(bytes, 'application/json');
  if (preparedArtifact.kind !== 'Prepared') throw new Error('Receipt fixture rejected');
  const receipt = {
    _id: preparedArtifact.artifact.d,
    ownerAid,
    taskId,
    taskRevisionSaid,
    repositoryResourceSaid,
    corpusSaid,
    sourceInventorySaid: inventory.d,
    indexName: profile.indexName,
    modelId: profile.modelId,
    modelVersion: profile.modelVersion,
    query: 'legacy parser failure',
    sources,
    chargedMicroUsd: 1,
    artifact: preparedArtifact.artifact,
    bytes: new Binary(bytes),
    acceptedAt: new Date(),
  };
  const episode = {
    _id: episodeSaid,
    ownerAid,
    episodeSaid,
    rawEvidenceSaid,
    repositoryResourceSaid,
    corpusSaid,
    disclosure: 'AuthorizedAnalogy',
    sourceInventorySaid: inventory.d,
    embeddingModelId: profile.modelId,
    embeddingModelVersion: profile.modelVersion,
    embedding: [1, 0, 0],
  };
  const rawRead = vi.fn(() =>
    Promise.resolve({
      kind: 'Read' as const,
      bytes: Uint8Array.of(65),
      totalBytes: 1,
      sourceSaid: episodeSaid,
      readReceiptSaid: said('q'),
    }),
  );
  const database = {
    collection(name: string) {
      if (name === 'experienceQueryReceipts') return { findOne: () => Promise.resolve(receipt) };
      if (name === 'evaluationPreparations')
        return { findOne: () => Promise.resolve({ sourceInventory: inventory }) };
      if (name === 'experienceEpisodes') return { findOne: () => Promise.resolve(episode) };
      throw new Error(`Unexpected collection ${name}`);
    },
  } as unknown as Db;
  const receipts = new MongoExperienceQueryReceipts(database, {
    profile,
    reading: { read: rawRead },
  });
  const scopes = { inspect: () => Promise.resolve({ kind: 'Authorized' as const, scope }) };
  const input = {
    ownerAid,
    taskId,
    sourceInventorySaid: inventory.d,
    receiptSaid: receipt._id,
    offset: 0,
    maximumBytes: 32 * 1024,
  };
  return { receipt, episode, bytes, rawRead, receipts, scopes, input };
}

describe('exact Experience query receipt reading', () => {
  it('returns exact verified bytes and metadata after current scope and raw source recheck', async () => {
    const { bytes, rawRead, receipts, scopes, input } = fixture();
    await expect(readExperienceQueryReceipt(input, { scopes, receipts })).resolves.toMatchObject({
      kind: 'Read',
      bytes,
      totalBytes: bytes.byteLength,
      offset: 0,
    });
    expect(rawRead).toHaveBeenCalledOnce();
  });

  it('returns the same bounded byte range on exact retry and rejects an oversized range', async () => {
    const { bytes, receipts, scopes, input } = fixture();
    const request = { ...input, offset: 7, maximumBytes: 11 };
    const first = await readExperienceQueryReceipt(request, { scopes, receipts });
    const retry = await readExperienceQueryReceipt(request, { scopes, receipts });
    expect(first).toMatchObject({
      kind: 'Read',
      bytes: bytes.slice(7, 18),
      totalBytes: bytes.byteLength,
      offset: 7,
    });
    expect(retry).toEqual(first);
    await expect(
      readExperienceQueryReceipt({ ...request, maximumBytes: 32 * 1024 + 1 }, { scopes, receipts }),
    ).resolves.toMatchObject({ kind: 'Denied' });
  });

  it('denies a receipt whose exact bytes or current source custody no longer verify', async () => {
    const altered = fixture();
    altered.receipt.bytes = new Binary(new TextEncoder().encode('forged'));
    await expect(readExperienceQueryReceipt(altered.input, altered)).resolves.toMatchObject({
      kind: 'Denied',
    });
    expect(altered.rawRead).not.toHaveBeenCalled();

    const lost = fixture();
    lost.rawRead.mockResolvedValueOnce({
      kind: 'NotFound',
    } as never);
    await expect(readExperienceQueryReceipt(lost.input, lost)).resolves.toMatchObject({
      kind: 'Denied',
    });
  });

  it('denies a changed current scope or a conflicting model/source binding', async () => {
    const changed = fixture();
    await expect(
      readExperienceQueryReceipt(changed.input, {
        receipts: changed.receipts,
        scopes: {
          inspect: () =>
            Promise.resolve({
              kind: 'Authorized' as const,
              scope: { ...scope, repositoryResourceSaid: said('x') },
            }),
        },
      }),
    ).resolves.toMatchObject({ kind: 'Denied' });
    const conflicting = fixture();
    conflicting.episode.embeddingModelVersion = 'other';
    await expect(readExperienceQueryReceipt(conflicting.input, conflicting)).resolves.toMatchObject(
      {
        kind: 'Denied',
      },
    );
    const disclosure = fixture();
    disclosure.episode.disclosure = 'Protected';
    await expect(readExperienceQueryReceipt(disclosure.input, disclosure)).resolves.toMatchObject({
      kind: 'Denied',
    });
  });
});
