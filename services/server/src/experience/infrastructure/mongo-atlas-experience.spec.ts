import { randomUUID } from 'node:crypto';

import type { Db } from 'mongodb';
import { describe, expect, it, vi } from 'vitest';

import { prepareEvaluationSourceInventory } from '@devrandom/protocol';

import {
  exactExperiencePipeline,
  experienceCollectionNames,
  experienceIndexDefinition,
  MongoAtlasExperience,
} from './mongo-atlas-experience.js';
import { evaluationCollectionNames } from '../../evaluation/infrastructure/mongo-evaluation-reservations.js';

const said = (letter: string): string => `E${letter.repeat(43)}`;

describe('server-owned Atlas ENN boundary', () => {
  it('accepts Atlas Local READY metadata only in explicit local mode with the exact definition', async () => {
    const profile = {
      indexName: 'experience-v1',
      modelId: 'reviewed-model',
      modelVersion: '1',
      dimensions: 384,
      minimumScore: 0.7,
      maximumEmbeddingChargeMicroUsd: 0,
    };
    let currentDefinition: unknown = experienceIndexDefinition(384);
    const database = {
      collection: () => ({
        listSearchIndexes: () => ({
          toArray: () =>
            Promise.resolve([
              {
                name: profile.indexName,
                type: 'vectorSearch',
                status: 'READY',
                queryable: true,
                latestVersion: 0,
                latestDefinition: currentDefinition,
              },
            ]),
        }),
      }),
    } as unknown as Db;
    const dependencies = {
      profile,
      preparationsDatabase: database,
      embedding: { embed: () => Promise.resolve({ kind: 'Unavailable' as const }) },
      reading: { read: () => Promise.resolve({ kind: 'Denied' as const }) },
    };
    const cloud = new MongoAtlasExperience(database, dependencies);
    const local = new MongoAtlasExperience(database, {
      ...dependencies,
      deployment: 'AtlasLocal',
    });
    await expect(cloud.ensureIndex()).resolves.toBe('IndexNotReady');
    await expect(local.ensureIndex()).resolves.toBe('Ready');
    currentDefinition = { fields: [] };
    await expect(local.ensureIndex()).resolves.toBe('IndexNotReady');
  });

  it('pins exact search and filters owner, resource, corpus, disclosure and approved episodes before scoring', () => {
    const profile = {
      indexName: 'experience-v1',
      modelId: 'reviewed-model',
      modelVersion: '1',
      dimensions: 3,
      minimumScore: 0.7,
      maximumEmbeddingChargeMicroUsd: 100,
    };
    const [search, projection] = exactExperiencePipeline({
      profile,
      ownerAid: said('o'),
      repositoryResourceSaid: said('r'),
      corpusSaid: said('c'),
      episodeSaids: [said('a'), said('b')],
      vector: [0.1, 0.2, 0.3],
    });
    expect(search).toEqual({
      $vectorSearch: {
        index: 'experience-v1',
        path: 'embedding',
        queryVector: [0.1, 0.2, 0.3],
        exact: true,
        limit: 3,
        filter: {
          $and: [
            { ownerAid: { $eq: said('o') } },
            { repositoryResourceSaid: { $eq: said('r') } },
            { corpusSaid: { $eq: said('c') } },
            { disclosure: { $eq: 'AuthorizedAnalogy' } },
            { episodeSaid: { $in: [said('a'), said('b')] } },
            { embeddingModelId: { $eq: 'reviewed-model' } },
            { embeddingModelVersion: { $eq: '1' } },
          ],
        },
      },
    });
    expect(projection).toEqual({
      $project: {
        _id: 0,
        episodeSaid: 1,
        rawEvidenceSaid: 1,
        score: { $meta: 'vectorSearchScore' },
      },
    });
    expect(experienceIndexDefinition(3).fields).toContainEqual({
      type: 'filter',
      path: 'ownerAid',
    });
  });

  it('withholds an Atlas hit when its exact raw evidence can no longer be read', async () => {
    const ownerAid = said('o');
    const taskId = randomUUID();
    const taskRevisionSaid = said('t');
    const repositoryResourceSaid = said('r');
    const corpusSaid = said('c');
    const mandateSaid = said('m');
    const episodeSaid = said('e');
    const rawEvidenceSaid = said('a');
    const inventory = prepareEvaluationSourceInventory({
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
    if (inventory.kind !== 'Prepared') throw new Error(inventory.reason);
    const profile = {
      indexName: 'experience-v1',
      modelId: 'reviewed-model',
      modelVersion: '1',
      dimensions: 3,
      minimumScore: 0.7,
      maximumEmbeddingChargeMicroUsd: 100,
    };
    const insertOne = vi.fn();
    const database = {
      collection(name: string) {
        if (name === experienceCollectionNames.queryReceipts) return { insertOne };
        if (name === experienceCollectionNames.episodes)
          return {
            listSearchIndexes: () => ({
              toArray: () =>
                Promise.resolve([
                  {
                    name: profile.indexName,
                    type: 'vectorSearch',
                    status: 'READY',
                    queryable: true,
                    latestDefinitionVersion: { version: 1 },
                    latestDefinition: experienceIndexDefinition(profile.dimensions),
                    statusDetail: [
                      {
                        status: 'READY',
                        queryable: true,
                        mainIndex: {
                          status: 'READY',
                          queryable: true,
                          definitionVersion: { version: 1 },
                          definition: experienceIndexDefinition(profile.dimensions),
                        },
                      },
                    ],
                  },
                ]),
            }),
            aggregate: () => ({
              toArray: () =>
                Promise.resolve([
                  {
                    episodeSaid,
                    rawEvidenceSaid,
                    score: 0.95,
                  },
                ]),
            }),
          };
        throw new Error(`unexpected collection ${name}`);
      },
    } as unknown as Db;
    const preparationsDatabase = {
      collection(name: string) {
        if (name === evaluationCollectionNames.preparations)
          return { findOne: () => Promise.resolve({ sourceInventory: inventory.inventory }) };
        throw new Error(`hosted preparation lookup crossed into ${name}`);
      },
    } as unknown as Db;
    const read = vi.fn(() => Promise.resolve({ kind: 'Denied' as const }));
    const experience = new MongoAtlasExperience(database, {
      profile,
      embedding: {
        embed: () =>
          Promise.resolve({
            kind: 'Embedded' as const,
            vector: [0.1, 0.2, 0.3],
            chargedMicroUsd: 1,
          }),
      },
      reading: { read },
      preparationsDatabase,
    });
    const outcome = await experience.retrieve({
      ownerAid,
      query: {
        version: 1,
        taskId,
        sourceInventorySaid: inventory.inventory.d,
        corpusSaid,
        failureQuery: 'current receipt parse failure',
        maximumResults: 3,
      },
      scope: {
        ownerAid,
        taskId,
        taskRevisionSaid,
        repositoryResourceSaid,
        allowedCorpusSaid: corpusSaid,
        mandate: { kind: 'AuthorizedExperience', mandateSaid },
      },
    });
    expect(outcome).toEqual({ kind: 'Denied' });
    expect(read).toHaveBeenCalledOnce();
    expect(insertOne).not.toHaveBeenCalled();
  });
});
