import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

import { type Collection, MongoClient } from 'mongodb';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const vectorIndex = {
  name: 'e0-evidence-layers-vector',
  type: 'vectorSearch' as const,
  definition: {
    fields: [
      {
        type: 'vector',
        path: 'embedding',
        numDimensions: 3,
        similarity: 'dotProduct',
      },
      { type: 'filter', path: 'sourceEvidenceId' },
      { type: 'filter', path: 'resourceId' },
      { type: 'filter', path: 'kind' },
    ],
  },
};

interface SearchIndexStatus {
  readonly latestDefinition?: unknown;
  readonly name?: unknown;
  readonly queryable?: unknown;
  readonly status?: unknown;
  readonly type?: unknown;
}

interface RawEvidenceProbe {
  readonly _id: string;
  readonly observation: string;
}

interface EvidenceLayerProbe {
  readonly _id: string;
  readonly embedding: readonly number[];
  readonly kind: string;
  readonly resourceId: string;
  readonly sourceEvidenceId: string;
}

interface VectorMatch {
  readonly _id: string;
  readonly kind: string;
  readonly resourceId: string;
  readonly score: number;
  readonly sourceEvidenceId: string;
}

type Readiness =
  | { readonly state: 'pending' }
  | { readonly state: 'ready' }
  | { readonly state: 'rejected'; readonly reason: string };

function readiness(index: SearchIndexStatus | undefined): Readiness {
  if (index === undefined || index.status === 'PENDING' || index.status === 'BUILDING') {
    return { state: 'pending' };
  }
  if (index.status === 'FAILED' || index.status === 'STALE') {
    return { state: 'rejected', reason: `search index entered ${index.status}` };
  }
  if (
    index.name === vectorIndex.name &&
    index.type === vectorIndex.type &&
    index.status === 'READY' &&
    index.queryable === true &&
    isDeepStrictEqual(index.latestDefinition, vectorIndex.definition)
  ) {
    return { state: 'ready' };
  }
  return { state: 'rejected', reason: 'ready search index does not match the E0 contract' };
}

async function awaitVectorIndex(
  collection: Collection<EvidenceLayerProbe>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [index] = await collection.listSearchIndexes(vectorIndex.name).toArray();
    const result = readiness(index);
    if (result.state === 'ready') {
      return;
    }
    if (result.state === 'rejected') {
      throw new Error(result.reason);
    }
    await delay(1_000);
  }
  throw new Error(`search index ${vectorIndex.name} was not ready before the deadline`);
}

describe('E0 Atlas Vector Search contract', () => {
  it('commits a provenance-filtered synthetic index shape', () => {
    expect(vectorIndex).toEqual({
      name: 'e0-evidence-layers-vector',
      type: 'vectorSearch',
      definition: {
        fields: [
          {
            type: 'vector',
            path: 'embedding',
            numDimensions: 3,
            similarity: 'dotProduct',
          },
          { type: 'filter', path: 'sourceEvidenceId' },
          { type: 'filter', path: 'resourceId' },
          { type: 'filter', path: 'kind' },
        ],
      },
    });
  });

  it.each([
    [undefined, 'pending'],
    [{ status: 'PENDING' }, 'pending'],
    [{ status: 'BUILDING', queryable: true }, 'pending'],
    [{ status: 'FAILED' }, 'rejected'],
    [{ status: 'STALE' }, 'rejected'],
    [
      {
        ...vectorIndex,
        status: 'READY',
        queryable: true,
        latestDefinition: { fields: [] },
      },
      'rejected',
    ],
    [
      {
        ...vectorIndex,
        status: 'READY',
        queryable: true,
        latestDefinition: vectorIndex.definition,
      },
      'ready',
    ],
  ] as const)(
    'classifies search-index readiness without accepting stale definitions',
    (index, state) => {
      expect(readiness(index).state).toBe(state);
    },
  );
});

const atlasUri = process.env.DEVRANDOM_ATLAS_URI;
const describeWithAtlas = atlasUri === undefined ? describe.skip : describe;
const atlasDatabaseName = process.env.DEVRANDOM_ATLAS_DATABASE ?? 'devrandom_e0';
const namespace = `${String(process.pid)}_${String(Date.now())}`;
const resourceId = `repository:devrandom:e0:${namespace}`;
const sourceEvidenceIds = [
  `evidence:raw:1:${namespace}`,
  `evidence:raw:2:${namespace}`,
  `evidence:raw:3:${namespace}`,
] as const;

