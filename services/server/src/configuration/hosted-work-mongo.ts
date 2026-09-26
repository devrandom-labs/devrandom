import { MongoClient } from 'mongodb';

import type { HostedWorkMongoUri } from './hosted-work-environment.js';

export function createHostedWorkMongoClient(
  mongodbUri: HostedWorkMongoUri,
  serverSelectionTimeoutMS?: number,
): MongoClient {
  return new MongoClient(mongodbUri, {
    writeConcern: { w: 'majority' },
    ...(serverSelectionTimeoutMS === undefined ? {} : { serverSelectionTimeoutMS }),
  });
}
