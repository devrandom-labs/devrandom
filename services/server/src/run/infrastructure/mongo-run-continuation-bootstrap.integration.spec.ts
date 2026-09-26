import { randomUUID } from 'node:crypto';

import { taskBudgetCeilings } from '@devrandom/domain';
import { prepareRunSuccessorSegment } from '@devrandom/protocol';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  MongoRunContinuationBootstrap,
  RunSuccessorSegmentStorageDrift,
  runSuccessorSegmentIndex,
} from './mongo-run-continuation-bootstrap.js';
import {
  runSuccessorSegmentsCollectionName,
  type RunSuccessorSegmentDocument,
} from './mongo-run-continuations.js';

const uri = process.env.DEVRANDOM_MONGODB_URI;
const integration = uri === undefined ? describe.skip : describe;
const said = (character: string) => `E${character.repeat(43)}`;

integration('Run successor segment Mongo custody', () => {
  const client = new MongoClient(uri ?? 'mongodb://127.0.0.1:27017', {
    writeConcern: { w: 'majority' },
  });
  const database = client.db(`devrandom_run_successor_${randomUUID().replaceAll('-', '')}`);
  const bootstrap = new MongoRunContinuationBootstrap(database);

  beforeAll(async () => {
    await client.connect();
  });
  afterAll(async () => {
    await database.dropDatabase();
    await client.close();
  });

  function segment(predecessorStreamId: string, successorStreamId: string) {
    const prepared = prepareRunSuccessorSegment({
      version: 1,
      kind: 'RunSuccessorSegment',
      runId: '11111111-1111-4111-8111-111111111111',
      taskId: '22222222-2222-4222-8222-222222222222',
      taskRevisionSaid: said('t'),
      ownerAid: said('o'),
      personalAgentAid: said('a'),
      taskMandateSaid: said('m'),
      fromRunVersion: 3,
      predecessor: {
        incarnationId: randomUUID(),
        evidenceStreamId: predecessorStreamId,
        checkpointSaid: said('c'),
        sealExchangeSaid: said('s'),
        finalSequence: 4,
        chainHeadSaid: said('h'),
      },
      successor: {
        incarnationId: randomUUID(),
        evidenceStreamId: successorStreamId,
        harnessRevisionSaid: said('r'),
      },
      activation: { pointerVersion: 2, decisionReceiptSaid: said('p') },
      consumedBudget: taskBudgetCeilings,
      admittedAt: '2026-09-26T14:00:00.000Z',
    });
    if (prepared.kind !== 'Prepared') throw new Error('segment fixture');
    return prepared.segment;
  }

  it('keeps one immutable successor per predecessor while allowing a later same-Run segment', async () => {
    await bootstrap.bootstrap();
    await bootstrap.bootstrap();
    const collection = database.collection<RunSuccessorSegmentDocument>(
      runSuccessorSegmentsCollectionName,
    );
    const predecessor = randomUUID();
    const first = segment(predecessor, randomUUID());
    await collection.insertOne({
      _id: first.d,
      ownerAid: first.ownerAid,
      runId: first.runId,
      segment: first,
      acceptedAt: new Date(first.admittedAt),
    });
    const competing = segment(predecessor, randomUUID());
    await expect(
      collection.insertOne({
        _id: competing.d,
        ownerAid: competing.ownerAid,
        runId: competing.runId,
        segment: competing,
        acceptedAt: new Date(competing.admittedAt),
      }),
    ).rejects.toMatchObject({ code: 11_000 });
    const later = segment(first.successor.evidenceStreamId, randomUUID());
    await collection.insertOne({
      _id: later.d,
      ownerAid: later.ownerAid,
      runId: later.runId,
      segment: later,
      acceptedAt: new Date(later.admittedAt),
    });
    expect(await collection.countDocuments({ runId: first.runId })).toBe(2);
    expect(await collection.indexExists(runSuccessorSegmentIndex.name)).toBe(true);
    await database.command({
      collMod: runSuccessorSegmentsCollectionName,
      validator: { $jsonSchema: { bsonType: 'object' } },
      validationLevel: 'strict',
      validationAction: 'error',
    });
    await expect(bootstrap.verify()).rejects.toEqual(new RunSuccessorSegmentStorageDrift());
  });
});