describeWithAtlas('E0 live Atlas contract', () => {
  const client = new MongoClient(atlasUri ?? 'mongodb://127.0.0.1:27017', {
    serverSelectionTimeoutMS: 10_000,
    socketTimeoutMS: 30_000,
  });
  const database = client.db(atlasDatabaseName);
  const evidence = database.collection<RawEvidenceProbe>('e0_evidence');
  const evidenceLayers = database.collection<EvidenceLayerProbe>('e0_evidence_layers');

  beforeAll(async () => {
    await client.connect();
  });

  afterAll(async () => {
    await Promise.allSettled([
      evidence.deleteMany({ _id: { $in: [...sourceEvidenceIds] } }),
      evidenceLayers.deleteMany({ resourceId }),
    ]);
    await client.close();
  });

  it('writes, reads, retrieves, and dereferences provenance through a live vector index', async () => {
    await evidence.insertMany([
      { _id: sourceEvidenceIds[0], observation: 'tool authorization was denied' },
      { _id: sourceEvidenceIds[1], observation: 'build completed' },
      { _id: sourceEvidenceIds[2], observation: 'unrelated repository episode' },
    ]);
    await evidenceLayers.insertMany([
      {
        _id: `layer:1:${namespace}`,
        sourceEvidenceId: sourceEvidenceIds[0],
        resourceId,
        kind: 'compatibility-episode',
        embedding: [1, 0, 0],
      },
      {
        _id: `layer:2:${namespace}`,
        sourceEvidenceId: sourceEvidenceIds[1],
        resourceId,
        kind: 'compatibility-episode',
        embedding: [0, 1, 0],
      },
      {
        _id: `layer:3:${namespace}`,
        sourceEvidenceId: sourceEvidenceIds[2],
        resourceId: `repository:other:e0:${namespace}`,
        kind: 'compatibility-episode',
        embedding: [1, 0, 0],
      },
    ]);

    await expect(evidence.findOne({ _id: sourceEvidenceIds[0] })).resolves.toMatchObject({
      observation: 'tool authorization was denied',
    });
    const [existingIndex] = await evidenceLayers.listSearchIndexes(vectorIndex.name).toArray();
    if (existingIndex === undefined) {
      await evidenceLayers.createSearchIndex(vectorIndex);
    }
    await awaitVectorIndex(evidenceLayers, 180_000);

    const pipeline = [
      {
        $vectorSearch: {
          index: vectorIndex.name,
          path: 'embedding',
          queryVector: [1, 0, 0],
          exact: true,
          filter: {
            $and: [{ resourceId: { $eq: resourceId } }, { kind: { $eq: 'compatibility-episode' } }],
          },
          limit: 1,
        },
      },
      {
        $project: {
          _id: 1,
          sourceEvidenceId: 1,
          resourceId: 1,
          kind: 1,
          score: { $meta: 'vectorSearchScore' },
        },
      },
    ];
    let matches: VectorMatch[] = [];
    const ingestionDeadline = Date.now() + 60_000;
    while (Date.now() < ingestionDeadline) {
      matches = await evidenceLayers.aggregate<VectorMatch>(pipeline).toArray();
      if (matches.length > 0) break;
      await delay(1_000);
    }

    expect(matches).toHaveLength(1);
    const [match] = matches;
    if (match === undefined) {
      throw new Error('expected one provenance-linked vector match');
    }
    expect(match).toMatchObject({
      _id: `layer:1:${namespace}`,
      sourceEvidenceId: sourceEvidenceIds[0],
      resourceId,
      kind: 'compatibility-episode',
    });
    expect(match.score).toBeTypeOf('number');
    await expect(evidence.findOne({ _id: match.sourceEvidenceId })).resolves.toMatchObject({
      _id: sourceEvidenceIds[0],
      observation: 'tool authorization was denied',
    });

    await expect(
      evidenceLayers
        .aggregate([
          {
            $vectorSearch: {
              index: vectorIndex.name,
              path: 'embedding',
              queryVector: [1, 0],
              exact: true,
              limit: 1,
            },
          },
        ])
        .toArray(),
    ).rejects.toThrow();
  }, 240_000);
});
