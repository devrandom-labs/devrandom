import { randomUUID } from 'node:crypto';

import { type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify from 'fastify';
import { MongoClient } from 'mongodb';
import { issuerAid, personalAgentAid } from '@devrandom/identity';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  prepareEvaluationExecutionProfile,
  prepareEvaluationClosure,
  prepareEvaluationSourceInventory,
  type TaskProjection,
} from '@devrandom/protocol';

import type { WorkAccessAttempts } from '../../access/application/work-access-attempts.js';
import { evidenceReadRoutes } from '../../evidence/route/evidence-read-routes.js';
import { experienceRoutes } from '../../experience/route/experience-routes.js';
import type { CurrentTaskMandateAuthorization } from '../../mandate/application/current-task-mandate.js';
import { MongoEvaluationBootstrap } from '../infrastructure/mongo-evaluation-bootstrap.js';
import {
  evaluationCollectionNames,
  type EvaluationDocument,
  type EvaluationPreparationDocument,
} from '../infrastructure/mongo-evaluation-reservations.js';
import { evaluationRoutes } from '../route/evaluation-routes.js';
import { composeHostedEvaluation } from './hosted-evaluation.js';

const mongoUri = process.env.DEVRANDOM_MONGODB_URI;
const describeMongo = mongoUri === undefined ? describe.skip : describe;
const said = (letter: string): string => `E${letter.repeat(43)}`;
const ownerAid = said('o');
const agentAid = personalAgentAid('EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz');
const issuer = issuerAid('EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk');
const taskId = randomUUID();
const sourceInventorySaid = said('i');
const corpusSaid = said('c');
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

