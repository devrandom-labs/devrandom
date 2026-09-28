import { setTimeout as delay } from 'node:timers/promises';

import { MongoClient, type Db } from 'mongodb';

import {
  verifyAtlasExperienceModelCache,
  type AtlasExperienceConfiguration,
} from '../../configuration/atlas-experience-environment.js';
import { MongoEvidenceReading } from '../../evidence/infrastructure/mongo-evidence-reading.js';
import type { ExperienceSourceAdmission } from '../application/retrieve-experience.js';
import {
  HuggingFaceExperienceEmbedding,
  pinnedAtlasExperienceProfile,
} from '../infrastructure/huggingface-experience-embedding.js';
import {
  MongoAtlasExperience,
  experienceCollectionNames,
} from '../infrastructure/mongo-atlas-experience.js';
import { MongoExperienceQueryReceipts } from '../infrastructure/mongo-query-receipt-reading.js';

export type ServerAtlasExperience =
  | {
      readonly kind: 'Unavailable';
      readonly reason: 'Disabled' | 'Cache' | 'Model' | 'Connection' | 'Index';
      readonly sources: ExperienceSourceAdmission;
      verify(): Promise<void>;
      close(): Promise<void>;
    }
  | {
      readonly kind: 'Available';
      readonly experience: MongoAtlasExperience;
      readonly receipts: MongoExperienceQueryReceipts;
      readonly sources: ExperienceSourceAdmission;
      verify(): Promise<void>;
      close(): Promise<void>;
    };

function unavailable(
  reason: Extract<ServerAtlasExperience, { kind: 'Unavailable' }>['reason'],
): ServerAtlasExperience {
  return {
    kind: 'Unavailable',
    reason,
    sources: { admitSource: () => Promise.resolve('Unavailable') },
    verify: () => Promise.reject(new Error('Atlas Experience is unavailable')),
    close: () => Promise.resolve(),
  };
}

/** The server alone holds Atlas credentials; hosted Mongo remains the source of custody. */
export async function openServerAtlasExperience(
  configuration: AtlasExperienceConfiguration,
  hostedDatabase: Db,
): Promise<ServerAtlasExperience> {
  if (configuration.kind === 'Disabled') return unavailable('Disabled');
  let client: MongoClient | undefined;
  let stage: Extract<ServerAtlasExperience, { kind: 'Unavailable' }>['reason'] = 'Cache';
  try {
    await verifyAtlasExperienceModelCache(configuration.modelCacheDirectory);
    stage = 'Model';
    const embedding = new HuggingFaceExperienceEmbedding({
      cacheDirectory: configuration.modelCacheDirectory,
    });
    const model = await embedding.embed({
      text: 'Devrandom Experience semantic model readiness',
      modelId: pinnedAtlasExperienceProfile.modelId,
      modelVersion: pinnedAtlasExperienceProfile.modelVersion,
      dimensions: pinnedAtlasExperienceProfile.dimensions,
    });
    if (model.kind !== 'Embedded') return unavailable('Model');

    stage = 'Connection';
    client = new MongoClient(configuration.mongodbUri, {
      serverSelectionTimeoutMS: 5_000,
      socketTimeoutMS: 30_000,
    });
    await client.connect();
    const activeClient = client;
    const database = client.db(configuration.databaseName);
    const episodes = await database
      .listCollections({ name: experienceCollectionNames.episodes }, { nameOnly: true })
      .toArray();
    if (episodes.length === 0) {
      try {
        await database.createCollection(experienceCollectionNames.episodes);
      } catch (cause) {
        if (!(cause instanceof Error && 'code' in cause && cause.code === 48)) throw cause;
      }
    }
    const reading = new MongoEvidenceReading(hostedDatabase);
    const experience = new MongoAtlasExperience(database, {
      embedding,
      profile: pinnedAtlasExperienceProfile,
      preparationsDatabase: hostedDatabase,
      reading,
      deployment: configuration.deployment,
    });
    const receipts = new MongoExperienceQueryReceipts(database, {
      profile: pinnedAtlasExperienceProfile,
      preparationsDatabase: hostedDatabase,
      reading,
    });
    stage = 'Index';
    let index = await experience.ensureIndex();
    const indexBootstrapDeadline = Date.now() + 30_000;
    while (index === 'Unavailable' && Date.now() < indexBootstrapDeadline) {
      await delay(1_000);
      index = await experience.ensureIndex();
    }
    if (index === 'Unavailable') {
      await client.close();
      return unavailable('Index');
    }
    return {
      kind: 'Available',
      experience,
      receipts,
      sources: {
        async admitSource(input) {
          return (await experience.ensureIndex()) === 'Ready'
            ? experience.admitSource(input)
            : 'Unavailable';
        },
      },
      async verify() {
        if ((await experience.ensureIndex()) !== 'Ready')
          throw new Error('Atlas Experience index is not ready');
      },
      close: () => activeClient.close(),
    };
  } catch {
    await client?.close();
    return unavailable(stage);
  }
}
