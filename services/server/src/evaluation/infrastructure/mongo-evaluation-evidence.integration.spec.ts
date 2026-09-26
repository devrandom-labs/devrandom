import { randomUUID } from 'node:crypto';

import { MongoClient } from 'mongodb';
import { type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  prepareEvaluationClosure,
  prepareEvaluationEvidenceBatch,
  prepareEvaluationEvidenceEvent,
  prepareEvidenceArtifact,
} from '@devrandom/protocol';

import {
  evidenceCollectionNames,
  evidenceUsageDocumentId,
} from '../../evidence/infrastructure/evidence-storage-contract.js';
import { acceptEvaluationEvidence } from '../application/accept-evaluation-evidence.js';
import { renewHostedEvaluationLease } from '../application/renew-evaluation-lease.js';
import { evaluationRoutes } from '../route/evaluation-routes.js';
import {
  evaluationCollectionNames,
  MongoEvaluationReservations,
  type EvaluationDocument,
} from './mongo-evaluation-reservations.js';
import { evaluationEvidenceIndexes, MongoEvaluationEvidence } from './mongo-evaluation-evidence.js';
import { MongoEvaluationBootstrap } from './mongo-evaluation-bootstrap.js';

const mongoUri = process.env.DEVRANDOM_MONGODB_URI;
const describeWithMongo = mongoUri === undefined ? describe.skip : describe;
const said = (letter: string): string => `E${letter.repeat(43)}`;
const ownerAid = said('o');
const taskId = randomUUID();
const originRunId = randomUUID();
const evaluationId = randomUUID();
const streamId = randomUUID();
const budget = {
  providerRequests: 2,
  providerInputTokens: 100,
  providerOutputTokens: 100,
  providerSpendMicroUsd: 100,
  runWallTimeSeconds: 100,
  toolProposals: 100,
  aggregateChildCommandTimeSeconds: 100,
  changedFiles: 100,
  changedWorktreeBytes: 100,
  evidencePlusArtifactsPerRunBytes: 64 * 1024,
};

function event(
  sequence: number,
  previous: { kind: 'Genesis' } | { kind: 'Previous'; eventSaid: string },
  detail:
    | {
        kind: 'UsageDebited';
        providerRequests: number;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        spendMicroUsd: number;
        elapsedMilliseconds: number;
      }
    | { kind: 'ModelExchange'; rawArtifactSaid: string },
) {
  const prepared = prepareEvaluationEvidenceEvent({
    evaluationId,
    streamId,
    originRunId,
    taskId,
    taskRevisionSaid: said('t'),
    personalAgentAid: said('a'),
    taskMandateSaid: said('m'),
    harnessRevisionSaid: said('h'),
    phase: { kind: 'Research', policySaid: said('p'), role: 'DiagnosticRefiner' },
    sequence,
    previous,
    occurredAt: '2026-09-26T04:00:00.000Z',
    detail,
  });
  if (prepared.kind !== 'Prepared') throw new Error(prepared.reason);
  return prepared.event;
}

function upload(events: ReturnType<typeof event>[]) {
  const prepared = prepareEvaluationEvidenceBatch(events);
  if (prepared.kind !== 'Prepared') throw new Error(prepared.reason);
  return {
    version: 1 as const,
    commandId: randomUUID(),
    fingerprint: `sha256:${'a'.repeat(64)}`,
    batch: prepared.batch,
    events,
    publicArtifacts: [],
    protectedArtifacts: [],
  };
}

