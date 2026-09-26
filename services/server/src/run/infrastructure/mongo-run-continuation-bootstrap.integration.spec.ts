import { randomUUID } from 'node:crypto';

import { taskBudgetCeilings } from '@devrandom/domain';
import { prepareRunSuccessorSegment } from '@devrandom/protocol';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  MongoRunContinuationBootstrap,
  RunSuccessorSegmentStorageDrift,
  runSuccessorSegmentIndex,
  retainedRunSuccessorSegmentValidator,
  unlinkedRunSuccessorSegmentValidator,
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
    if (prepared.kind !== 'Prepared' || prepared.segment.version !== 1)
      throw new Error('segment fixture');
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
  it('explicitly adds ancestor links while preserving historical v2 records and indexes', async () => {
    await database.collection(runSuccessorSegmentsCollectionName).drop();
    await database.createCollection(runSuccessorSegmentsCollectionName, {
      validator: unlinkedRunSuccessorSegmentValidator,
      validationLevel: 'strict',
      validationAction: 'error',
    });
    const collection = database.collection<RunSuccessorSegmentDocument>(
      runSuccessorSegmentsCollectionName,
    );
    await collection.createIndex(runSuccessorSegmentIndex.key, {
      name: runSuccessorSegmentIndex.name,
      unique: true,
    });
    const first = segment(randomUUID(), randomUUID());
    const { d: _d, activation: _activation, ...body } = first;
    expect(_d).toBeTruthy();
    expect(_activation).toBeDefined();
    const prepared = prepareRunSuccessorSegment({
      ...body,
      version: 2,
      kind: 'CalibrationContinuationSegment',
      baseline: { pointerVersion: 1, harnessRevisionSaid: first.successor.harnessRevisionSaid },
    });
    if (prepared.kind !== 'Prepared') throw new Error('v2 fixture');
    const original = prepared.segment;
    const document = {
      _id: original.d,
      ownerAid: original.ownerAid,
      runId: original.runId,
      segment: original,
      acceptedAt: new Date(original.admittedAt),
    };
    await collection.insertOne(document);
    const indexes = await collection.listIndexes().toArray();
    const { d: originalSaid, ...originalBody } = original;
    const next = prepareRunSuccessorSegment({
      ...originalBody,
      predecessor: {
        ...original.predecessor,
        evidenceStreamId: original.successor.evidenceStreamId,
        segmentSaid: originalSaid,
      },
      successor: {
        ...original.successor,
        incarnationId: randomUUID(),
        evidenceStreamId: randomUUID(),
      },
    });
    if (next.kind !== 'Prepared') throw new Error('linked fixture');
    const linked = { ...document, _id: next.segment.d, segment: next.segment };
    await expect(collection.insertOne(linked)).rejects.toMatchObject({ code: 121 });
    await expect(bootstrap.bootstrap()).rejects.toEqual(new RunSuccessorSegmentStorageDrift());
    await collection.updateOne({ _id: original.d }, { $set: { acceptedAt: new Date(0) } });
    await expect(bootstrap.allowCalibrationContinuation()).rejects.toEqual(
      new RunSuccessorSegmentStorageDrift(),
    );
    await collection.updateOne({ _id: original.d }, { $set: { acceptedAt: document.acceptedAt } });
    await collection.createIndex({ ownerAid: 1 }, { name: 'unrelated' });
    await expect(bootstrap.allowCalibrationContinuation()).rejects.toEqual(
      new RunSuccessorSegmentStorageDrift(),
    );
    await collection.dropIndex('unrelated');
    await bootstrap.allowCalibrationContinuation();
    await bootstrap.allowCalibrationContinuation();
    expect(await collection.findOne({ _id: original.d })).toEqual(document);
    expect(await collection.listIndexes().toArray()).toEqual(indexes);
    await collection.insertOne(linked);
    expect(await collection.countDocuments()).toBe(2);
  });
  it('migrates only the exact historical validator without rewriting retained segments', async () => {
    await database.collection(runSuccessorSegmentsCollectionName).drop();
    await database.createCollection(runSuccessorSegmentsCollectionName, {
      validator: retainedRunSuccessorSegmentValidator,
      validationLevel: 'strict',
      validationAction: 'error',
    });
    const collection = database.collection<RunSuccessorSegmentDocument>(
      runSuccessorSegmentsCollectionName,
    );
    await collection.createIndex(runSuccessorSegmentIndex.key, {
      name: runSuccessorSegmentIndex.name,
      unique: true,
    });
    const original = segment(randomUUID(), randomUUID());
    const document = {
      _id: original.d,
      ownerAid: original.ownerAid,
      runId: original.runId,
      segment: original,
      acceptedAt: new Date(original.admittedAt),
    };
    await collection.insertOne(document);
    await expect(bootstrap.verify()).rejects.toEqual(new RunSuccessorSegmentStorageDrift());
    await bootstrap.allowCalibrationContinuation();
    await bootstrap.allowCalibrationContinuation();
    expect(await collection.findOne({ _id: original.d })).toEqual(document);
    await database.command({
      collMod: runSuccessorSegmentsCollectionName,
      validator: { $jsonSchema: { bsonType: 'object' } },
    });
    await expect(bootstrap.allowCalibrationContinuation()).rejects.toEqual(
      new RunSuccessorSegmentStorageDrift(),
    );
  });
});
