import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify from 'fastify';
import { MongoClient, type Binary } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  prepareEvaluationExecutionProfile,
  prepareEvaluationSourceInventory,
  prepareEvidenceArtifact,
  prepareEvidenceEvent,
  decodeEvidenceArtifact,
  type EvidenceArtifact,
} from '@devrandom/protocol';

import {
  encodeEvidenceArtifactDocument,
  evidenceArtifactDocumentId,
  type EvidenceArtifactDocument,
} from '../../evidence/infrastructure/evidence-artifact-document.js';
import {
  encodeEvidenceEventDocument,
  type EvidenceEventDocument,
} from '../../evidence/infrastructure/evidence-event-document.js';
import { MongoEvidenceReading } from '../../evidence/infrastructure/mongo-evidence-reading.js';
import { evidenceCollectionNames } from '../../evidence/infrastructure/evidence-storage-contract.js';
import { MongoEvaluationPreparations } from '../../evaluation/infrastructure/mongo-evaluation-reservations.js';
import { readExperienceQueryReceipt } from '../application/read-query-receipt.js';
import { retrieveExperience } from '../application/retrieve-experience.js';
import { experienceRoutes } from '../route/experience-routes.js';
import { MongoAtlasExperience, experienceCollectionNames } from './mongo-atlas-experience.js';
import { MongoExperienceQueryReceipts } from './mongo-query-receipt-reading.js';

const atlasUri = process.env.DEVRANDOM_ATLAS_URI;
const describeAtlas = atlasUri === undefined ? describe.skip : describe;
const said = (letter: string): string => `E${letter.repeat(43)}`;
const ownerAid = said('o');
const agentAid = said('a');
const mandateSaid = said('m');
const taskRevisionSaid = said('t');
const harnessSaid = said('h');
const resourceSaid = said('r');
const corpusSaid = said('c');
const taskId = randomUUID();
const runId = randomUUID();
const streamId = randomUUID();
const incumbentId = randomUUID();
const acceptedAt = '2026-09-26T05:00:00.000Z';
const profile = {
  indexName: 'prd03-experience-mechanism-v1',
  modelId: 'fixture-vector-3',
  modelVersion: 'mechanism-only',
  dimensions: 3,
  minimumScore: 0.01,
  maximumEmbeddingChargeMicroUsd: 0,
};
const scope = {
  ownerAid,
  taskId,
  taskRevisionSaid,
  repositoryResourceSaid: resourceSaid,
  allowedCorpusSaid: corpusSaid,
  mandate: { kind: 'AuthorizedExperience' as const, mandateSaid },
};

interface QueryReceiptDocument {
  readonly _id: string;
  readonly ownerAid: string;
  readonly artifact: EvidenceArtifact;
  readonly bytes: Binary;
}

