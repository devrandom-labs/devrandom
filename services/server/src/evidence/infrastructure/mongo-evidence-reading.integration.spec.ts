import { randomUUID } from 'node:crypto';

import { type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify from 'fastify';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  prepareEvaluationExecutionProfile,
  prepareEvaluationSourceInventory,
  prepareEvidenceArtifact,
  prepareEvidenceEvent,
} from '@devrandom/protocol';

import { readEvidence } from '../application/read-evidence.js';
import { evidenceReadRoutes } from '../route/evidence-read-routes.js';
import {
  encodeEvidenceArtifactDocument,
  type EvidenceArtifactDocument,
} from './evidence-artifact-document.js';
import {
  encodeEvidenceEventDocument,
  type EvidenceEventDocument,
} from './evidence-event-document.js';
import { evidenceCollectionNames } from './evidence-storage-contract.js';
import { MongoEvidenceReading } from './mongo-evidence-reading.js';
import { MongoEvaluationPreparations } from '../../evaluation/infrastructure/mongo-evaluation-reservations.js';
import { MongoEvaluationBootstrap } from '../../evaluation/infrastructure/mongo-evaluation-bootstrap.js';

const uri = process.env.DEVRANDOM_MONGODB_URI;
const describeMongo = uri === undefined ? describe.skip : describe;
const said = (letter: string): string => `E${letter.repeat(43)}`;
const ownerAid = said('o');
const taskId = randomUUID();
const runId = randomUUID();
const streamId = randomUUID();
const repositoryResourceSaid = said('r');
const corpusSaid = said('c');
const experienceMandateSaid = said('m');
const taskRevisionSaid = said('t');
const rawBytes = new TextEncoder().encode('Legacy receipt fails after frame version changed.');

