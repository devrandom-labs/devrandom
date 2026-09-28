import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify from 'fastify';
import { MongoClient } from 'mongodb';
import { expect, it } from 'vitest';

import {
  prepareEvaluationExecutionProfile,
  prepareEvaluationSourceInventory,
  prepareEvidenceArtifact,
  prepareEvidenceEvent,
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
import { evidenceCollectionNames } from '../../evidence/infrastructure/evidence-storage-contract.js';
import { MongoEvaluationPreparations } from '../../evaluation/infrastructure/mongo-evaluation-reservations.js';
import { readExperienceQueryReceipt } from '../application/read-query-receipt.js';
import { retrieveExperience } from '../application/retrieve-experience.js';
import { experienceCollectionNames } from '../infrastructure/mongo-atlas-experience.js';
import { pinnedAtlasExperienceProfile } from '../infrastructure/huggingface-experience-embedding.js';
import { experienceRoutes } from '../route/experience-routes.js';
import { openServerAtlasExperience } from './server-atlas-experience.js';

const realServers =
  process.env.DEVRANDOM_ATLAS_COMPOSITION_TEST === '1' &&
  process.env.DEVRANDOM_ATLAS_URI !== undefined &&
  process.env.DEVRANDOM_MONGODB_URI !== undefined
    ? it
    : it.skip;
const said = (letter: string): string => `E${letter.repeat(43)}`;

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

realServers(
  'serves semantic Experience over HTTP from Atlas using separate hosted preparation and raw-evidence custody',
  async () => {
    const atlasUri = process.env.DEVRANDOM_ATLAS_URI ?? '';
    const hostedUri = process.env.DEVRANDOM_MONGODB_URI ?? '';
    const hostedClient = new MongoClient(hostedUri, { serverSelectionTimeoutMS: 10_000 });
    const atlasInspector = new MongoClient(atlasUri, { serverSelectionTimeoutMS: 10_000 });
    const hostedName = `dr_exph_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const atlasName = `dr_expa_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const hosted = hostedClient.db(hostedName);
    const atlas = atlasInspector.db(atlasName);
    const cacheDirectory = join(tmpdir(), `devrandom-server-atlas-${randomUUID()}`);
    const ownerAid = said('o');
    const taskId = randomUUID();
    const taskRevisionSaid = said('t');
    const mandateSaid = said('m');
    const resourceSaid = said('r');
    const corpusSaid = said('c');
    const runId = randomUUID();
    const streamId = randomUUID();
    const acceptedAt = '2026-09-26T05:00:00.000Z';
    const scope = {
      ownerAid,
      taskId,
      taskRevisionSaid,
      repositoryResourceSaid: resourceSaid,
      allowedCorpusSaid: corpusSaid,
      mandate: { kind: 'AuthorizedExperience' as const, mandateSaid },
    };
    let opened: Awaited<ReturnType<typeof openServerAtlasExperience>> | undefined;
    let closeServer: (() => Promise<void>) | undefined;
    try {
      await Promise.all([hostedClient.connect(), atlasInspector.connect()]);
      const bytes = new TextEncoder().encode(
        'Prepared history: the legacy receipt parser rejects exit code 101; keep verifier authority separate.',
      );
      const artifact = prepareEvidenceArtifact(bytes, 'text/plain; charset=utf-8');
      if (artifact.kind !== 'Prepared') throw new Error('Raw fixture rejected');
      const event = prepareEvidenceEvent({
        version: 1,
        sequence: 0,
        predecessor: { kind: 'Genesis' },
        taskId,
        taskRevisionSaid,
        runId,
        incarnationId: randomUUID(),
        harnessRevisionSaid: said('h'),
        personalAgentAid: said('a'),
        taskMandateSaid: mandateSaid,
        occurredAt: acceptedAt,
        recordedAt: acceptedAt,
        producer: { kind: 'RunSupervisor' },
        event: { kind: 'Observation', source: 'Verifier', artifactSaid: artifact.artifact.d },
      });
      if (event.kind !== 'Prepared') throw new Error('Event fixture rejected');
      await hosted.collection<EvidenceEventDocument>(evidenceCollectionNames.events).insertOne(
        encodeEvidenceEventDocument({
          ownerAid,
          evidenceStreamId: streamId,
          batchSaid: said('b'),
          event: event.event,
          receivedAt: acceptedAt,
        }),
      );
      await hosted
        .collection<EvidenceArtifactDocument>(evidenceCollectionNames.artifacts)
        .insertOne(
          encodeEvidenceArtifactDocument({
            ownerAid,
            runId,
            evidenceStreamId: streamId,
            artifact: artifact.artifact,
            bytes,
            acceptedAt,
          }),
        );
      const source = prepareEvaluationSourceInventory({
        taskId,
        taskRevisionSaid,
        ownerAid,
        repositoryResourceSaid: resourceSaid,
        corpusSaid,
        experienceMandateSaid: mandateSaid,
        sources: [
          {
            episodeSaid: event.event.d,
            rawEvidenceSaid: artifact.artifact.d,
            ownerAid,
            repositoryResourceSaid: resourceSaid,
            corpusSaid,
            disclosure: 'AuthorizedAnalogy',
          },
        ],
      });
      if (source.kind !== 'Prepared') throw new Error('Source fixture rejected');
      expect(
        await new MongoEvaluationPreparations(hosted).store({
          ownerAid,
          command: {
            version: 1,
            commandId: randomUUID(),
            fingerprint: `sha256:${'7'.repeat(64)}`,
            taskId,
            taskRevisionSaid,
            sourceInventory: source.inventory,
            executionProfile: executionProfile(),
          },
        }),
      ).toBe('Prepared');
      opened = await openServerAtlasExperience(
        {
          kind: 'Configured',
          deployment: process.env.DEVRANDOM_ATLAS_LOCAL_TEST === '1' ? 'AtlasLocal' : 'Cloud',
          mongodbUri: atlasUri,
          databaseName: atlasName,
          modelCacheDirectory: cacheDirectory,
        },
        hosted,
      );
      if (opened.kind !== 'Available')
        throw new Error(`Atlas composition unavailable at ${opened.reason}`);
      const available = opened;
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        try {
          await opened.verify();
          break;
        } catch {
          await delay(2_000);
        }
      }
      await opened.verify();
      expect(
        await opened.sources.admitSource({
          ownerAid,
          inventory: source.inventory,
          episodeSaid: event.event.d,
          rawEvidenceSaid: artifact.artifact.d,
          scope,
        }),
      ).toBe('Admitted');
      expect(await hosted.collection(experienceCollectionNames.episodes).countDocuments()).toBe(0);
      expect(await atlas.collection(experienceCollectionNames.episodes).countDocuments()).toBe(1);

      const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
      closeServer = () => server.close();
      server.register(
        experienceRoutes({
          access: { authorize: () => Promise.resolve({ kind: 'Authorized' as const, ownerAid }) },
          conversation: {
            retrieve: (request) =>
              retrieveExperience(request, {
                scopes: { inspect: () => Promise.resolve({ kind: 'Authorized' as const, scope }) },
                experience: available.experience,
              }),
            readReceipt: (request) =>
              readExperienceQueryReceipt(request, {
                scopes: { inspect: () => Promise.resolve({ kind: 'Authorized' as const, scope }) },
                receipts: available.receipts,
              }),
          },
          now: () => new Date().toISOString(),
          newCorrelationId: randomUUID,
        }),
      );
      const address = await server.listen({ host: '127.0.0.1', port: 0 });
      const query = () =>
        fetch(`${address}/api/experience/query`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${'a'.repeat(43)}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            version: 1,
            taskId,
            sourceInventorySaid: source.inventory.d,
            corpusSaid,
            failureQuery: 'legacy receipt parser rejected exit code 101',
            maximumResults: 3,
          }),
        });
      let response: Response | undefined;
      const indexedDeadline = Date.now() + 90_000;
      while (Date.now() < indexedDeadline) {
        response = await query();
        if (response.status === 200) break;
        if (response.status !== 422)
          throw new Error(`Unexpected Experience HTTP status ${String(response.status)}`);
        await delay(2_000);
      }
      if (response === undefined) throw new Error('No Experience HTTP response');
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        sources: { episodeSaid: string; rawEvidenceSaid: string; score: number }[];
        queryReceiptSaid: string;
      };
      expect(body.sources).toHaveLength(1);
      expect(body.sources[0]).toMatchObject({
        episodeSaid: event.event.d,
        rawEvidenceSaid: artifact.artifact.d,
      });
      expect(body.sources[0]?.score).toBeGreaterThan(pinnedAtlasExperienceProfile.minimumScore);
      expect(
        await hosted.collection(experienceCollectionNames.queryReceipts).countDocuments(),
      ).toBe(0);
      expect(await atlas.collection(experienceCollectionNames.queryReceipts).countDocuments()).toBe(
        1,
      );
      await hosted
        .collection<EvidenceArtifactDocument>(evidenceCollectionNames.artifacts)
        .deleteOne({ _id: evidenceArtifactDocumentId(runId, artifact.artifact.d) });
      const revoked = await query();
      expect(revoked.status).toBe(403);
      expect(await revoked.json()).toMatchObject({ code: 'ExperienceDenied' });
      process.stdout.write(
        `${JSON.stringify({ kind: 'ServerAtlasCompositionMechanism', modelVersion: pinnedAtlasExperienceProfile.modelVersion, score: body.sources[0]?.score, receiptSaid: body.queryReceiptSaid, distinctDatabases: hostedName !== atlasName })}\n`,
      );
    } finally {
      await closeServer?.();
      await opened?.close();
      await Promise.allSettled([hosted.dropDatabase(), atlas.dropDatabase()]);
      await Promise.all([hostedClient.close(), atlasInspector.close()]);
      await rm(cacheDirectory, { recursive: true, force: true });
    }
  },
  240_000,
);
