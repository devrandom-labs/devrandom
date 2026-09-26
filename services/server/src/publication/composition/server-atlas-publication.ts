import { MongoClient } from 'mongodb';
import type { AtlasExperienceConfiguration } from '../../configuration/atlas-experience-environment.js';
import { MongoPublicationBootstrap } from '../infrastructure/mongo-publication-bootstrap.js';
import { hostedHarnessPublication } from './hosted-publication.js';
export type ServerAtlasPublication =
  | {
      readonly kind: 'Available';
      readonly publication: ReturnType<typeof hostedHarnessPublication>;
      verify(): Promise<void>;
      close(): Promise<void>;
    }
  | { readonly kind: 'Unavailable'; close(): Promise<void> };
/** Explicit bootstrap is the only writer of Atlas publication collection schemas. */
export async function bootstrapAtlasHarnessPublication(
  configuration: AtlasExperienceConfiguration,
): Promise<void> {
  if (configuration.kind === 'Disabled') return;
  const client = new MongoClient(configuration.mongodbUri, {
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 30000,
  });
  try {
    await client.connect();
    await new MongoPublicationBootstrap(client.db(configuration.databaseName)).bootstrap();
  } finally {
    await client.close();
  }
}
/** Publication uses Atlas independently of embeddings; hosted Mongo only supplies current activation custody. */
export async function openServerAtlasPublication(
  configuration: AtlasExperienceConfiguration,
  dependencies: Pick<Parameters<typeof hostedHarnessPublication>[0], 'activation' | 'signatures'>,
): Promise<ServerAtlasPublication> {
  if (configuration.kind === 'Disabled')
    return { kind: 'Unavailable', close: () => Promise.resolve() };
  const client = new MongoClient(configuration.mongodbUri, {
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 30000,
  });
  try {
    await client.connect();
    const database = client.db(configuration.databaseName);
    const bootstrap = new MongoPublicationBootstrap(database);
    await bootstrap.verify();
    return {
      kind: 'Available',
      publication: hostedHarnessPublication({ client, database, ...dependencies }),
      verify: () => bootstrap.verify(),
      close: () => client.close(),
    };
  } catch {
    await client.close();
    return { kind: 'Unavailable', close: () => Promise.resolve() };
  }
}