function executionProfile() {
  const prepared = prepareEvaluationExecutionProfile({
    os: 'linux',
    architecture: 'x86_64',
    imageDigest: `sha256:${'1'.repeat(64)}`,
    runtimeDigest: `sha256:${'2'.repeat(64)}`,
    toolchainDigest: `sha256:${'3'.repeat(64)}`,
    sourceGitCommit: '4'.repeat(40),
    sourceGitTree: '5'.repeat(40),
    h1InstructionSaid: said('i'),
    h1RuntimePromptDigest: `sha256:${'6'.repeat(64)}`,
    effectiveLimitsReceiptSaid: said('l'),
    parentDeathCleanupReceiptSaid: said('d'),
    modelProvider: 'fixture',
    modelId: 'fixture',
    thinkingLevel: 'off',
    maximumOutputTokens: 100,
    limits: {
      cpuCount: 1,
      memoryBytes: 128 * 1024 * 1024,
      processCount: 16,
      scratchBytes: 1024,
      outputBytes: 1024,
      wallTimeSeconds: 30,
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
  if (prepared.kind !== 'Prepared') throw new Error('Profile fixture rejected');
  return prepared.profile;
}

describeAtlas('PRD03 server Experience adapter on real Atlas ENN (fixture embedding only)', () => {
  const client = new MongoClient(atlasUri ?? 'mongodb://127.0.0.1:27017', {
    serverSelectionTimeoutMS: 10_000,
    socketTimeoutMS: 30_000,
  });
  const databaseName = `dr_exp_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const database = client.db(databaseName);
  const reading = new MongoEvidenceReading(database);
  const experience = new MongoAtlasExperience(database, {
    profile,
    preparationsDatabase: database,
    reading,
    embedding: {
      embed: () =>
        Promise.resolve({ kind: 'Embedded' as const, vector: [1, 0, 0], chargedMicroUsd: 0 }),
    },
  });
  const queryReceipts = new MongoExperienceQueryReceipts(database, {
    profile,
    reading,
    preparationsDatabase: database,
  });
  let rawArtifactSaid: string;
  let episodeSaid: string;
  let inventorySaid: string;
  let rawBytes: Uint8Array;

  beforeAll(async () => {
    await client.connect();
    rawBytes = new TextEncoder().encode(
      'Prepared history: the legacy receipt parser rejects exit code 101; keep verifier authority separate.',
    );
    const preparedArtifact = prepareEvidenceArtifact(rawBytes, 'text/plain; charset=utf-8');
    if (preparedArtifact.kind !== 'Prepared') throw new Error('Artifact fixture rejected');
    rawArtifactSaid = preparedArtifact.artifact.d;
    const preparedEvent = prepareEvidenceEvent({
      version: 1,
      sequence: 0,
      predecessor: { kind: 'Genesis' },
      taskId,
      taskRevisionSaid,
      runId,
      incarnationId: incumbentId,
      harnessRevisionSaid: harnessSaid,
      personalAgentAid: agentAid,
      taskMandateSaid: mandateSaid,
      occurredAt: acceptedAt,
      recordedAt: acceptedAt,
      producer: { kind: 'RunSupervisor' },
      event: { kind: 'Observation', source: 'Verifier', artifactSaid: rawArtifactSaid },
    });
    if (preparedEvent.kind !== 'Prepared') throw new Error('Episode fixture rejected');
    episodeSaid = preparedEvent.event.d;
    await database.collection<EvidenceEventDocument>(evidenceCollectionNames.events).insertOne(
      encodeEvidenceEventDocument({
        ownerAid,
        evidenceStreamId: streamId,
        batchSaid: said('b'),
        event: preparedEvent.event,
        receivedAt: acceptedAt,
      }),
    );
    await database
      .collection<EvidenceArtifactDocument>(evidenceCollectionNames.artifacts)
      .insertOne(
        encodeEvidenceArtifactDocument({
          ownerAid,
          runId,
          evidenceStreamId: streamId,
          artifact: preparedArtifact.artifact,
          bytes: rawBytes,
          acceptedAt,
        }),
      );
    const preparedInventory = prepareEvaluationSourceInventory({
      taskId,
      taskRevisionSaid,
      ownerAid,
      repositoryResourceSaid: resourceSaid,
      corpusSaid,
      experienceMandateSaid: mandateSaid,
      sources: [
        {
          episodeSaid,
          rawEvidenceSaid: rawArtifactSaid,
          ownerAid,
          repositoryResourceSaid: resourceSaid,
          corpusSaid,
          disclosure: 'AuthorizedAnalogy',
        },
      ],
    });
    if (preparedInventory.kind !== 'Prepared') throw new Error('Inventory fixture rejected');
    inventorySaid = preparedInventory.inventory.d;
    const prepared = await new MongoEvaluationPreparations(database).store({
      ownerAid,
      command: {
        version: 1,
        commandId: randomUUID(),
        fingerprint: `sha256:${'7'.repeat(64)}`,
        taskId,
        taskRevisionSaid,
        sourceInventory: preparedInventory.inventory,
        executionProfile: executionProfile(),
      },
    });
    if (prepared !== 'Prepared') throw new Error(`Preparation fixture ${prepared}`);
    const admitted = await experience.admitSource({
      ownerAid,
      inventory: preparedInventory.inventory,
      episodeSaid,
      rawEvidenceSaid: rawArtifactSaid,
      scope,
    });
    if (admitted !== 'Admitted') throw new Error(`Source fixture ${admitted}`);
    const collision = {
      episodeSaid,
      rawEvidenceSaid: rawArtifactSaid,
      sourceInventorySaid: inventorySaid,
      ownerAid,
      repositoryResourceSaid: resourceSaid,
      corpusSaid,
      disclosure: 'AuthorizedAnalogy',
      embeddingModelId: profile.modelId,
      embeddingModelVersion: profile.modelVersion,
      embedding: [1, 0, 0],
      acceptedAt: new Date(acceptedAt),
    };
    await database
      .collection<{ _id: string; [field: string]: unknown }>(experienceCollectionNames.episodes)
      .insertMany([
        { ...collision, _id: 'foreign-owner', ownerAid: said('x') },
        { ...collision, _id: 'foreign-resource', repositoryResourceSaid: said('x') },
        { ...collision, _id: 'protected-disclosure', disclosure: 'Protected' },
      ]);
    const index = await experience.ensureIndex();
    if (index !== 'Created' && index !== 'Ready') throw new Error(`Index creation ${index}`);
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if ((await experience.ensureIndex()) === 'Ready') return;
      await delay(2_000);
    }
    throw new Error('Experience Atlas index did not become ready with the active definition');
  }, 220_000);

  afterAll(async () => {
    try {
      await database.dropDatabase();
    } finally {
      await client.close();
    }
  });

  it('serves an owner-scoped ENN hit over localhost HTTP and denies it after raw source deletion', async () => {
    const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
    server.register(
      experienceRoutes({
        access: { authorize: () => Promise.resolve({ kind: 'Authorized' as const, ownerAid }) },
        conversation: {
          retrieve: (request) =>
            retrieveExperience(request, {
              scopes: { inspect: () => Promise.resolve({ kind: 'Authorized' as const, scope }) },
              experience,
            }),
          readReceipt: (request) =>
            readExperienceQueryReceipt(request, {
              scopes: { inspect: () => Promise.resolve({ kind: 'Authorized' as const, scope }) },
              receipts: queryReceipts,
            }),
        },
        now: () => new Date().toISOString(),
        newCorrelationId: randomUUID,
      }),
    );
    const address = await server.listen({ host: '127.0.0.1', port: 0 });
    const query = {
      version: 1,
      taskId,
      sourceInventorySaid: inventorySaid,
      corpusSaid,
      failureQuery: 'legacy receipt parser rejected exit code 101',
      maximumResults: 3,
    };
    const fetchQuery = () =>
      fetch(`${address}/api/experience/query`, {
        method: 'POST',
        headers: { authorization: `Bearer ${'a'.repeat(43)}`, 'content-type': 'application/json' },
        body: JSON.stringify(query),
      });
    try {
      let response: Response | undefined;
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        response = await fetchQuery();
        if (response.status === 200) break;
        if (response.status !== 422)
          throw new Error(`Unexpected Atlas HTTP status ${String(response.status)}`);
        await delay(2_000);
      }
      expect(response?.status).toBe(200);
      const body = (await response?.json()) as {
        sources: { episodeSaid: string; rawEvidenceSaid: string; score: number }[];
        queryReceiptSaid: string;
      };
      expect(body.sources).toHaveLength(1);
      expect(body.sources[0]).toMatchObject({ episodeSaid, rawEvidenceSaid: rawArtifactSaid });
      expect(body.sources[0]?.score).toBeTypeOf('number');
      expect(body.queryReceiptSaid).toMatch(/^E[A-Za-z0-9_-]{43}$/);
      const receipt = await database
        .collection<QueryReceiptDocument>(experienceCollectionNames.queryReceipts)
        .findOne({ _id: body.queryReceiptSaid, ownerAid });
      expect(receipt).not.toBeNull();
      if (receipt === null) throw new Error('Missing durable Experience query receipt');
      expect(
        decodeEvidenceArtifact(receipt.artifact, Uint8Array.from(receipt.bytes.buffer)),
      ).toMatchObject({ kind: 'Accepted' });
      const receiptQuery = {
        ownerAid,
        taskId,
        sourceInventorySaid: inventorySaid,
        receiptSaid: body.queryReceiptSaid,
        offset: 0,
        maximumBytes: 32 * 1024,
      };
      const receiptRead = await readExperienceQueryReceipt(receiptQuery, {
        scopes: { inspect: () => Promise.resolve({ kind: 'Authorized' as const, scope }) },
        receipts: queryReceipts,
      });
      expect(receiptRead).toMatchObject({
        kind: 'Read',
        artifact: receipt.artifact,
        totalBytes: receipt.artifact.byteLength,
      });
      if (receiptRead.kind !== 'Read') throw new Error('Exact receipt read denied');
      expect(receiptRead.bytes).toEqual(Uint8Array.from(receipt.bytes.buffer));
      const receiptUrl = `${address}/api/experience/query-receipts/${body.queryReceiptSaid}?taskId=${taskId}&sourceInventorySaid=${inventorySaid}&offset=0&maximumBytes=32768`;
      const fetchReceipt = () =>
        fetch(receiptUrl, { headers: { authorization: `Bearer ${'a'.repeat(43)}` } });
      const exactHttp = await fetchReceipt();
      expect(exactHttp.status).toBe(200);
      expect(await exactHttp.json()).toMatchObject({
        version: 1,
        kind: 'Read',
        artifact: receipt.artifact,
        bytesBase64Url: Buffer.from(receipt.bytes.buffer).toString('base64url'),
      });
      await expect(
        reading.read({
          ownerAid,
          scope,
          query: {
            version: 1,
            taskId,
            sourceInventorySaid: inventorySaid,
            evidenceSaid: rawArtifactSaid,
            offset: 0,
            maximumBytes: 32 * 1024,
          },
        }),
      ).resolves.toMatchObject({ kind: 'Read', bytes: rawBytes, sourceSaid: episodeSaid });
      await database
        .collection<EvidenceArtifactDocument>(evidenceCollectionNames.artifacts)
        .deleteOne({ _id: evidenceArtifactDocumentId(runId, rawArtifactSaid) });
      const afterDeletion = await fetchQuery();
      expect(afterDeletion.status).toBe(403);
      expect(await afterDeletion.json()).toMatchObject({ code: 'ExperienceDenied' });
      const deniedReceipt = await fetchReceipt();
      expect(deniedReceipt.status).toBe(403);
      expect(await deniedReceipt.json()).toMatchObject({ code: 'ExperienceDenied' });
      await expect(
        readExperienceQueryReceipt(receiptQuery, {
          scopes: { inspect: () => Promise.resolve({ kind: 'Authorized' as const, scope }) },
          receipts: queryReceipts,
        }),
      ).resolves.toMatchObject({ kind: 'Denied' });
    } finally {
      await server.close();
    }
  }, 120_000);
});
