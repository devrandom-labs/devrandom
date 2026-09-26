import { randomUUID } from 'node:crypto';

import { type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify from 'fastify';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { acquireFirstRunLease, createRun, openTask, type Run } from '@devrandom/domain';
import {
  evidenceArtifactReferences,
  evidenceBatchCommandFingerprint,
  prepareEvidenceArtifact,
  prepareEvidenceBatch,
  prepareEvidenceEvent,
  preparePublicVerifierReceipt,
  prepareVerifiedCheckpoint,
  taskBudgetCeilings,
  taskCommandFingerprint,
  type EvidenceEvent,
  type EvidenceEventDetail,
} from '@devrandom/protocol';

import { projectTask } from '../../task/application/task-projection.js';
import { acquireRunLease } from '../../run/application/acquire-run-lease.js';
import {
  beginWorkAccessVerification,
  createAwaitingWorkAccessAttempt,
  grantWorkAccessAttempt,
  workAccessCommandFingerprint,
  workAccessGrantSecretHash,
} from '../../access/domain/work-access.js';
import { workAccessPolicy } from '../../access/domain/work-access-policy.js';
import { MongoWorkAccessAttempts } from '../../access/infrastructure/mongo-work-access-attempts.js';
import { MongoWorkAccessBootstrap } from '../../access/infrastructure/mongo-work-access-bootstrap.js';
import { acceptEvidenceBatch } from '../application/accept-evidence-batch.js';
import { evidenceRoutes } from '../route/evidence-routes.js';
import { MongoRunBootstrap } from '../../run/infrastructure/mongo-run-bootstrap.js';
import { runsCollectionName } from '../../run/infrastructure/mongo-runs.js';
import {
  decodeRunDocument,
  encodeRunDocument,
  type RunDocument,
} from '../../run/infrastructure/run-document.js';
import { MongoTaskBootstrap } from '../../task/infrastructure/mongo-task-bootstrap.js';
import { tasksCollectionName } from '../../task/infrastructure/mongo-tasks.js';
import {
  decodeTaskDocument,
  encodeTaskDocument,
  type TaskDocument,
} from '../../task/infrastructure/task-document.js';
import { taskCommandFixture } from '../../task/test/task-command-fixture.js';
import { evidenceCollectionNames, evidenceUsageDocumentId } from './evidence-storage-contract.js';
import {
  decodeEvidenceStreamDocument,
  type EvidenceStreamDocument,
} from './evidence-stream-document.js';
import type { EvidenceUsageDocument } from './evidence-usage-document.js';
import { MongoEvidenceArtifacts } from './mongo-evidence-artifacts.js';
import { MongoEvidenceBatches } from './mongo-evidence-batches.js';
import { MongoEvidenceBootstrap } from './mongo-evidence-bootstrap.js';
import { MongoEvidenceRunContexts } from './mongo-evidence-run-contexts.js';
import { MongoEvidenceSeals } from './mongo-evidence-seals.js';
import { MongoEvidenceTimelines } from './mongo-evidence-timelines.js';
import { workAccessEvidenceAuthorizer } from './work-access-evidence-authorizer.js';
import type { EvidenceEventDocument } from './evidence-event-document.js';

const uri = process.env['DEVRANDOM_MONGODB_URI'];
const describeMongo = uri === undefined ? describe.skip : describe;
const ownerAid = `E${'a'.repeat(43)}`;
const personalAgentAid = `E${'e'.repeat(43)}`;
const taskMandateSaid = `E${'f'.repeat(43)}`;
const runId = '1cc482f1-98e9-4454-8e4c-5566cb47ce3d';
const incarnationId = 'b5c5f13e-63df-4a4f-b1fc-08df00150f15';
const streamId = 'a1975db1-6130-41c2-b9dd-c8ec8bc12c94';

function event(
  run: Run,
  sequence: number,
  predecessor: EvidenceEvent['predecessor'],
  detail: EvidenceEventDetail,
  recordedAt = `2026-09-24T20:00:${String(sequence + 10).padStart(2, '0')}.000Z`,
) {
  if (run.lease.kind !== 'Held') throw new Error('evidence event requires a held Run lease');
  const prepared = prepareEvidenceEvent({
    version: 1,
    sequence,
    predecessor,
    taskId: run.binding.taskId,
    taskRevisionSaid: run.binding.taskRevisionSaid,
    runId: run.binding.runId,
    incarnationId: run.lease.incarnationId,
    harnessRevisionSaid: run.binding.initialHarnessRevisionSaid,
    personalAgentAid,
    taskMandateSaid,
    occurredAt: recordedAt,
    recordedAt,
    producer: {
      kind:
        detail.kind === 'EffectFailed' || detail.kind === 'ToolProposed'
          ? 'ToolGateway'
          : 'RunSupervisor',
    },
    event: detail,
  });
  if (prepared.kind !== 'Prepared') {
    throw new Error(`evidence event fixture failed: ${prepared.reason}`);
  }
  return prepared.event;
}

function privacyEvent(
  run: Run,
  sequence: number,
  predecessor: EvidenceEvent['predecessor'],
  detail: EvidenceEventDetail,
): EvidenceEvent {
  const prepared = prepareEvidenceEvent({
    version: 1,
    sequence,
    predecessor,
    taskId: run.binding.taskId,
    taskRevisionSaid: run.binding.taskRevisionSaid,
    runId: run.binding.runId,
    incarnationId,
    harnessRevisionSaid: run.binding.initialHarnessRevisionSaid,
    personalAgentAid,
    taskMandateSaid,
    occurredAt: '2026-09-24T20:00:20.000Z',
    recordedAt: '2026-09-24T20:00:20.000Z',
    producer: { kind: 'EvidenceRecorder' },
    event: detail,
  });
  if (prepared.kind !== 'Prepared') throw new Error('privacy marker fixture failed');
  return prepared.event;
}

function batch(run: Run, events: readonly EvidenceEvent[]) {
  const prepared = prepareEvidenceBatch({
    version: 1,
    runId: run.binding.runId,
    evidenceStreamId: run.binding.evidenceStreamId,
    events: [...events],
  });
  if (prepared.kind !== 'Prepared') {
    throw new Error(`evidence batch fixture failed: ${prepared.reason}`);
  }
  return { version: 1 as const, batch: prepared.batch, events: [...events] };
}

describeMongo('Mongo evidence delivery transaction', () => {
  const client = uri === undefined ? undefined : new MongoClient(uri);
  const databaseName = `devrandom_evidence_delivery_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    if (client !== undefined) {
      await client.connect();
    }
  });

  afterAll(async () => {
    if (client !== undefined) {
      await client.db(databaseName).dropDatabase();
      await client.close();
    }
  });

  it('accepts identical artifact bytes in two separate Run streams', async () => {
    if (client === undefined)
      throw new Error('MongoDB URI disappeared during the integration test');
    const database = client.db(databaseName);
    await database.dropDatabase();
    await new MongoTaskBootstrap(database).bootstrap();
    await new MongoEvidenceBootstrap(database).bootstrap();

    const taskCommand = taskCommandFixture('2026-09-24T23:00:00.000Z');
    const taskId = randomUUID();
    const harnessLineageId = randomUUID();
    const task = openTask({
      taskId,
      ownerAid,
      label: taskCommand.label,
      harnessLineageId,
      revisionSaid: taskCommand.revision.d,
      commandId: taskCommand.commandId,
      createdAt: '2026-09-24T20:00:00.000Z',
    });
    await database.collection<TaskDocument>(tasksCollectionName).insertOne(
      encodeTaskDocument(
        projectTask(task, taskCommand.revision),
        taskCommandFingerprint(taskCommand),
        {
          ownerSlot: 0,
          globalSlot: 0,
        },
      ),
    );

    const firstRunId = randomUUID();
    const campaignId = randomUUID();
    const createLeasedRun = (ordinal: 1 | 2): Run => {
      const acceptedAt = ordinal === 1 ? '2026-09-24T20:00:00.000Z' : '2026-09-24T20:01:00.000Z';
      const created = createRun({
        runId: ordinal === 1 ? firstRunId : randomUUID(),
        ownerAid,
        taskId,
        taskRevisionSaid: taskCommand.revision.d,
        harnessLineageId,
        personalAgentAid,
        taskMandateSaid,
        governorAid: `E${'g'.repeat(43)}`,
        promotionMandateSaid: `E${'h'.repeat(43)}`,
        initialHarnessRevisionSaid: `E${'b'.repeat(43)}`,
        purpose: { kind: 'PreparedCompatibilityCalibration', campaignId, ordinal },
        initialSpecialization: {
          kind: 'InitialSpecializationAccepted',
          harnessLineageId,
          harnessRevisionSaid: `E${'b'.repeat(43)}`,
          runId: firstRunId,
          acceptedAt: '2026-09-24T20:00:00.000Z',
        },
        repository: { objectFormat: 'sha1', commit: '1'.repeat(40), tree: '2'.repeat(40) },
        commandId: randomUUID(),
        admissionExchangeSaid: `E${'i'.repeat(43)}`,
        evidenceStreamId: randomUUID(),
        budget: taskBudgetCeilings,
        acceptedAt,
      });
      if (created.kind !== 'Created') throw new Error('Run fixture creation failed');
      const leased = acquireFirstRunLease(created.run, {
        incarnationId: randomUUID(),
        expectedRunVersion: 0,
        serverTime: '2026-09-24T20:00:00.000Z',
      });
      if (leased.kind !== 'Acquired') throw new Error('Run fixture lease acquisition failed');
      return leased.run;
    };
    const runs = [createLeasedRun(1), createLeasedRun(2)];
    await database
      .collection<RunDocument>(runsCollectionName)
      .insertMany(runs.map((run) => encodeRunDocument(run, `sha256:${'c'.repeat(64)}`)));

    const bytes = new TextEncoder().encode('the same repository file in both Runs');
    const prepared = prepareEvidenceArtifact(bytes, 'text/plain; charset=utf-8');
    if (prepared.kind !== 'Prepared') throw new Error('artifact fixture failed');
    const artifacts = new MongoEvidenceArtifacts(client, database);
    const batches = new MongoEvidenceBatches(client, database);
    for (const run of runs) {
      const input = {
        ownerAid,
        runId: run.binding.runId,
        artifact: prepared.artifact,
        bytes,
        receivedAt: '2026-09-24T20:01:00.000Z',
      };
      await expect(artifacts.admit(input)).resolves.toMatchObject({
        kind: 'EvidenceArtifactStored',
      });
      await expect(artifacts.admit(input)).resolves.toMatchObject({
        kind: 'EvidenceArtifactAlreadyStored',
      });
      const started = event(
        run,
        0,
        { kind: 'Genesis' },
        { kind: 'RunStarted', fromRunVersion: run.version },
      );
      const observed = event(
        run,
        1,
        { kind: 'Previous', eventSaid: started.d },
        {
          kind: 'Observation',
          source: 'Repository',
          artifactSaid: prepared.artifact.d,
        },
      );
      const body = batch(run, [started, observed]);
      await expect(
        batches.accept({
          ownerAid,
          expectedRunVersion: run.version,
          commandFingerprint: evidenceBatchCommandFingerprint(body),
          body,
          receivedAt: '2026-09-24T20:01:01.000Z',
        }),
      ).resolves.toMatchObject({ kind: 'EvidenceBatchAccepted' });
    }
    await expect(
      database.collection(evidenceCollectionNames.artifacts).countDocuments({
        'artifact.d': prepared.artifact.d,
      }),
    ).resolves.toBe(2);
  });

  it.each([
    { providerOutputTokens: 0, outputEvent: 'Observation' },
    { providerOutputTokens: 100_001, outputEvent: 'Observation' },
    { providerOutputTokens: 100_001, outputEvent: 'EffectFailed' },
  ] as const)(
    'commits, retries, rolls back and seals $outputEvent with $providerOutputTokens output tokens consumed',
    async ({ providerOutputTokens, outputEvent }) => {
      if (client === undefined) {
        throw new Error('MongoDB URI disappeared during the integration test');
      }
      const database = client.db(databaseName);
      await database.dropDatabase();
      const blockReason =
        providerOutputTokens > 0 ? 'BudgetExhausted' : 'HarnessCompatibilityFailure';
      await new MongoTaskBootstrap(database).bootstrap();
      await new MongoRunBootstrap(database).bootstrap();
      await new MongoEvidenceBootstrap(database).bootstrap();

      const taskCommand = taskCommandFixture('2026-09-24T23:00:00.000Z');
      const taskId = '4df838a8-5109-49fd-bdad-805880a3ecee';
      const harnessLineageId = '5ebf49b9-df26-4a49-9194-da868f97cf9d';
      const task = openTask({
        taskId,
        ownerAid,
        label: taskCommand.label,
        harnessLineageId,
        revisionSaid: taskCommand.revision.d,
        commandId: taskCommand.commandId,
        createdAt: '2026-09-24T20:00:00.000Z',
      });
      await database.collection<TaskDocument>(tasksCollectionName).insertOne(
        encodeTaskDocument(
          projectTask(task, taskCommand.revision),
          taskCommandFingerprint(taskCommand),
          {
            ownerSlot: 0,
            globalSlot: 0,
          },
        ),
      );
      const created = createRun({
        runId,
        ownerAid,
        taskId,
        taskRevisionSaid: taskCommand.revision.d,
        harnessLineageId,
        personalAgentAid,
        taskMandateSaid,
        governorAid: `E${'g'.repeat(43)}`,
        promotionMandateSaid: `E${'h'.repeat(43)}`,
        initialHarnessRevisionSaid: `E${'b'.repeat(43)}`,
        purpose: { kind: 'Retained' },
        initialSpecialization: {
          kind: 'InitialSpecializationAccepted',
          harnessLineageId,
          harnessRevisionSaid: `E${'b'.repeat(43)}`,
          runId: 'ff6774df-9797-4295-8e74-a974819babec',
          acceptedAt: '2026-09-24T19:55:00.000Z',
        },
        repository: { objectFormat: 'sha1', commit: '1'.repeat(40), tree: '2'.repeat(40) },
        commandId: 'd2c9160a-58f8-4d43-ae67-22124c6e9112',
        admissionExchangeSaid: `E${'i'.repeat(43)}`,
        evidenceStreamId: streamId,
        budget: taskBudgetCeilings,
        acceptedAt: '2026-09-24T20:00:00.000Z',
      });
      if (created.kind !== 'Created') {
        throw new Error('Run fixture creation failed');
      }
      const leased = acquireFirstRunLease(created.run, {
        incarnationId,
        expectedRunVersion: 0,
        serverTime: '2026-09-24T20:00:00.000Z',
      });
      if (leased.kind !== 'Acquired') {
        throw new Error('Run fixture lease acquisition failed');
      }

      const bytes = new TextEncoder().encode('artifact evidence');
      const preparedArtifact = prepareEvidenceArtifact(bytes, 'text/plain; charset=utf-8');
      if (preparedArtifact.kind !== 'Prepared') {
        throw new Error('artifact fixture failed');
      }
      const started = event(
        leased.run,
        0,
        { kind: 'Genesis' },
        {
          kind: 'RunStarted',
          fromRunVersion: leased.run.version,
        },
      );
      const observed = event(
        leased.run,
        1,
        { kind: 'Previous', eventSaid: started.d },
        outputEvent === 'Observation'
          ? { kind: 'Observation', source: 'Repository', artifactSaid: preparedArtifact.artifact.d }
          : {
              kind: 'EffectFailed',
              failure: 'BudgetExhausted',
              outputArtifactSaids: [preparedArtifact.artifact.d],
              piSessionId: '46df3dc0-ff4f-4607-9c25-cad3b378e875',
              modelTurnId: 'turn-1',
              toolCallId: 'call-0',
              proposalIndex: 0,
              tool: 'run_tests',
              requiredCapability: 'RunTests',
              resource: 'command://public-test',
            },
      );
      expect(evidenceArtifactReferences(observed.event)).toEqual([preparedArtifact.artifact.d]);
      const firstBody = batch(leased.run, [started, observed]);
      const continued = event(
        leased.run,
        2,
        { kind: 'Previous', eventSaid: observed.d },
        providerOutputTokens > 0
          ? {
              kind: 'BudgetDebited',
              budget: 'providerOutputTokens',
              amount: providerOutputTokens,
              consumed: providerOutputTokens,
            }
          : { kind: 'IncarnationStarted' },
      );
      const secondBody = batch(leased.run, [continued]);
      const gap = event(
        leased.run,
        3,
        { kind: 'Previous', eventSaid: continued.d },
        { kind: 'SecurityViolation', violation: 'EvidenceTampering' },
      );
      const gapBody = batch(leased.run, [gap]);
      const missingArtifactEvent = event(
        leased.run,
        2,
        { kind: 'Previous', eventSaid: observed.d },
        { kind: 'Observation', source: 'ToolEffect', artifactSaid: `E${'m'.repeat(43)}` },
      );
      const missingArtifactBody = batch(leased.run, [missingArtifactEvent]);

      await database
        .collection<RunDocument>(runsCollectionName)
        .insertOne(encodeRunDocument(leased.run, `sha256:${'c'.repeat(64)}`));
      const artifacts = new MongoEvidenceArtifacts(client, database);
      if (providerOutputTokens === 0) {
        const bearer = `A${'s'.repeat(42)}`;
        const forbiddenBytes = new TextEncoder().encode(`captured output: ${bearer}`);
        const forbiddenArtifact = prepareEvidenceArtifact(
          forbiddenBytes,
          'text/plain; charset=utf-8',
        );
        if (forbiddenArtifact.kind !== 'Prepared') {
          throw new Error('forbidden artifact fixture failed');
        }
        const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
        await server.register(
          evidenceRoutes({
            access: {
              authorize: () => Promise.resolve({ kind: 'EvidenceAccessAuthorized', ownerAid }),
            },
            conversation: {
              admitArtifact: (input) => artifacts.admit(input),
              acceptBatch: (input) =>
                acceptEvidenceBatch(input, {
                  contexts: new MongoEvidenceRunContexts(database),
                  authority: { authorize: () => Promise.resolve({ kind: 'TaskNotFound' }) },
                  batches: new MongoEvidenceBatches(client, database),
                }),
              reconcileSeal: () => Promise.resolve({ kind: 'EvidenceRunNotFound' }),
              inspectTimeline: () => Promise.resolve({ kind: 'EvidenceRunNotFound' }),
            },
            now: () => '2026-09-24T20:01:00.000Z',
            newCorrelationId: () => randomUUID(),
          }),
        );
        const response = await server.inject({
          method: 'PUT',
          url: `/api/runs/${runId}/artifacts/${forbiddenArtifact.artifact.d}`,
          headers: {
            authorization: `Bearer ${bearer}`,
            'content-type': 'text/plain; charset=utf-8',
          },
          payload: Buffer.from(forbiddenBytes),
        });
        expect(response.statusCode).toBe(422);
        expect(response.json()).toMatchObject({
          code: 'EvidenceRejected',
          reason: 'SecretDetected',
        });
        expect(
          await database
            .collection<{ _id: string }>(evidenceCollectionNames.artifacts)
            .countDocuments({ _id: forbiddenArtifact.artifact.d }),
        ).toBe(0);
        const forbiddenProposal = event(
          leased.run,
          1,
          { kind: 'Previous', eventSaid: started.d },
          {
            kind: 'ToolProposed',
            piSessionId: 'b1ef07c8-4790-4eee-95c8-44cac2b7a7ed',
            modelTurnId: 'turn-1',
            toolCallId: 'call-1',
            proposalIndex: 0,
            tool: 'read_file',
            requiredCapability: 'ReadRepository',
            resource: `file://${bearer}`,
          },
        );
        const forbiddenBatch = batch(leased.run, [started, forbiddenProposal]);
        const batchResponse = await server.inject({
          method: 'PUT',
          url: `/api/runs/${runId}/evidence-batches/${forbiddenBatch.batch.d}`,
          headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
          payload: forbiddenBatch,
        });
        expect(batchResponse.statusCode).toBe(422);
        expect(batchResponse.json()).toMatchObject({
          code: 'EvidenceRejected',
          reason: 'SecretDetected',
        });
        expect(
          await database
            .collection<{ _id: string }>(evidenceCollectionNames.batches)
            .countDocuments({ _id: forbiddenBatch.batch.d }),
        ).toBe(0);
        expect(
          await database
            .collection<{ _id: string }>(evidenceCollectionNames.events)
            .countDocuments({ _id: forbiddenProposal.d }),
        ).toBe(0);
        await server.close();
      }
      const artifactInput = {
        ownerAid,
        runId,
        artifact: preparedArtifact.artifact,
        bytes,
        receivedAt: '2026-09-24T20:01:00.000Z',
      };
      await expect(artifacts.admit(artifactInput)).resolves.toMatchObject({
        kind: 'EvidenceArtifactStored',
      });
      await expect(artifacts.admit(artifactInput)).resolves.toMatchObject({
        kind: 'EvidenceArtifactAlreadyStored',
      });

      if (outputEvent === 'EffectFailed') {
        await new MongoWorkAccessBootstrap(database).bootstrap();
        const bearer = `A${'s'.repeat(42)}`;
        const accessCommand = {
          commandId: randomUUID(),
          clientInstanceId: randomUUID(),
          userAid: ownerAid,
          credentialSaid: `E${'u'.repeat(43)}`,
          grantSecretHash: workAccessGrantSecretHash(bearer),
        };
        const awaiting = createAwaitingWorkAccessAttempt({
          ...accessCommand,
          attemptId: randomUUID(),
          issuerRecipientAid: `E${'i'.repeat(43)}`,
          challengeWords: Array.from({ length: 24 }, (_, index) => `word-${String(index)}`),
          createdAt: '2026-09-24T20:00:00.000Z',
          expiresAt: '2026-09-24T20:05:00.000Z',
        });
        const attempts = new MongoWorkAccessAttempts(database);
        const createdAccess = await attempts.create(
          awaiting,
          workAccessCommandFingerprint(accessCommand),
        );
        if (createdAccess.kind !== 'AttemptCreated') throw new Error('Expected access attempt');
        const verification = beginWorkAccessVerification(
          awaiting,
          `E${'v'.repeat(43)}`,
          'operation.challenge.verify.historical',
        );
        if (verification.kind !== 'VerificationStarted') throw new Error('Expected verification');
        const verifying = await attempts.commit(createdAccess.stored, verification.attempt);
        if (verifying.kind !== 'AttemptCommitted') throw new Error('Expected verifying attempt');
        const grant = grantWorkAccessAttempt(
          verifying.stored.attempt,
          ['RunPrivateTask'],
          '2026-09-24T20:00:30.000Z',
          '2026-09-24T20:30:30.000Z',
          workAccessPolicy,
        );
        const granted = await attempts.commit(verifying.stored, grant);
        if (granted.kind !== 'AttemptCommitted') throw new Error('Expected active grant');

        const newLease = vi.fn();
        await expect(
          acquireRunLease(
            {
              owner: { ownerAid, credentialSaid: accessCommand.credentialSaid },
              runId,
              incarnationId: randomUUID(),
              command: { version: 1, expectedRunVersion: 1 },
            },
            {
              currentUserCredential: {
                verify: () => Promise.resolve({ kind: 'UserCredentialNotCurrent' }),
              },
              leases: { acquire: newLease },
              now: () => '2026-09-24T20:01:01.000Z',
            },
          ),
        ).resolves.toEqual({ kind: 'RunLeaseForbidden', reason: 'UserCredentialNotCurrent' });
        expect(newLease).not.toHaveBeenCalled();

        const historicalAuthority = vi.fn().mockResolvedValue({
          kind: 'CurrentTaskMandateAuthorized',
        });
        const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
        await server.register(
          evidenceRoutes({
            access: workAccessEvidenceAuthorizer(attempts),
            conversation: {
              admitArtifact: (input) => artifacts.admit(input),
              acceptBatch: (input) =>
                acceptEvidenceBatch(input, {
                  contexts: new MongoEvidenceRunContexts(database),
                  authority: { authorize: historicalAuthority },
                  batches: new MongoEvidenceBatches(client, database),
                }),
              reconcileSeal: () => Promise.resolve({ kind: 'EvidenceRunNotFound' }),
              inspectTimeline: () => Promise.resolve({ kind: 'EvidenceRunNotFound' }),
            },
            now: () => '2026-09-24T20:01:02.000Z',
            newCorrelationId: randomUUID,
          }),
        );
        try {
          const response = await server.inject({
            method: 'PUT',
            url: `/api/runs/${runId}/evidence-batches/${firstBody.batch.d}`,
            headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
            payload: firstBody,
          });
          expect(response.statusCode).toBe(201);
          expect(response.json()).toMatchObject({
            runId,
            acceptedThroughSequence: 1,
          });
          expect(historicalAuthority).toHaveBeenCalledWith(
            expect.objectContaining({ observedAt: observed.recordedAt }),
          );
        } finally {
          await server.close();
        }
      }

      const batches = new MongoEvidenceBatches(client, database);
      const firstInput = {
        ownerAid,
        expectedRunVersion: leased.run.version,
        commandFingerprint: evidenceBatchCommandFingerprint(firstBody),
        body: firstBody,
        receivedAt: '2026-09-24T20:01:01.000Z',
      };
      const accepted = await batches.accept(firstInput);
      if (
        accepted.kind !== 'EvidenceBatchAccepted' &&
        accepted.kind !== 'EvidenceBatchAlreadyAccepted'
      ) {
        throw new Error('Expected first evidence batch to remain accepted');
      }
      expect(accepted).toMatchObject({
        kind:
          outputEvent === 'EffectFailed' ? 'EvidenceBatchAlreadyAccepted' : 'EvidenceBatchAccepted',
      });
      const timelines = new MongoEvidenceTimelines(database);
      await expect(
        timelines.read({ ownerAid, runId, limit: 10, afterSequence: null }),
      ).resolves.toMatchObject({
        kind: 'EvidenceTimelineRead',
        events: [{ event: started }, { event: observed }],
      });
      await expect(
        timelines.read({ ownerAid: `E${'z'.repeat(43)}`, runId, limit: 10, afterSequence: null }),
      ).resolves.toEqual({ kind: 'EvidenceRunNotFound' });
      const replay = await batches.accept(firstInput);
      expect(replay).toEqual({
        kind: 'EvidenceBatchAlreadyAccepted',
        acknowledgement: accepted.acknowledgement,
      });
      await expect(
        batches.accept({ ...firstInput, commandFingerprint: `sha256:${'9'.repeat(64)}` }),
      ).resolves.toEqual({ kind: 'EvidenceBatchConflict' });
      await expect(
        batches.accept({
          ...firstInput,
          commandFingerprint: evidenceBatchCommandFingerprint(gapBody),
          body: gapBody,
        }),
      ).resolves.toEqual({
        kind: 'EvidenceSequenceGap',
        expectedStartingSequence: 2,
        receivedStartingSequence: 3,
      });

      const cursorBeforeRollback = decodeEvidenceStreamDocument(
        await database
          .collection<EvidenceStreamDocument>(evidenceCollectionNames.streams)
          .findOne({ _id: streamId }),
      );
      await expect(
        batches.accept({
          ...firstInput,
          commandFingerprint: evidenceBatchCommandFingerprint(missingArtifactBody),
          body: missingArtifactBody,
        }),
      ).resolves.toEqual({ kind: 'EvidenceBatchRejected', reason: 'EventBindingMismatch' });
      expect(await database.collection(evidenceCollectionNames.events).countDocuments()).toBe(2);
      expect(
        await database
          .collection<EvidenceEventDocument>(evidenceCollectionNames.events)
          .findOne({ _id: observed.d }),
      ).toMatchObject({ event: observed });
      expect(await database.collection(evidenceCollectionNames.batches).countDocuments()).toBe(1);
      expect(
        decodeEvidenceStreamDocument(
          await database
            .collection<EvidenceStreamDocument>(evidenceCollectionNames.streams)
            .findOne({ _id: streamId }),
        ).cursor,
      ).toEqual(cursorBeforeRollback.cursor);

      await database.collection<EvidenceStreamDocument>(evidenceCollectionNames.streams).updateOne(
        { _id: streamId },
        {
          $set: {
            'binding.combinedByteCeiling': bytes.byteLength + firstBody.batch.encodedByteCount,
          },
        },
      );
      await expect(
        batches.accept({
          ...firstInput,
          commandFingerprint: evidenceBatchCommandFingerprint(secondBody),
          body: secondBody,
        }),
      ).resolves.toEqual({ kind: 'RunEvidenceQuotaExceeded' });
      expect(await database.collection(evidenceCollectionNames.events).countDocuments()).toBe(2);
      expect(
        decodeEvidenceStreamDocument(
          await database
            .collection<EvidenceStreamDocument>(evidenceCollectionNames.streams)
            .findOne({ _id: streamId }),
        ).cursor,
      ).toEqual(cursorBeforeRollback.cursor);
      await database.collection<EvidenceStreamDocument>(evidenceCollectionNames.streams).updateOne(
        { _id: streamId },
        {
          $set: {
            'binding.combinedByteCeiling':
              leased.run.binding.budget.evidencePlusArtifactsPerRunBytes,
          },
        },
      );

      const globalCeiling = leased.run.binding.budget.acceptedEvidencePlusArtifactsGloballyBytes;
      await database
        .collection<EvidenceUsageDocument>(evidenceCollectionNames.usage)
        .updateOne({ _id: evidenceUsageDocumentId }, { $set: { acceptedBytes: globalCeiling } });
      await expect(
        batches.accept({
          ...firstInput,
          commandFingerprint: evidenceBatchCommandFingerprint(secondBody),
          body: secondBody,
        }),
      ).resolves.toEqual({ kind: 'GlobalEvidenceQuotaExceeded' });
      expect(await database.collection(evidenceCollectionNames.events).countDocuments()).toBe(2);
      expect(
        decodeEvidenceStreamDocument(
          await database
            .collection<EvidenceStreamDocument>(evidenceCollectionNames.streams)
            .findOne({ _id: streamId }),
        ).cursor,
      ).toEqual(cursorBeforeRollback.cursor);

      await database.collection<EvidenceUsageDocument>(evidenceCollectionNames.usage).updateOne(
        { _id: evidenceUsageDocumentId },
        {
          $set: {
            acceptedBytes: bytes.byteLength + firstBody.batch.encodedByteCount,
          },
        },
      );
      const receipt = preparePublicVerifierReceipt({
        version: 1,
        completionConditionId: 'public-check',
        commandSaid: `E${'p'.repeat(43)}`,
        recordedAt: '2026-09-24T20:00:20.000Z',
        outcome: { kind: 'Unresolved', reason: 'RunBlocked' },
      });
      if (receipt.kind !== 'Prepared') {
        throw new Error('verifier receipt fixture failed');
      }
      const preparedCheckpoint = prepareVerifiedCheckpoint(
        {
          version: 1,
          taskId,
          taskRevisionSaid: leased.run.binding.taskRevisionSaid,
          runId,
          incarnationId,
          harnessRevisionSaid: leased.run.binding.initialHarnessRevisionSaid,
          harnessLineageId,
          personalAgentAid,
          governorAid: leased.run.binding.governorAid,
          taskMandateSaid,
          promotionMandateSaid: leased.run.binding.promotionMandateSaid,
          purpose: leased.run.binding.purpose,
          repository: {
            objectFormat: 'sha1',
            baseCommit: leased.run.binding.repository.commit,
            baseTree: leased.run.binding.repository.tree,
            changedFiles: [],
          },
          outputArtifactSaids: outputEvent === 'EffectFailed' ? [preparedArtifact.artifact.d] : [],
          verifierReceipts: [receipt.receipt],
          evidence: { eventCount: 3, finalSequence: 2, chainHeadSaid: continued.d },
          budget: {
            consumed: { ...leased.run.consumedBudget, providerOutputTokens },
            remaining: {
              ...leased.run.binding.budget,
              providerOutputTokens: Math.max(
                0,
                leased.run.binding.budget.providerOutputTokens - providerOutputTokens,
              ),
            },
          },
          runState: {
            kind: 'Active',
            phase: { kind: 'Blocked', reason: blockReason },
            verification: { kind: 'NotSubmitted' },
          },
          continuation:
            blockReason === 'BudgetExhausted'
              ? { kind: 'ExternalResolutionRequired', reason: blockReason }
              : { kind: 'LaterHarnessCompatibilityResolutionRequired' },
        },
        ['public-check'],
      );
      if (preparedCheckpoint.kind !== 'Prepared') {
        throw new Error(`checkpoint fixture failed: ${preparedCheckpoint.reason}`);
      }
      const checkpointBody = { ...secondBody, checkpoint: preparedCheckpoint.checkpoint };
      await expect(
        batches.accept({
          ...firstInput,
          commandFingerprint: evidenceBatchCommandFingerprint(checkpointBody),
          body: checkpointBody,
          receivedAt: '2026-09-24T20:01:02.000Z',
        }),
      ).resolves.toMatchObject({ kind: 'EvidenceBatchAccepted' });

      const beforeFailedSeal = decodeEvidenceStreamDocument(
        await database
          .collection<EvidenceStreamDocument>(evidenceCollectionNames.streams)
          .findOne({ _id: streamId }),
      );
      const seals = new MongoEvidenceSeals(client, database);
      const sealInput = {
        ownerAid,
        runId,
        expectedRunVersion: leased.run.version,
        expectedStreamVersion: beforeFailedSeal.version,
        exchangeSaid: `E${'s'.repeat(43)}`,
        sealedAt: '2026-09-24T20:01:03.000Z',
      };
      await expect(
        seals.commit({ ...sealInput, expectedRunVersion: leased.run.version + 10 }),
      ).resolves.toEqual({ kind: 'EvidenceCursorConcurrentUpdate' });
      expect(
        decodeEvidenceStreamDocument(
          await database
            .collection<EvidenceStreamDocument>(evidenceCollectionNames.streams)
            .findOne({ _id: streamId }),
        ).seal,
      ).toEqual({ kind: 'Open' });

      await expect(seals.commit(sealInput)).resolves.toMatchObject({
        kind: 'EvidenceStreamSealed',
      });
      const settledRun = decodeRunDocument(
        await database.collection<RunDocument>(runsCollectionName).findOne({ _id: runId }),
      ).run;
      expect(settledRun.lifecycle).toEqual({
        kind: 'Active',
        phase: {
          kind: 'Blocked',
          reason: blockReason,
          checkpointSaid: preparedCheckpoint.checkpoint.d,
        },
      });
      expect(settledRun.consumedBudget.providerOutputTokens).toBe(providerOutputTokens);
      expect(settledRun.binding.budget).toEqual(leased.run.binding.budget);
      expect(settledRun.submissionVerification).toEqual({ kind: 'NotSubmitted' });
      expect(
        decodeTaskDocument(
          await database.collection<TaskDocument>(tasksCollectionName).findOne({ _id: taskId }),
        ).task.lifecycle,
      ).toEqual({ kind: 'Open' });
      const sealedStream = decodeEvidenceStreamDocument(
        await database
          .collection<EvidenceStreamDocument>(evidenceCollectionNames.streams)
          .findOne({ _id: streamId }),
      );
      expect(sealedStream.seal).toEqual({
        kind: 'Sealed',
        exchangeSaid: sealInput.exchangeSaid,
        sealedAt: sealInput.sealedAt,
      });
      await expect(
        seals.commit({
          ...sealInput,
          expectedRunVersion: settledRun.version,
          expectedStreamVersion: sealedStream.version,
        }),
      ).resolves.toMatchObject({ kind: 'EvidenceStreamAlreadySealed' });
    },
  );

  it('accepts the next calibration Run first batch after sealing a prior Run on the same Task', async () => {
    if (client === undefined) throw new Error('MongoDB URI disappeared');
    const database = client.db(databaseName);
    await database.dropDatabase();
    await new MongoTaskBootstrap(database).bootstrap();
    await new MongoRunBootstrap(database).bootstrap();
    await new MongoEvidenceBootstrap(database).bootstrap();

    const taskCommand = taskCommandFixture('2026-09-24T23:00:00.000Z');
    const taskId = randomUUID();
    const harnessLineageId = randomUUID();
    const task = openTask({
      taskId,
      ownerAid,
      label: taskCommand.label,
      harnessLineageId,
      revisionSaid: taskCommand.revision.d,
      commandId: taskCommand.commandId,
      createdAt: '2026-09-24T20:00:00.000Z',
    });
    await database.collection<TaskDocument>(tasksCollectionName).insertOne(
      encodeTaskDocument(
        projectTask(task, taskCommand.revision),
        taskCommandFingerprint(taskCommand),
        {
          ownerSlot: 0,
          globalSlot: 0,
        },
      ),
    );

    const campaignId = randomUUID();
    const firstRunId = randomUUID();
    const firstAcceptedAt = '2026-09-24T20:00:00.000Z';
    function calibrationRun(ordinal: 1 | 2, acceptedAt: string) {
      const runId = ordinal === 1 ? firstRunId : randomUUID();
      const created = createRun({
        runId,
        ownerAid,
        taskId,
        taskRevisionSaid: taskCommand.revision.d,
        harnessLineageId,
        personalAgentAid,
        taskMandateSaid,
        governorAid: `E${'g'.repeat(43)}`,
        promotionMandateSaid: `E${'h'.repeat(43)}`,
        initialHarnessRevisionSaid: `E${'b'.repeat(43)}`,
        purpose: { kind: 'PreparedCompatibilityCalibration', campaignId, ordinal },
        initialSpecialization: {
          kind: 'InitialSpecializationAccepted',
          harnessLineageId,
          harnessRevisionSaid: `E${'b'.repeat(43)}`,
          runId: firstRunId,
          acceptedAt: firstAcceptedAt,
        },
        repository: { objectFormat: 'sha1', commit: '1'.repeat(40), tree: '2'.repeat(40) },
        commandId: randomUUID(),
        admissionExchangeSaid: `E${String(ordinal).repeat(43)}`,
        evidenceStreamId: randomUUID(),
        budget: taskBudgetCeilings,
        acceptedAt,
      });
      if (created.kind !== 'Created') {
        throw new Error(`calibration Run creation failed: ${created.reason}`);
      }
      const leased = acquireFirstRunLease(created.run, {
        incarnationId: randomUUID(),
        expectedRunVersion: 0,
        serverTime: acceptedAt,
      });
      if (leased.kind !== 'Acquired') throw new Error('calibration lease acquisition failed');
      return leased.run;
    }

    const first = calibrationRun(1, firstAcceptedAt);
    await database
      .collection<RunDocument>(runsCollectionName)
      .insertOne(encodeRunDocument(first, `sha256:${'1'.repeat(64)}`));
    const started = event(
      first,
      0,
      { kind: 'Genesis' },
      {
        kind: 'RunStarted',
        fromRunVersion: first.version,
      },
    );
    const incarnation = event(
      first,
      1,
      { kind: 'Previous', eventSaid: started.d },
      {
        kind: 'IncarnationStarted',
      },
    );
    const firstBody = batch(first, [started, incarnation]);
    if (first.lease.kind !== 'Held') throw new Error('first Run lease disappeared');
    const checkpoint = prepareVerifiedCheckpoint(
      {
        version: 1,
        taskId,
        taskRevisionSaid: first.binding.taskRevisionSaid,
        runId: first.binding.runId,
        incarnationId: first.lease.incarnationId,
        harnessRevisionSaid: first.binding.initialHarnessRevisionSaid,
        harnessLineageId,
        personalAgentAid,
        governorAid: first.binding.governorAid,
        taskMandateSaid,
        promotionMandateSaid: first.binding.promotionMandateSaid,
        purpose: first.binding.purpose,
        repository: {
          objectFormat: 'sha1',
          baseCommit: first.binding.repository.commit,
          baseTree: first.binding.repository.tree,
          changedFiles: [],
        },
        outputArtifactSaids: [],
        verifierReceipts: [],
        evidence: { eventCount: 2, finalSequence: 1, chainHeadSaid: incarnation.d },
        budget: {
          consumed: first.consumedBudget,
          remaining: first.binding.budget,
        },
        runState: {
          kind: 'Ended',
          outcome: { kind: 'CalibrationExcluded', reason: 'ProviderUnavailable' },
          verification: { kind: 'NotSubmitted' },
        },
        continuation: { kind: 'NoContinuation' },
      },
      ['public-check'],
    );
    if (checkpoint.kind !== 'Prepared') throw new Error('first checkpoint preparation failed');
    const batches = new MongoEvidenceBatches(client, database);
    await expect(
      batches.accept({
        ownerAid,
        expectedRunVersion: first.version,
        commandFingerprint: evidenceBatchCommandFingerprint({
          ...firstBody,
          checkpoint: checkpoint.checkpoint,
        }),
        body: { ...firstBody, checkpoint: checkpoint.checkpoint },
        receivedAt: '2026-09-24T20:00:15.000Z',
      }),
    ).resolves.toMatchObject({ kind: 'EvidenceBatchAccepted' });
    const firstStream = decodeEvidenceStreamDocument(
      await database
        .collection<EvidenceStreamDocument>(evidenceCollectionNames.streams)
        .findOne({ _id: first.binding.evidenceStreamId }),
    );
    await expect(
      new MongoEvidenceSeals(client, database).commit({
        ownerAid,
        runId: first.binding.runId,
        expectedRunVersion: first.version,
        expectedStreamVersion: firstStream.version,
        exchangeSaid: `E${'s'.repeat(43)}`,
        sealedAt: '2026-09-24T20:00:16.000Z',
      }),
    ).resolves.toMatchObject({ kind: 'EvidenceStreamSealed' });
    await expect(
      database
        .collection<RunDocument>(runsCollectionName)
        .countDocuments({ activeOwnerSlot: ownerAid }),
    ).resolves.toBe(0);

    const second = calibrationRun(2, '2026-09-24T20:00:17.000Z');
    await database
      .collection<RunDocument>(runsCollectionName)
      .insertOne(encodeRunDocument(second, `sha256:${'2'.repeat(64)}`));
    const secondStarted = event(
      second,
      0,
      { kind: 'Genesis' },
      { kind: 'RunStarted', fromRunVersion: second.version },
      '2026-09-24T20:00:18.000Z',
    );
    const secondIncarnation = event(
      second,
      1,
      { kind: 'Previous', eventSaid: secondStarted.d },
      { kind: 'IncarnationStarted' },
      '2026-09-24T20:00:19.000Z',
    );
    const secondBody = batch(second, [secondStarted, secondIncarnation]);
    expect(secondBody.batch.d).not.toBe(firstBody.batch.d);
    expect(secondStarted.d).not.toBe(started.d);
    const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
    await server.register(
      evidenceRoutes({
        access: {
          authorize: () => Promise.resolve({ kind: 'EvidenceAccessAuthorized', ownerAid }),
        },
        conversation: {
          admitArtifact: () => Promise.resolve({ kind: 'EvidenceRunNotFound' }),
          acceptBatch: (input) =>
            acceptEvidenceBatch(input, {
              contexts: new MongoEvidenceRunContexts(database),
              authority: { authorize: () => Promise.resolve({ kind: 'TaskNotFound' }) },
              batches,
            }),
          reconcileSeal: () => Promise.resolve({ kind: 'EvidenceRunNotFound' }),
          inspectTimeline: () => Promise.resolve({ kind: 'EvidenceRunNotFound' }),
        },
        now: () => '2026-09-24T20:00:20.000Z',
        newCorrelationId: randomUUID,
      }),
    );
    try {
      const response = await server.inject({
        method: 'PUT',
        url: `/api/runs/${second.binding.runId}/evidence-batches/${secondBody.batch.d}`,
        headers: {
          authorization: `Bearer A${'s'.repeat(42)}`,
          'content-type': 'application/json',
        },
        payload: secondBody,
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({
        runId: second.binding.runId,
        acceptedThroughSequence: 1,
      });
      await expect(
        database
          .collection(evidenceCollectionNames.batches)
          .countDocuments({ runId: second.binding.runId }),
      ).resolves.toBe(1);
      await expect(
        database
          .collection(evidenceCollectionNames.events)
          .countDocuments({ runId: second.binding.runId }),
      ).resolves.toBe(2);
      await expect(
        database
          .collection(evidenceCollectionNames.batches)
          .countDocuments({ runId: first.binding.runId }),
      ).resolves.toBe(1);
    } finally {
      await server.close();
    }
  }, 30_000);

  it('rejects a mismatched v2 marker pair before insert and accepts the exact blocked checkpoint', async () => {
    if (client === undefined) throw new Error('MongoDB URI disappeared');
    const database = client.db(databaseName);
    await database.dropDatabase();
    await new MongoTaskBootstrap(database).bootstrap();
    await new MongoRunBootstrap(database).bootstrap();
    await new MongoEvidenceBootstrap(database).bootstrap();
    const taskCommand = taskCommandFixture('2026-09-24T23:00:00.000Z');
    const taskId = '4df838a8-5109-49fd-bdad-805880a3ecee';
    const harnessLineageId = '5ebf49b9-df26-4a49-9194-da868f97cf9d';
    const task = openTask({
      taskId,
      ownerAid,
      label: taskCommand.label,
      harnessLineageId,
      revisionSaid: taskCommand.revision.d,
      commandId: taskCommand.commandId,
      createdAt: '2026-09-24T20:00:00.000Z',
    });
    await database.collection<TaskDocument>(tasksCollectionName).insertOne(
      encodeTaskDocument(
        projectTask(task, taskCommand.revision),
        taskCommandFingerprint(taskCommand),
        {
          ownerSlot: 0,
          globalSlot: 0,
        },
      ),
    );
    const created = createRun({
      runId,
      ownerAid,
      taskId,
      taskRevisionSaid: taskCommand.revision.d,
      harnessLineageId,
      personalAgentAid,
      taskMandateSaid,
      governorAid: `E${'g'.repeat(43)}`,
      promotionMandateSaid: `E${'h'.repeat(43)}`,
      initialHarnessRevisionSaid: `E${'b'.repeat(43)}`,
      purpose: { kind: 'Retained' },
      initialSpecialization: {
        kind: 'InitialSpecializationAccepted',
        harnessLineageId,
        harnessRevisionSaid: `E${'b'.repeat(43)}`,
        runId: 'ff6774df-9797-4295-8e74-a974819babec',
        acceptedAt: '2026-09-24T19:55:00.000Z',
      },
      repository: { objectFormat: 'sha1', commit: '1'.repeat(40), tree: '2'.repeat(40) },
      commandId: 'd2c9160a-58f8-4d43-ae67-22124c6e9112',
      admissionExchangeSaid: `E${'i'.repeat(43)}`,
      evidenceStreamId: streamId,
      budget: taskBudgetCeilings,
      acceptedAt: '2026-09-24T20:00:00.000Z',
    });
    if (created.kind !== 'Created') throw new Error('Run fixture creation failed');
    const leased = acquireFirstRunLease(created.run, {
      incarnationId,
      expectedRunVersion: 0,
      serverTime: '2026-09-24T20:00:00.000Z',
    });
    if (leased.kind !== 'Acquired') throw new Error('Run fixture lease failed');
    await database
      .collection<RunDocument>(runsCollectionName)
      .insertOne(encodeRunDocument(leased.run, `sha256:${'c'.repeat(64)}`));
    const started = event(
      leased.run,
      0,
      { kind: 'Genesis' },
      {
        kind: 'RunStarted',
        fromRunVersion: leased.run.version,
      },
    );
    const disclosure = { kind: 'WithheldSecret', reason: 'Credential', byteLength: 43 } as const;
    const withheld = privacyEvent(
      leased.run,
      1,
      { kind: 'Previous', eventSaid: started.d },
      { kind: 'DataWithheld', disposition: disclosure },
    );
    const violation = privacyEvent(
      leased.run,
      2,
      { kind: 'Previous', eventSaid: withheld.d },
      { kind: 'SecurityViolation', violation: 'SecretDetected' },
    );
    const body = batch(leased.run, [started, withheld, violation]);
    const receipt = preparePublicVerifierReceipt({
      version: 1,
      completionConditionId: 'public-check',
      commandSaid: `E${'p'.repeat(43)}`,
      recordedAt: '2026-09-24T20:00:20.000Z',
      outcome: { kind: 'Unresolved', reason: 'RunBlocked' },
    });
    if (receipt.kind !== 'Prepared') throw new Error('receipt fixture failed');
    const draft = (byteLength: number) => ({
      version: 2 as const,
      taskId,
      taskRevisionSaid: leased.run.binding.taskRevisionSaid,
      runId,
      incarnationId,
      harnessRevisionSaid: leased.run.binding.initialHarnessRevisionSaid,
      harnessLineageId,
      personalAgentAid,
      governorAid: leased.run.binding.governorAid,
      taskMandateSaid,
      promotionMandateSaid: leased.run.binding.promotionMandateSaid,
      purpose: leased.run.binding.purpose,
      repository: {
        objectFormat: 'sha1' as const,
        baseCommit: leased.run.binding.repository.commit,
        baseTree: leased.run.binding.repository.tree,
        repositoryMeasurement: {
          kind: 'UnavailableBecauseSecret' as const,
          disclosure: { ...disclosure, byteLength },
          dataWithheldEventSaid: withheld.d,
          securityViolationEventSaid: violation.d,
        },
      },
      outputArtifactSaids: [],
      verifierReceipts: [receipt.receipt],
      evidence: { eventCount: 3, finalSequence: 2, chainHeadSaid: violation.d },
      budget: {
        consumed: leased.run.consumedBudget,
        remaining: leased.run.binding.budget,
      },
      runState: {
        kind: 'Active' as const,
        phase: { kind: 'Blocked' as const, reason: 'SecretDetected' as const },
        verification: { kind: 'NotSubmitted' as const },
      },
      continuation: {
        kind: 'ExternalResolutionRequired' as const,
        reason: 'SecretDetected' as const,
      },
    });
    const mismatched = prepareVerifiedCheckpoint(draft(44), ['public-check']);
    const exact = prepareVerifiedCheckpoint(draft(43), ['public-check']);
    if (mismatched.kind !== 'Prepared' || exact.kind !== 'Prepared') {
      throw new Error('v2 fixture checkpoint failed');
    }
    const batches = new MongoEvidenceBatches(client, database);
    const input = {
      ownerAid,
      expectedRunVersion: leased.run.version,
      receivedAt: '2026-09-24T20:01:00.000Z',
    };
    const mismatchedBody = { ...body, checkpoint: mismatched.checkpoint };
    await expect(
      batches.accept({
        ...input,
        commandFingerprint: evidenceBatchCommandFingerprint(mismatchedBody),
        body: mismatchedBody,
      }),
    ).resolves.toEqual({ kind: 'EvidenceBatchRejected', reason: 'CheckpointBindingMismatch' });
    expect(await database.collection(evidenceCollectionNames.events).countDocuments()).toBe(0);
    const exactBody = { ...body, checkpoint: exact.checkpoint };
    await expect(
      batches.accept({
        ...input,
        commandFingerprint: evidenceBatchCommandFingerprint(exactBody),
        body: exactBody,
      }),
    ).resolves.toMatchObject({ kind: 'EvidenceBatchAccepted' });
    expect(await database.collection(evidenceCollectionNames.checkpoints).countDocuments()).toBe(1);
  });
});