describeMongo('composed hosted Evaluation HTTP boundary', () => {
  const client = new MongoClient(mongoUri ?? 'mongodb://127.0.0.1:27017');
  const database = client.db(`devrandom_hosted_composition_${randomUUID().replaceAll('-', '')}`);
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  let address: string;
  let currentSource = false;
  let sealAvailable = false;
  let lastClosureInspection: unknown;

  beforeAll(async () => {
    await client.connect();
    const bootstrap = new MongoEvaluationBootstrap(database);
    await bootstrap.bootstrap();
    await bootstrap.verify();
    const attempts = {
      authorizeGrant: () =>
        Promise.resolve({
          kind: 'GrantAuthorized',
          remainingRequests: 100,
          stored: { attempt: { binding: { userAid: ownerAid } } },
        }),
    } as unknown as WorkAccessAttempts;
    const composed = composeHostedEvaluation({
      client,
      database,
      attempts,
      tasks: {
        findById: () =>
          Promise.resolve(
            currentSource
              ? {
                  kind: 'TaskFound',
                  task: {
                    taskId,
                    ownerAid,
                    revisionSaid: said('t'),
                    harnessLineageId: randomUUID(),
                    lifecycle: { kind: 'Open' },
                    revision: {
                      version: 2,
                      requestedCapabilities: ['ReadTaskMemory'],
                      unavailableCapabilities: [],
                      constraints: {
                        experience: {
                          corpusSaid,
                          repositoryResourceSaid: said('r'),
                          disclosure: 'AuthorizedAnalogy',
                        },
                      },
                    },
                  } as unknown as TaskProjection,
                }
              : { kind: 'TaskNotFound' },
          ),
      },
      presentations: {
        findByCredential: () =>
          Promise.resolve(
            currentSource
              ? ({
                  kind: 'PresentationFound',
                  stored: {
                    revision: 1,
                    presentation: {
                      version: 1,
                      binding: {
                        ownerAid,
                        userCredentialSaid: said('u'),
                        mandateKind: 'TaskMandate',
                        credentialSaid: said('m'),
                        grantSaid: said('g'),
                        requestedAt: '2026-09-26T04:00:00.000Z',
                        expiresAt: '2026-09-26T16:00:00.000Z',
                      },
                      state: {
                        kind: 'Admitted',
                        credentialSaid: said('m'),
                        admittedAt: new Date().toISOString(),
                      },
                      acceptedReference: {
                        issueeAid: agentAid,
                        registryId: said('z'),
                        taskId,
                        taskRevisionSaid: said('t'),
                      },
                    },
                  },
                } as const)
              : { kind: 'PresentationNotFound' as const },
          ),
      },
      currentTaskMandate: {
        authorize: () =>
          Promise.resolve(
            currentSource
              ? ({
                  kind: 'CurrentTaskMandateAuthorized',
                  mandate: {
                    credential: { credentialSaid: said('m') },
                    allowedCapabilities: ['ReadTaskMemory'],
                    budgets: budget,
                    experience: {
                      corpusSaid,
                      repositoryResourceSaid: said('r'),
                      disclosure: 'AuthorizedAnalogy',
                    },
                  },
                } as unknown as CurrentTaskMandateAuthorization)
              : { kind: 'TaskNotFound' as const },
          ),
      },
      issuerAid: issuer,
      closureExchanges: {
        inspect: (expected) => {
          lastClosureInspection = expected;
          return Promise.resolve(
            sealAvailable
              ? { kind: 'Verified' as const, ...expected }
              : { kind: 'Pending' as const },
          );
        },
      },
    });
    server.register(evaluationRoutes(composed.evaluation));
    server.register(evidenceReadRoutes(composed.evidenceReading));
    server.register(experienceRoutes(composed.experience));
    address = await server.listen({ host: '127.0.0.1', port: 0 });
  });

  afterAll(async () => {
    await server.close();
    await database.dropDatabase();
    await client.close();
  });

  it('blocks admission before reservation without current Task/Mandate authority', async () => {
    const response = await fetch(`${address}/api/evaluations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${'s'.repeat(43)}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 1,
        commandId: randomUUID(),
        fingerprint: `sha256:${'a'.repeat(64)}`,
        taskId,
        taskRevisionSaid: said('t'),
        originRunId: randomUUID(),
        retainedCheckpointSaid: said('p'),
        retainedSealSaid: said('s'),
        expectedActiveRevisionSaid: said('h'),
        personalAgentAid: agentAid,
        taskMandateSaid: said('m'),
        policySaid: said('l'),
        executionProfileSaid: said('e'),
        sourceInventorySaid,
        allocation: { diagnosis: budget, perEntry: budget, finalization: budget },
      }),
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: 'EvaluationBlockedAuthority' });
    expect(await database.collection('evaluations').countDocuments()).toBe(0);
  });

  it('denies unprepared exact raw reads and reports Atlas unavailable without an embedding profile', async () => {
    const headers = {
      authorization: `Bearer ${'s'.repeat(43)}`,
      'content-type': 'application/json',
    };
    const raw = await fetch(`${address}/api/evidence/read`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        version: 1,
        taskId,
        sourceInventorySaid,
        evidenceSaid: said('e'),
        offset: 0,
        maximumBytes: 10,
      }),
    });
    expect(raw.status).toBe(403);
    const experience = await fetch(`${address}/api/experience/query`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        version: 1,
        taskId,
        sourceInventorySaid,
        corpusSaid,
        failureQuery: 'receipt mismatch',
        maximumResults: 3,
      }),
    });
    expect(experience.status).toBe(503);
  });

  it('cannot qualify a comparison from a prepared source without the six-Run campaign', async () => {
    const inventory = prepareEvaluationSourceInventory({
      taskId,
      taskRevisionSaid: said('t'),
      ownerAid,
      repositoryResourceSaid: said('r'),
      corpusSaid,
      experienceMandateSaid: said('m'),
      sources: [
        {
          episodeSaid: said('x'),
          rawEvidenceSaid: said('y'),
          ownerAid,
          repositoryResourceSaid: said('r'),
          corpusSaid,
          disclosure: 'AuthorizedAnalogy',
        },
      ],
    });
    if (inventory.kind !== 'Prepared') throw new Error(inventory.reason);
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
    const commandId = randomUUID();
    await database
      .collection<EvaluationPreparationDocument>(evaluationCollectionNames.preparations)
      .insertOne({
        _id: commandId,
        ownerAid,
        command: {
          version: 1,
          commandId,
          fingerprint: `sha256:${'f'.repeat(64)}`,
          taskId,
          taskRevisionSaid: said('t'),
          sourceInventory: inventory.inventory,
          executionProfile: profile.profile,
        },
        sourceInventory: inventory.inventory,
        executionProfile: profile.profile,
        acceptedAt: new Date(),
      });
    currentSource = true;
    try {
      const response = await fetch(`${address}/api/evaluations`, {
        method: 'POST',
        headers: { authorization: `Bearer ${'s'.repeat(43)}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          commandId: randomUUID(),
          fingerprint: `sha256:${'a'.repeat(64)}`,
          taskId,
          taskRevisionSaid: said('t'),
          originRunId: randomUUID(),
          retainedCheckpointSaid: said('p'),
          retainedSealSaid: said('s'),
          expectedActiveRevisionSaid: said('h'),
          personalAgentAid: agentAid,
          taskMandateSaid: said('m'),
          policySaid: said('l'),
          executionProfileSaid: profile.profile.d,
          sourceInventorySaid: inventory.inventory.d,
          allocation: { diagnosis: budget, perEntry: budget, finalization: budget },
        }),
      });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ code: 'EvaluationBlockedQualification' });
      expect(
        await database.collection(evaluationCollectionNames.evaluations).countDocuments(),
      ).toBe(0);
    } finally {
      currentSource = false;
    }
  });

  it('requires issuer KERIA seal custody before even checking closure evidence completeness', async () => {
    const inventory = prepareEvaluationSourceInventory({
      taskId,
      taskRevisionSaid: said('t'),
      ownerAid,
      repositoryResourceSaid: said('r'),
      corpusSaid,
      experienceMandateSaid: said('m'),
      sources: [
        {
          episodeSaid: said('x'),
          rawEvidenceSaid: said('y'),
          ownerAid,
          repositoryResourceSaid: said('r'),
          corpusSaid,
          disclosure: 'AuthorizedAnalogy',
        },
      ],
    });
    if (inventory.kind !== 'Prepared') throw new Error(inventory.reason);
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
    const evaluationId = randomUUID();
    const evidenceStreamId = randomUUID();
    const originRunId = randomUUID();
    const closure = prepareEvaluationClosure({
      evaluationId,
      evidenceStreamId,
      originRunId,
      manifestSaid: said('M'),
      evidenceIndexSaid: said('I'),
      acceptedEventCount: 1,
      acceptedHeadSaid: said('h'),
      observationSaids: Array.from({ length: 18 }, (_, index) =>
        said(String.fromCharCode(65 + index)),
      ),
      measurementSaids: Array.from({ length: 15 }, (_, index) =>
        said(String.fromCharCode(97 + index)),
      ),
      sharedAuditSaid: said('s'),
      armAuditSaids: {
        H1: said('1'),
        C1: said('2'),
        C2: said('3'),
        C3: said('4'),
        H1TaskSearch: said('5'),
      },
      protectedCustodySaid: said('p'),
      agentSealSaid: said('g'),
    });
    if (closure.kind !== 'Prepared') throw new Error(closure.reason);
    const preparationCommandId = randomUUID();
    await database
      .collection<EvaluationPreparationDocument>(evaluationCollectionNames.preparations)
      .insertOne({
        _id: preparationCommandId,
        ownerAid,
        command: {
          version: 1,
          commandId: preparationCommandId,
          fingerprint: `sha256:${'f'.repeat(64)}`,
          taskId,
          taskRevisionSaid: said('t'),
          sourceInventory: inventory.inventory,
          executionProfile: profile.profile,
        },
        sourceInventory: inventory.inventory,
        executionProfile: profile.profile,
        acceptedAt: new Date(),
      });
    const admittedCommandId = randomUUID();
    await database.collection<EvaluationDocument>(evaluationCollectionNames.evaluations).insertOne({
      _id: evaluationId,
      ownerAid,
      command: {
        version: 1,
        commandId: admittedCommandId,
        fingerprint: `sha256:${'e'.repeat(64)}`,
        taskId,
        taskRevisionSaid: said('t'),
        originRunId,
        retainedCheckpointSaid: said('p'),
        retainedSealSaid: said('s'),
        expectedActiveRevisionSaid: said('h'),
        personalAgentAid: agentAid,
        taskMandateSaid: said('m'),
        policySaid: said('l'),
        executionProfileSaid: profile.profile.d,
        sourceInventorySaid: inventory.inventory.d,
        allocation: { diagnosis: budget, perEntry: budget, finalization: budget },
      },
      reserved: budget,
      reservationSaid: said('v'),
      evidenceStreamId,
      version: 1,
      lease: {
        evaluationId,
        leaseId: randomUUID(),
        version: 1,
        serverTime: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      },
      acceptedThroughSequence: 0,
      chainHeadSaid: said('h'),
      acceptedBytes: 0,
      acceptedAt: new Date(),
    });
    currentSource = true;
    const closureCommandId = randomUUID();
    const close = () =>
      fetch(`${address}/api/evaluations/${evaluationId}/closure`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${'s'.repeat(43)}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          commandId: closureCommandId,
          fingerprint: `sha256:${'f'.repeat(64)}`,
          expectedEvaluationVersion: 1,
          closure: closure.closure,
        }),
      });
    try {
      const pending = await close();
      expect(pending.status).toBe(403);
      expect(await pending.json()).toMatchObject({ code: 'EvaluationClosureDenied' });
      expect(lastClosureInspection).toMatchObject({
        exchangeSaid: closure.closure.agentSealSaid,
        sourceAid: agentAid,
        recipientAid: issuer,
      });
      sealAvailable = true;
      const verified = await close();
      expect(verified.status).toBe(422);
      expect(await verified.json()).toMatchObject({ code: 'EvaluationClosureIncomplete' });
    } finally {
      currentSource = false;
      sealAvailable = false;
    }
  });
});
