import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify from 'fastify';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prepareEvaluationEvidenceEvent, prepareEvidenceArtifact } from '@devrandom/protocol';

import { ServerEvaluationHttp } from '../../../../../apps/cli/src/harness/infrastructure/server-evaluation-http.js';
import { SqliteEvaluationEvidenceOutbox } from '../../../../../apps/cli/src/harness/infrastructure/sqlite-evaluation-evidence-outbox.js';
import { decodeDevrandomServerOrigin } from '../../../../../apps/cli/src/infrastructure/devrandom-server-http.js';
import { acceptEvaluationEvidence } from '../application/accept-evaluation-evidence.js';
import { MongoEvaluationBootstrap } from '../infrastructure/mongo-evaluation-bootstrap.js';
import { MongoEvaluationEvidence } from '../infrastructure/mongo-evaluation-evidence.js';
import {
  evaluationCollectionNames,
  type EvaluationDocument,
} from '../infrastructure/mongo-evaluation-reservations.js';
import { evaluationRoutes } from '../route/evaluation-routes.js';
import {
  evidenceCollectionNames,
  evidenceUsageDocumentId,
} from '../../evidence/infrastructure/evidence-storage-contract.js';

const mongoUri = process.env.DEVRANDOM_MONGODB_URI;
const describeMongo = mongoUri === undefined ? describe.skip : describe;
const said = (letter: string): string => `E${letter.repeat(43)}`;
const ownerAid = said('o');
const evaluationId = randomUUID();
const streamId = randomUUID();
const originRunId = randomUUID();
const taskId = randomUUID();
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