describeMongo('listening exact raw evidence boundary', () => {
  const client = new MongoClient(uri ?? 'mongodb://127.0.0.1:27017');
  const database = client.db(`devrandom_evidence_read_${randomUUID().replaceAll('-', '')}`);
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  let address: string;
  let rawSaid: string;
  let inventorySaid: string;
  let activeOwner = ownerAid;

  beforeAll(async () => {
    await client.connect();
    await new MongoEvaluationBootstrap(database).bootstrap();
    const artifact = prepareEvidenceArtifact(rawBytes, 'text/plain; charset=utf-8');
    if (artifact.kind !== 'Prepared') throw new Error(artifact.reason);
    rawSaid = artifact.artifact.d;
    const observed = prepareEvidenceEvent({
      version: 1,
      sequence: 0,
      predecessor: { kind: 'Genesis' },
      taskId: randomUUID(),
      taskRevisionSaid: said('x'),
      runId,
      incarnationId: randomUUID(),
      harnessRevisionSaid: said('h'),
      personalAgentAid: said('a'),
      taskMandateSaid: said('b'),
      occurredAt: '2026-09-26T04:00:00.000Z',
      recordedAt: '2026-09-26T04:00:00.000Z',
      producer: { kind: 'RunSupervisor' },
      event: { kind: 'Observation', source: 'Verifier', artifactSaid: rawSaid },
    });
    if (observed.kind !== 'Prepared') throw new Error(observed.reason);
    await database.collection<EvidenceEventDocument>(evidenceCollectionNames.events).insertOne(
      encodeEvidenceEventDocument({
        ownerAid,
        evidenceStreamId: streamId,
        batchSaid: said('q'),
        event: observed.event,
        receivedAt: '2026-09-26T04:00:01.000Z',
      }),
    );
    await database
      .collection<EvidenceArtifactDocument>(evidenceCollectionNames.artifacts)
      .insertOne(
        encodeEvidenceArtifactDocument({
          ownerAid,
          runId,
          evidenceStreamId: streamId,
          artifact: artifact.artifact,
          bytes: rawBytes,
          acceptedAt: '2026-09-26T04:00:01.000Z',
        }),
      );
    const inventory = prepareEvaluationSourceInventory({
      taskId,
      taskRevisionSaid,
      ownerAid,
      repositoryResourceSaid,
      corpusSaid,
      experienceMandateSaid,
      sources: [
        {
          episodeSaid: observed.event.d,
          rawEvidenceSaid: rawSaid,
          ownerAid,
          repositoryResourceSaid,
          corpusSaid,
          disclosure: 'AuthorizedAnalogy',
        },
      ],
    });
    if (inventory.kind !== 'Prepared') throw new Error(inventory.reason);
    inventorySaid = inventory.inventory.d;
    const profile = prepareEvaluationExecutionProfile({
      os: 'linux',
      architecture: 'x86_64',
      imageDigest: `sha256:${'1'.repeat(64)}`,
      runtimeDigest: `sha256:${'2'.repeat(64)}`,
      toolchainDigest: `sha256:${'3'.repeat(64)}`,
      sourceGitCommit: 'a'.repeat(40),
      sourceGitTree: 'b'.repeat(40),
      h1InstructionSaid: said('i'),
      h1RuntimePromptDigest: `sha256:${'4'.repeat(64)}`,
      effectiveLimitsReceiptSaid: said('l'),
      parentDeathCleanupReceiptSaid: said('p'),
      modelProvider: 'test',
      modelId: 'test',
      thinkingLevel: 'off',
      maximumOutputTokens: 100,
      limits: {
        cpuCount: 1,
        memoryBytes: 128 * 1024 * 1024,
        processCount: 16,
        scratchBytes: 1024 * 1024,
        outputBytes: 1024,
        wallTimeSeconds: 45,
      },
      containment: {
        nonRoot: true,
        readOnlyRuntime: true,
        networkDisabled: true,
        privilegesDropped: true,
        restrictedIpc: true,
        parentDeathCleanup: true,
      },
    });
    if (profile.kind !== 'Prepared') throw new Error(profile.reason);
    const preparer = new MongoEvaluationPreparations(database);
    expect(
      await preparer.store({
        ownerAid,
        command: {
          version: 1,
          commandId: randomUUID(),
          fingerprint: `sha256:${'f'.repeat(64)}`,
          taskId,
          taskRevisionSaid,
          sourceInventory: inventory.inventory,
          executionProfile: profile.profile,
        },
      }),
    ).toBe('Prepared');
    const reading = new MongoEvidenceReading(database);
    const scope = {
      ownerAid,
      taskId,
      taskRevisionSaid,
      repositoryResourceSaid,
      allowedCorpusSaid: corpusSaid,
      mandate: { kind: 'AuthorizedExperience' as const, mandateSaid: experienceMandateSaid },
    };
    server.register(
      evidenceReadRoutes({
        access: { authorize: () => Promise.resolve({ kind: 'Authorized', ownerAid: activeOwner }) },
        conversation: {
          read: (input) =>
            readEvidence(input, {
              scope: { inspect: () => Promise.resolve({ kind: 'Authorized', scope }) },
              reading,
            }),
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

  it('returns only authorized exact bytes and denies cross-owner reads', async () => {
    const endpoint = `${address}/api/evidence/read`;
    const headers = {
      authorization: `Bearer ${'a'.repeat(43)}`,
      'content-type': 'application/json',
    };
    const query = {
      version: 1,
      taskId,
      sourceInventorySaid: inventorySaid,
      evidenceSaid: rawSaid,
      offset: 7,
      maximumBytes: 7,
    };
    const accepted = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(query),
    });
    expect(accepted.status).toBe(200);
    const body = (await accepted.json()) as {
      bytesBase64Url: string;
      totalBytes: number;
      sourceSaid: string;
      readReceiptSaid: string;
    };
    expect(Buffer.from(body.bytesBase64Url, 'base64url').toString('utf8')).toBe('receipt');
    expect(body.totalBytes).toBe(rawBytes.byteLength);
    expect(body.readReceiptSaid).toMatch(/^E[A-Za-z0-9_-]{43}$/u);
    activeOwner = said('z');
    const crossOwner = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(query),
    });
    expect(crossOwner.status).toBe(403);
    activeOwner = ownerAid;
    const forbiddenQuery = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...query, filter: {} }),
    });
    expect(forbiddenQuery.status).toBe(400);
  });
});
