import { Long, MongoClient, type MongoServerError } from 'mongodb';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const mongodbUri = process.env.DEVRANDOM_MONGODB_URI;
const describeWithMongoDB = mongodbUri === undefined ? describe.skip : describe;
const databaseName = `devrandom_e0_${String(process.pid)}_${String(Date.now())}`;

interface AdapterProbe {
  readonly _id: string;
  readonly recordedAt?: Date;
  readonly resourceId: string;
  readonly sequence?: Long;
}

describeWithMongoDB('E0 MongoDB adapter contract', () => {
  const client = new MongoClient(mongodbUri ?? 'mongodb://127.0.0.1:27017', {
    promoteLongs: false,
    serverSelectionTimeoutMS: 5_000,
  });

  beforeAll(async () => {
    await client.connect();
  });

  afterAll(async () => {
    await client.db(databaseName).dropDatabase();
    await client.close();
  });

  it('round-trips BSON and enforces an ordinary unique index', async () => {
    const database = client.db(databaseName);
    const collection = database.collection<AdapterProbe>('adapter_probes');
    const recordedAt = new Date('2026-09-23T00:00:00.000Z');

    await expect(database.command({ ping: 1 })).resolves.toMatchObject({ ok: 1 });
    await collection.createIndex({ resourceId: 1 }, { name: 'resource-id-unique', unique: true });
    await collection.insertOne({
      _id: 'probe-1',
      resourceId: 'repository:devrandom',
      recordedAt,
      sequence: Long.fromNumber(1),
    });

    const stored = await collection.findOne({ _id: 'probe-1' });
    expect(stored).toEqual({
      _id: 'probe-1',
      resourceId: 'repository:devrandom',
      recordedAt,
      sequence: Long.fromNumber(1),
    });
    await expect(
      collection.insertOne({ _id: 'probe-2', resourceId: 'repository:devrandom' }),
    ).rejects.toMatchObject<Partial<MongoServerError>>({ code: 11_000 });
    await expect(collection.indexExists('resource-id-unique')).resolves.toBe(true);
  });
});