describeMongo('CLI Evaluation outbox through listening Fastify and replica Mongo', () => {
  const client = new MongoClient(mongoUri ?? 'mongodb://127.0.0.1:27017');
  const database = client.db(`devrandom_transport_${randomUUID().replaceAll('-', '')}`);
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  let stateRoot: string;
  let address: string;

  beforeAll(async () => {
    stateRoot = mkdtempSync(join(tmpdir(), 'devrandom-evaluation-transport-'));
    await client.connect();
    await new MongoEvaluationBootstrap(database).bootstrap();
    await database
      .collection<{ _id: string; version: number; acceptedBytes: number }>(
        evidenceCollectionNames.usage,
      )
      .insertOne({ _id: evidenceUsageDocumentId, version: 0, acceptedBytes: 0 });
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
    const batches = new MongoEvaluationEvidence(client, database);
    server.register(
      evaluationRoutes({
        access: {
          authorize: ({ bearerSecret }) =>
            Promise.resolve(
              bearerSecret === 'b'.repeat(43)
                ? { kind: 'Authorized' as const, ownerAid }
                : bearerSecret === 'c'.repeat(43)
                  ? { kind: 'Authorized' as const, ownerAid: said('x') }
                  : { kind: 'Denied' as const },
            ),
        },
        preparation: { prepare: () => Promise.resolve('Unavailable') },
        admission: { admit: () => Promise.resolve({ kind: 'Unavailable' }) },
        manifest: {
          lock: () => Promise.resolve({ kind: 'Unavailable' }),
          inspect: () => Promise.resolve({ kind: 'Unavailable' }),
        },
        leases: { renew: () => Promise.resolve({ kind: 'Unavailable' }) },
        evidence: {
          accept: (input) => acceptEvaluationEvidence(input, { batches }),
          close: () => Promise.resolve({ kind: 'Unavailable' }),
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
    rmSync(stateRoot, { recursive: true, force: true });
  });

  it('recovers a lost reply and acknowledges only the exact owner-scoped committed batch', async () => {
    const opened = SqliteEvaluationEvidenceOutbox.open(stateRoot, {
      ownerAid,
      evaluationId,
      streamId,
      originRunId,
      taskId,
      taskRevisionSaid: said('t'),
      personalAgentAid: said('a'),
      taskMandateSaid: said('m'),
    });
    if (opened.kind !== 'Opened') throw new Error(opened.kind);
    const bytes = new TextEncoder().encode('actual raw model response');
    const artifact = prepareEvidenceArtifact(bytes, 'text/plain; charset=utf-8');
    if (artifact.kind !== 'Prepared') throw new Error(artifact.reason);
    const event = prepareEvaluationEvidenceEvent({
      evaluationId,
      streamId,
      originRunId,
      taskId,
      taskRevisionSaid: said('t'),
      personalAgentAid: said('a'),
      taskMandateSaid: said('m'),
      harnessRevisionSaid: said('h'),
      phase: { kind: 'Research', policySaid: said('p'), role: 'DiagnosticRefiner' },
      sequence: 0,
      previous: { kind: 'Genesis' },
      occurredAt: '2026-09-26T05:00:00.000Z',
      detail: { kind: 'ModelExchange', rawArtifactSaid: artifact.artifact.d },
    });
    if (event.kind !== 'Prepared') throw new Error(event.reason);
    expect(
      opened.outbox.stage({
        commandId: randomUUID(),
        fingerprint: `sha256:${'f'.repeat(64)}`,
        events: [event.event],
        publicArtifacts: [{ artifact: artifact.artifact, bytes }],
        protectedArtifacts: [],
      }).kind,
    ).toBe('Staged');
    const secondEvent = prepareEvaluationEvidenceEvent({
      evaluationId,
      streamId,
      originRunId,
      taskId,
      taskRevisionSaid: said('t'),
      personalAgentAid: said('a'),
      taskMandateSaid: said('m'),
      harnessRevisionSaid: said('h'),
      phase: { kind: 'Research', policySaid: said('p'), role: 'DiagnosticRefiner' },
      sequence: 1,
      previous: { kind: 'Previous', eventSaid: event.event.d },
      occurredAt: '2026-09-26T05:00:01.000Z',
      detail: { kind: 'ModelExchange', rawArtifactSaid: artifact.artifact.d },
    });
    if (secondEvent.kind !== 'Prepared') throw new Error(secondEvent.reason);
    expect(
      opened.outbox.stage({
        commandId: randomUUID(),
        fingerprint: `sha256:${'e'.repeat(64)}`,
        events: [secondEvent.event],
        publicArtifacts: [],
        protectedArtifacts: [],
      }).kind,
    ).toBe('Staged');
    const pending = opened.outbox.pending();
    if (pending.kind !== 'Pending') throw new Error(pending.kind);
    const origin = decodeDevrandomServerOrigin(address);
    if (origin.kind !== 'Accepted') throw new Error(origin.kind);
    let loseFirstReply = true;
    const http = new ServerEvaluationHttp(origin.origin, 'b'.repeat(43), async (url, init) => {
      const response = await fetch(url, init);
      if (loseFirstReply) {
        loseFirstReply = false;
        throw new Error('simulated response loss after server commit');
      }
      return response;
    });
    expect(await http.appendEvidence(pending.upload)).toEqual({ kind: 'Unavailable' });
    expect(await database.collection(evaluationCollectionNames.batches).countDocuments()).toBe(1);
    opened.outbox.close();

    const reopened = SqliteEvaluationEvidenceOutbox.open(stateRoot, {
      ownerAid,
      evaluationId,
      streamId,
      originRunId,
      taskId,
      taskRevisionSaid: said('t'),
      personalAgentAid: said('a'),
      taskMandateSaid: said('m'),
    });
    if (reopened.kind !== 'Opened') throw new Error(reopened.kind);
    const restored = reopened.outbox.pending();
    expect(restored).toEqual(pending);
    if (restored.kind !== 'Pending') throw new Error(restored.kind);
    const retry = await http.appendEvidence(restored.upload);
    expect(retry.kind).toBe('Acknowledged');
    if (retry.kind !== 'Acknowledged') throw new Error(retry.kind);
    expect(retry.acknowledgement.disposition).toBe('AlreadyAccepted');
    expect(
      reopened.outbox.acknowledge({
        ...retry.acknowledgement,
        chainHeadSaid: said('f'),
      }),
    ).toEqual({ kind: 'Conflict' });
    expect(reopened.outbox.acknowledge(retry.acknowledgement)).toEqual({ kind: 'Recorded' });
    const pendingSecond = reopened.outbox.pending();
    if (pendingSecond.kind !== 'Pending') throw new Error(pendingSecond.kind);
    expect(pendingSecond.upload.batch.startingSequence).toBe(1);
    const secondDelivery = await http.appendEvidence(pendingSecond.upload);
    expect(secondDelivery.kind).toBe('Acknowledged');
    if (secondDelivery.kind !== 'Acknowledged') throw new Error(secondDelivery.kind);
    expect(secondDelivery.acknowledgement.disposition).toBe('Accepted');
    expect(reopened.outbox.acknowledge(secondDelivery.acknowledgement)).toEqual({
      kind: 'Recorded',
    });
    expect(reopened.outbox.pending()).toEqual({ kind: 'Empty' });

    const otherOwner = new ServerEvaluationHttp(origin.origin, 'c'.repeat(43), fetch);
    expect(await otherOwner.appendEvidence(restored.upload)).toEqual({ kind: 'Conflict' });
    expect(await database.collection(evaluationCollectionNames.batches).countDocuments()).toBe(2);
    reopened.outbox.close();
  });
});
