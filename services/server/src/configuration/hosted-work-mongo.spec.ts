import { describe, expect, it } from 'vitest';

import { createHostedWorkMongoClient } from './hosted-work-mongo.js';
import { loadHostedWorkConfiguration } from './hosted-work-environment.js';

describe('hosted-work MongoDB durability', () => {
  it('enforces majority acknowledgement independently of URI query options', async () => {
    const configuration = loadHostedWorkConfiguration({
      DEVRANDOM_HOSTED_WORK_MONGODB_URI:
        'mongodb://127.0.0.1:27017/devrandom_e0?replicaSet=devrandom-rs',
    });
    const client = createHostedWorkMongoClient(configuration.mongodbUri);

    try {
      expect(client.options.writeConcern.w).toBe('majority');
    } finally {
      await client.close();
    }
  });
});
