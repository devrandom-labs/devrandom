import { randomUUID } from 'node:crypto';

import type { Db } from 'mongodb';
import { describe, expect, it, vi } from 'vitest';

import { prepareEvaluationSourceInventory } from '@devrandom/protocol';

import { MongoAtlasExperience, experienceIndexDefinition } from './mongo-atlas-experience.js';
import { evaluationCollectionNames } from '../../evaluation/infrastructure/mongo-evaluation-reservations.js';

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

describe('Atlas Experience source and active-index boundary', () => {
  it('denies source admission when the exact raw read belongs to a different episode', async () => {
    const insertOne = vi.fn(() => Promise.resolve());
    const database = {
      collection(name: string) {
        if (name === 'experienceEpisodes')
          return { findOne: () => Promise.resolve(null), insertOne };
        return {};
      },
    } as unknown as Db;
    const embedding = {
      embed: vi.fn(() =>
        Promise.resolve({ kind: 'Embedded' as const, vector: [1, 0, 0], chargedMicroUsd: 1 }),
      ),
    };
    const experience = new MongoAtlasExperience(database, {
      profile,
      preparationsDatabase: database,
      embedding,
      reading: {
        read: () =>
          Promise.resolve({
            kind: 'Read' as const,
            bytes: new TextEncoder().encode('authorized source'),
            totalBytes: 17,
            sourceSaid: said('x'),
            readReceiptSaid: said('q'),
          }),
      },
    });
    await expect(
      experience.admitSource({ ownerAid, inventory, episodeSaid, rawEvidenceSaid, scope }),
    ).resolves.toBe('Denied');
    expect(embedding.embed).not.toHaveBeenCalled();
    expect(insertOne).not.toHaveBeenCalled();
  });

  it('does not call a conflicting disclosure or episode document already admitted', async () => {
    const database = {
      collection(name: string) {
        if (name === 'experienceEpisodes')
          return {
            findOne: () =>
              Promise.resolve({
                _id: episodeSaid,
                ownerAid,
                episodeSaid: said('x'),
                rawEvidenceSaid,
                repositoryResourceSaid,
                corpusSaid,
                sourceInventorySaid: inventory.d,
                disclosure: 'Protected',
                embeddingModelId: profile.modelId,
                embeddingModelVersion: profile.modelVersion,
                embedding: [1, 0, 0],
              }),
          };
        return {};
      },
    } as unknown as Db;
    const bytes = new TextEncoder().encode('authorized source');
    const experience = new MongoAtlasExperience(database, {
      profile,
      preparationsDatabase: database,
      embedding: {
        embed: () =>
          Promise.resolve({ kind: 'Embedded' as const, vector: [1, 0, 0], chargedMicroUsd: 1 }),
      },
      reading: {
        read: () =>
          Promise.resolve({
            kind: 'Read' as const,
            bytes,
            totalBytes: bytes.byteLength,
            sourceSaid: episodeSaid,
            readReceiptSaid: said('q'),
          }),
      },
    });
    await expect(
      experience.admitSource({ ownerAid, inventory, episodeSaid, rawEvidenceSaid, scope }),
    ).resolves.toBe('Denied');
  });

  it('refuses a queryable old main index while the intended latest definition is building', async () => {
    const database = {
      collection(name: string) {
        if (name === 'experienceEpisodes')
          return {
            listSearchIndexes: () => ({
              toArray: () =>
                Promise.resolve([
                  {
                    name: profile.indexName,
                    type: 'vectorSearch',
                    status: 'READY',
                    queryable: true,
                    latestDefinitionVersion: { version: 2 },
                    latestDefinition: experienceIndexDefinition(profile.dimensions),
                    statusDetail: [
                      {
                        status: 'BUILDING',
                        queryable: true,
                        mainIndex: {
                          status: 'READY',
                          queryable: true,
                          definitionVersion: { version: 1 },
                          definition: { fields: [] },
                        },
                        stagedIndex: {
                          status: 'BUILDING',
                          queryable: false,
                          definitionVersion: { version: 2 },
                          definition: experienceIndexDefinition(profile.dimensions),
                        },
                      },
                    ],
                  },
                ]),
            }),
          };
        if (name === evaluationCollectionNames.preparations) return {};
        return {};
      },
    } as unknown as Db;
    const experience = new MongoAtlasExperience(database, {
      profile,
      preparationsDatabase: database,
      embedding: { embed: () => Promise.resolve({ kind: 'Unavailable' as const }) },
      reading: { read: () => Promise.resolve({ kind: 'Denied' as const }) },
    });
    await expect(experience.ensureIndex()).resolves.toBe('IndexNotReady');
  });
});