describeWithMongo('Mongo native Evaluation evidence boundary', () => {
  const client = new MongoClient(mongoUri ?? 'mongodb://127.0.0.1:27017');
  const database = client.db(`devrandom_evaluation_${randomUUID().replaceAll('-', '')}`);
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  let repository: MongoEvaluationEvidence;
  let address: string;

  beforeAll(async () => {
    await client.connect();
    await new MongoEvaluationBootstrap(database).bootstrap();
    await database
      .collection<{ _id: string; version: number; acceptedBytes: number }>(
        evidenceCollectionNames.usage,
      )
      .insertOne({
        _id: evidenceUsageDocumentId,
        version: 0,
        acceptedBytes: 0,
      });
    expect(evaluationEvidenceIndexes()).toHaveLength(3);
    const now = new Date();
    const record: EvaluationDocument = {
      _id: evaluationId,
      ownerAid,
      command: {
        version: 1,
        commandId: randomUUID(),
        fingerprint: `sha256:${'a'.repeat(64)}`,
        taskId,
        taskRevisionSaid: said('t'),
        originRunId,
        retainedCheckpointSaid: said('c'),
        retainedSealSaid: said('s'),
        expectedActiveRevisionSaid: said('h'),
        personalAgentAid: said('a'),
        taskMandateSaid: said('m'),
        policySaid: said('p'),
        executionProfileSaid: said('e'),
        sourceInventorySaid: said('i'),
        allocation: { diagnosis: budget, perEntry: budget, finalization: budget },
      },
      reserved: budget,
      reservationSaid: said('r'),
      evidenceStreamId: streamId,
      version: 1,
      lease: {
        evaluationId,
        leaseId: randomUUID(),
        version: 1,
        serverTime: now.toISOString(),
        expiresAt: new Date(now.valueOf() + 45000).toISOString(),
      },
      acceptedThroughSequence: -1,
      chainHeadSaid: null,
      acceptedBytes: 0,
      activeOwnerSlot: ownerAid,
      acceptedAt: now,
    };
    await database
      .collection<EvaluationDocument>(evaluationCollectionNames.evaluations)
      .insertOne(record);
    repository = new MongoEvaluationEvidence(client, database);
    const reservations = new MongoEvaluationReservations(client, database);
    server.register(
      evaluationRoutes({
        access: { authorize: () => Promise.resolve({ kind: 'Authorized', ownerAid }) },
        preparation: { prepare: () => Promise.resolve('Unavailable') },
        admission: { admit: () => Promise.resolve({ kind: 'Unavailable' }) },
        leases: {
          renew: (input) =>
            renewHostedEvaluationLease(input, {
              authority: { inspect: () => Promise.resolve({ kind: 'Authorized' }) },
              leases: reservations,
            }),
        },
        evidence: {
          accept: (input) => acceptEvaluationEvidence(input, { batches: repository }),
          close: (input) => repository.close(input),
        },
        now: () => new Date().toISOString(),
        newCorrelationId: randomUUID,
      }),
    );
    address = await server.listen({ host: '127.0.0.1', port: 0 });
  });

  afterAll(async () => {
    await server.close();
    await database.dropDatabase();
    await client.close();
  });

  it('accepts one ordered batch, reconciles exact retry and rejects a gap without writes', async () => {
    const first = event(
      0,
      { kind: 'Genesis' },
      {
        kind: 'UsageDebited',
        providerRequests: 1,
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        spendMicroUsd: 1,
        elapsedMilliseconds: 1,
      },
    );
    const firstUpload = upload([first]);
    const endpoint = `${address}/api/evaluations/${evaluationId}/batches`;
    const headers = {
      authorization: `Bearer ${'a'.repeat(43)}`,
      'content-type': 'application/json',
    };
    const accepted = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(firstUpload),
    });
    expect(accepted.status).toBe(201);
    expect(((await accepted.json()) as { disposition: string }).disposition).toBe('Accepted');
    expect(
      await repository.accept({
        ownerAid,
        upload: {
          ...firstUpload,
          batch: {
            ...firstUpload.batch,
            encodedByteCount: firstUpload.batch.encodedByteCount + 1,
          },
        },
      }),
    ).toEqual({ kind: 'Rejected', reason: 'InvalidBatch' });
    const replay = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(firstUpload),
    });
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { disposition: string }).disposition).toBe('AlreadyAccepted');
    expect(
      (
        await acceptEvaluationEvidence(
          { ownerAid: said('x'), upload: firstUpload },
          { batches: repository },
        )
      ).kind,
    ).toBe('Conflict');
    const skipped = event(
      2,
      { kind: 'Previous', eventSaid: first.d },
      {
        kind: 'UsageDebited',
        providerRequests: 1,
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        spendMicroUsd: 1,
        elapsedMilliseconds: 1,
      },
    );
    const gap = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(upload([skipped])),
    });
    expect(gap.status).toBe(409);
    expect(await database.collection(evaluationCollectionNames.events).countDocuments()).toBe(1);
    expect(await database.collection(evaluationCollectionNames.batches).countDocuments()).toBe(1);
  });

  it('rolls back missing raw bytes and rejects incomplete evidence-only closure', async () => {
    const state = await database
      .collection<EvaluationDocument>(evaluationCollectionNames.evaluations)
      .findOne({ _id: evaluationId });
    if (state?.chainHeadSaid === null || state?.chainHeadSaid === undefined)
      throw new Error('missing first batch');
    const second = event(
      1,
      { kind: 'Previous', eventSaid: state.chainHeadSaid },
      {
        kind: 'ModelExchange',
        rawArtifactSaid: said('z'),
      },
    );
    expect(
      (
        await acceptEvaluationEvidence(
          { ownerAid, upload: upload([second]) },
          { batches: repository },
        )
      ).kind,
    ).toBe('Rejected');
    expect(await database.collection(evaluationCollectionNames.events).countDocuments()).toBe(1);
    const closure = prepareEvaluationClosure({
      evaluationId,
      evidenceStreamId: streamId,
      originRunId,
      manifestSaid: said('M'),
      acceptedEventCount: 1,
      acceptedHeadSaid: state.chainHeadSaid,
      observationSaids: Array.from({ length: 18 }, (_, index) =>
        said(String.fromCharCode(65 + index)),
      ),
      measurementSaids: Array.from({ length: 15 }, (_, index) =>
        said(String.fromCharCode(97 + index)),
      ),
      sharedAuditSaid: said('u'),
      armAuditSaids: {
        H1: said('1'),
        C1: said('2'),
        C2: said('3'),
        C3: said('4'),
        H1TaskSearch: said('5'),
      },
      protectedCustodySaid: said('q'),
      agentSealSaid: said('g'),
    });
    if (closure.kind !== 'Prepared') throw new Error(closure.reason);
    expect(
      (
        await repository.close({
          ownerAid,
          expectedEvaluationVersion: state.version,
          closure: closure.closure,
        })
      ).kind,
    ).toBe('Incomplete');
    expect(
      (
        await database
          .collection<EvaluationDocument>(evaluationCollectionNames.evaluations)
          .findOne({ _id: evaluationId })
      )?.closure,
    ).toBeUndefined();
    const rawBytes = new TextEncoder().encode('{"observation":"legacy rejected"}');
    const artifact = prepareEvidenceArtifact(rawBytes, 'application/json');
    if (artifact.kind !== 'Prepared') throw new Error(artifact.reason);
    const complete = event(
      1,
      { kind: 'Previous', eventSaid: state.chainHeadSaid },
      {
        kind: 'ModelExchange',
        rawArtifactSaid: artifact.artifact.d,
      },
    );
    const completeUpload = {
      ...upload([complete]),
      publicArtifacts: [
        {
          artifact: artifact.artifact,
          bytesBase64Url: Buffer.from(rawBytes).toString('base64url'),
        },
      ],
    };
    const endpoint = `${address}/api/evaluations/${evaluationId}/batches`;
    const accepted = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${'a'.repeat(43)}`, 'content-type': 'application/json' },
      body: JSON.stringify(completeUpload),
    });
    expect(accepted.status).toBe(201);
    expect(
      await database
        .collection(evaluationCollectionNames.artifacts)
        .countDocuments({ 'artifact.d': artifact.artifact.d }),
    ).toBe(1);
  });

  it('renews only the current lease and reconciles one exact command across a lost reply', async () => {
    const evaluations = database.collection<EvaluationDocument>(
      evaluationCollectionNames.evaluations,
    );
    const state = await evaluations.findOne({ _id: evaluationId });
    if (state === null) throw new Error('evaluation missing');
    const now = Date.now();
    await evaluations.updateOne(
      { _id: evaluationId },
      {
        $set: {
          lease: {
            ...state.lease,
            serverTime: new Date(now - 35_000).toISOString(),
            expiresAt: new Date(now + 10_000).toISOString(),
          },
        },
      },
    );
    const command = {
      version: 1,
      commandId: randomUUID(),
      fingerprint: `sha256:${'f'.repeat(64)}`,
      evaluationId,
      leaseId: state.lease.leaseId,
      expectedEvaluationVersion: state.version,
    };
    const endpoint = `${address}/api/evaluations/${evaluationId}/lease`;
    const headers = {
      authorization: `Bearer ${'a'.repeat(43)}`,
      'content-type': 'application/json',
    };
    const renewed = await fetch(endpoint, {
      method: 'PUT',
      headers,
      body: JSON.stringify(command),
    });
    expect(renewed.status).toBe(200);
    expect(((await renewed.json()) as { kind: string }).kind).toBe('Renewed');
    const replay = await fetch(endpoint, { method: 'PUT', headers, body: JSON.stringify(command) });
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { kind: string }).kind).toBe('AlreadyRenewed');
    expect(await database.collection(evaluationCollectionNames.renewals).countDocuments()).toBe(1);
    expect((await evaluations.findOne({ _id: evaluationId }))?.version).toBe(state.version + 1);
    const stale = await fetch(endpoint, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ ...command, commandId: randomUUID() }),
    });
    expect(stale.status).toBe(409);
  });

  it('reads a prior reservation by exact owner and command before any new allocation', async () => {
    const existing = await database
      .collection<EvaluationDocument>(evaluationCollectionNames.evaluations)
      .findOne({ _id: evaluationId });
    if (existing === null) throw new Error('evaluation fixture missing');
    const reservations = new MongoEvaluationReservations(client, database);
    expect(await reservations.reconcile({ ownerAid, command: existing.command })).toMatchObject({
      kind: 'Admitted',
      evaluationId,
      evidenceStreamId: existing.evidenceStreamId,
      reservationSaid: existing.reservationSaid,
    });
    expect(
      await reservations.reconcile({
        ownerAid,
        command: { ...existing.command, fingerprint: `sha256:${'b'.repeat(64)}` },
      }),
    ).toEqual({ kind: 'Conflict' });
    expect(
      await reservations.reconcile({ ownerAid: said('z'), command: existing.command }),
    ).toEqual({ kind: 'NotFound' });
  });
});
