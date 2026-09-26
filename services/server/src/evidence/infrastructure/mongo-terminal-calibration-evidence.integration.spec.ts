import { randomUUID } from 'node:crypto';

import { type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify from 'fastify';
import { MongoClient } from 'mongodb';
import Value from 'typebox/value';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { acquireFirstRunLease, createRun, openTask, type Run } from '@devrandom/domain';
import {
  evidenceBatchCommandFingerprint,
  prepareEvidenceBatch,
  prepareEvidenceEvent,
  prepareVerifiedCheckpoint,
  preparePublicVerifierReceipt,
  taskBudgetCeilings,
  taskCommandFingerprint,
  terminalCalibrationReconciliationBodySchema,
  type EvidenceEvent,
  type EvidenceEventDetail,
} from '@devrandom/protocol';

import { projectTask } from '../../task/application/task-projection.js';
import { tasksCollectionName } from '../../task/infrastructure/mongo-tasks.js';
import { encodeTaskDocument, type TaskDocument } from '../../task/infrastructure/task-document.js';
import { taskCommandFixture } from '../../task/test/task-command-fixture.js';
import { runsCollectionName } from '../../run/infrastructure/mongo-runs.js';
import { encodeRunDocument, type RunDocument } from '../../run/infrastructure/run-document.js';
import { terminalCalibrationRoutes } from '../route/terminal-calibration-routes.js';
import { MongoEvidenceBatches } from './mongo-evidence-batches.js';
import { MongoEvidenceBootstrap } from './mongo-evidence-bootstrap.js';
import { MongoEvidenceSeals } from './mongo-evidence-seals.js';
import { evidenceCollectionNames } from './evidence-storage-contract.js';
import {
  decodeEvidenceStreamDocument,
  type EvidenceStreamDocument,
} from './evidence-stream-document.js';
import { MongoTerminalCalibrationEvidence } from './mongo-terminal-calibration-evidence.js';

const uri = process.env['DEVRANDOM_MONGODB_URI'];
const describeMongo = uri === undefined ? describe.skip : describe;
const ownerAid = `E${'a'.repeat(43)}`;
const personalAgentAid = `E${'e'.repeat(43)}`;
const mandateSaid = `E${'f'.repeat(43)}`;
const runId = '1cc482f1-98e9-4454-8e4c-5566cb47ce3d';
const incarnationId = 'b5c5f13e-63df-4a4f-b1fc-08df00150f15';
const postExpiry = '2026-09-24T20:01:00.000Z';

function event(
  run: Run,
  sequence: number,
  predecessor: EvidenceEvent['predecessor'],
  detail: EvidenceEventDetail,
  producer: EvidenceEvent['producer'],
  recordedAt: string,
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
    taskMandateSaid: mandateSaid,
    occurredAt: recordedAt,
    recordedAt,
    producer,
    event: detail,
  });
  if (prepared.kind !== 'Prepared') throw new Error(`Event fixture: ${prepared.reason}`);
  return prepared.event;
}

function body(run: Run, events: readonly EvidenceEvent[]) {
  const prepared = prepareEvidenceBatch({
    version: 1,
    runId: run.binding.runId,
    evidenceStreamId: run.binding.evidenceStreamId,
    events: [...events],
  });
  if (prepared.kind !== 'Prepared') throw new Error(`Batch fixture: ${prepared.reason}`);
  return { version: 1 as const, batch: prepared.batch, events: [...events] };
}

describeMongo('terminal calibration Fastify and replica Mongo boundary', () => {
  const client = uri === undefined ? undefined : new MongoClient(uri);
  const databaseName = `devrandom_terminal_calibration_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    await client?.connect();
  });
  afterAll(async () => {
    if (client !== undefined) {
      await client.db(databaseName).dropDatabase();
      await client.close();
    }
  });

  it.each(['BudgetExhausted', 'Cancelled'] as const)(
    'rejects expired effects and stale/wrong terminal requests, then seals exact %s bookkeeping',
    async (disposition) => {
      const cancellation = disposition === 'Cancelled';
      if (client === undefined) throw new Error('Mongo URI unavailable');
      const database = client.db(databaseName);
      await database.dropDatabase();
      await new MongoEvidenceBootstrap(database).bootstrap();
      const taskCommand = taskCommandFixture(
        cancellation ? '2026-09-24T20:00:30.000Z' : '2026-09-24T23:00:00.000Z',
      );
      const taskId = '4df838a8-5109-49fd-bdad-805880a3ecee';
      const lineageId = '5ebf49b9-df26-4a49-9194-da868f97cf9d';
      const task = openTask({
        taskId,
        ownerAid,
        label: taskCommand.label,
        harnessLineageId: lineageId,
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
        harnessLineageId: lineageId,
        personalAgentAid,
        taskMandateSaid: mandateSaid,
        governorAid: `E${'g'.repeat(43)}`,
        promotionMandateSaid: `E${'h'.repeat(43)}`,
        initialHarnessRevisionSaid: `E${'b'.repeat(43)}`,
        purpose: { kind: 'PreparedCompatibilityCalibration', campaignId: randomUUID(), ordinal: 2 },
        initialSpecialization: {
          kind: 'InitialSpecializationAccepted',
          harnessLineageId: lineageId,
          harnessRevisionSaid: `E${'b'.repeat(43)}`,
          runId: 'ff6774df-9797-4295-8e74-a974819babec',
          acceptedAt: '2026-09-24T19:55:00.000Z',
        },
        repository: { objectFormat: 'sha1', commit: '1'.repeat(40), tree: '2'.repeat(40) },
        commandId: randomUUID(),
        admissionExchangeSaid: `E${'i'.repeat(43)}`,
        evidenceStreamId: randomUUID(),
        budget: taskBudgetCeilings,
        acceptedAt: '2026-09-24T20:00:00.000Z',
      });
      if (created.kind !== 'Created') throw new Error(`Run fixture: ${created.reason}`);
      const leased = acquireFirstRunLease(created.run, {
        incarnationId,
        expectedRunVersion: 0,
        serverTime: '2026-09-24T20:00:00.000Z',
      });
      if (leased.kind !== 'Acquired') throw new Error('Lease fixture failed');
      const run = leased.run;
      await database
        .collection<RunDocument>(runsCollectionName)
        .insertOne(encodeRunDocument(run, `sha256:${'c'.repeat(64)}`));
      const started = event(
        run,
        0,
        { kind: 'Genesis' },
        { kind: 'RunStarted', fromRunVersion: run.version },
        { kind: 'RunSupervisor' },
        '2026-09-24T20:00:10.000Z',
      );
      const incarnation = event(
        run,
        1,
        { kind: 'Previous', eventSaid: started.d },
        { kind: 'IncarnationStarted' },
        { kind: 'RunSupervisor' },
        '2026-09-24T20:00:11.000Z',
      );
      const ordinary = body(run, [started, incarnation]);
      await expect(
        new MongoEvidenceBatches(client, database).accept({
          ownerAid,
          expectedRunVersion: run.version,
          commandFingerprint: evidenceBatchCommandFingerprint(ordinary),
          body: ordinary,
          receivedAt: '2026-09-24T20:00:12.000Z',
        }),
      ).resolves.toMatchObject({ kind: 'EvidenceBatchAccepted' });
      // These original records were produced while the lease was live. Delivery may
      // be delayed without inventing a new incarnation or changing their content.
      const failure = event(
        run,
        2,
        { kind: 'Previous', eventSaid: incarnation.d },
        {
          kind: 'EffectFailed',
          piSessionId: incarnationId,
          modelTurnId: 'turn-1',
          toolCallId: 'call-1',
          proposalIndex: 0,
          tool: 'run_tests',
          requiredCapability: 'RunTests',
          resource: 'cargo test',
          failure: 'BudgetExhausted',
          outputArtifactSaids: [],
        },
        { kind: 'ToolGateway' },
        '2026-09-24T20:00:20.000Z',
      );
      const pendingDebit = event(
        run,
        3,
        { kind: 'Previous', eventSaid: failure.d },
        { kind: 'BudgetDebited', budget: 'runWallTimeSeconds', amount: 85, consumed: 85 },
        { kind: 'RunSupervisor' },
        '2026-09-24T20:00:21.000Z',
      );
      const pending = body(run, [failure, pendingDebit]);
      await expect(
        new MongoEvidenceBatches(client, database).accept({
          ownerAid,
          expectedRunVersion: run.version,
          commandFingerprint: evidenceBatchCommandFingerprint(pending),
          body: pending,
          receivedAt: '2026-09-24T20:01:01.000Z',
        }),
      ).resolves.toMatchObject({ kind: 'EvidenceBatchAccepted' });
      const expiredEffect = event(
        run,
        4,
        { kind: 'Previous', eventSaid: pendingDebit.d },
        {
          kind: 'ToolProposed',
          piSessionId: incarnationId,
          modelTurnId: 'turn-1',
          toolCallId: 'call-1',
          proposalIndex: 0,
          tool: 'run_tests',
          requiredCapability: 'RunTests',
          resource: 'cargo test',
        },
        { kind: 'ToolGateway' },
        postExpiry,
      );
      const effectBody = body(run, [expiredEffect]);
      expect(effectBody.batch.predecessor).toEqual({ kind: 'Previous', eventSaid: pendingDebit.d });
      await expect(
        new MongoEvidenceBatches(client, database).accept({
          ownerAid,
          expectedRunVersion: run.version,
          commandFingerprint: evidenceBatchCommandFingerprint(effectBody),
          body: effectBody,
          receivedAt: '2026-09-24T20:01:01.000Z',
        }),
      ).resolves.toEqual({ kind: 'EvidenceBatchRejected', reason: 'EventBindingMismatch' });
      const reconciliation = new MongoTerminalCalibrationEvidence(client, database);
      let currentOwner = ownerAid;
      const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
      server.register(
        terminalCalibrationRoutes({
          access: {
            authorize: () =>
              Promise.resolve({ kind: 'EvidenceAccessAuthorized', ownerAid: currentOwner }),
          },
          reconciliation,
          now: () => '2026-09-24T20:01:01.000Z',
          newCorrelationId: () => randomUUID(),
        }),
      );
      await server.listen({ host: '127.0.0.1', port: 0 });
      try {
        const address = server.server.address();
        if (address === null || typeof address === 'string')
          throw new Error('Fastify failed to listen');
        const endpoint = `http://127.0.0.1:${String(address.port)}/api/runs/${runId}/evidence-terminal-reconciliation`;
        const post = (command: unknown) =>
          fetch(endpoint, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${'s'.repeat(43)}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify(command),
          });
        expect((await post({ version: 1 })).status).toBe(400);
        const initialExpected = {
          incarnationId,
          runStartedSaid: started.d,
          acceptedThroughSequence: 3,
          chainHeadSaid: pendingDebit.d,
        };
        expect(
          (
            await fetch(endpoint, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ version: 1, expected: initialExpected, body: effectBody }),
            })
          ).status,
        ).toBe(401);
        expect(
          Value.Check(terminalCalibrationReconciliationBodySchema, {
            version: 1,
            expected: initialExpected,
            body: effectBody,
          }),
        ).toBe(true);
        const rejectedEffect = await post({
          version: 1,
          expected: initialExpected,
          body: effectBody,
        });
        expect(rejectedEffect.status, await rejectedEffect.text()).toBe(422);
        const overrun = cancellation ? 5 : run.binding.budget.changedWorktreeBytes + 1;
        const debit = event(
          run,
          4,
          { kind: 'Previous', eventSaid: pendingDebit.d },
          {
            kind: 'BudgetDebited',
            budget: 'changedWorktreeBytes',
            amount: overrun,
            consumed: overrun,
          },
          { kind: 'EvidenceRecorder' },
          postExpiry,
        );
        const checkpoint = prepareVerifiedCheckpoint(
          {
            version: 1,
            taskId,
            taskRevisionSaid: run.binding.taskRevisionSaid,
            runId,
            incarnationId,
            harnessRevisionSaid: run.binding.initialHarnessRevisionSaid,
            harnessLineageId: lineageId,
            personalAgentAid,
            governorAid: run.binding.governorAid,
            taskMandateSaid: mandateSaid,
            promotionMandateSaid: run.binding.promotionMandateSaid,
            purpose: run.binding.purpose,
            repository: {
              objectFormat: 'sha1',
              baseCommit: run.binding.repository.commit,
              baseTree: run.binding.repository.tree,
              changedFiles: [],
            },
            outputArtifactSaids: [],
            verifierReceipts: cancellation
              ? taskCommand.revision.completionConditions.map((condition) => {
                  const receipt = preparePublicVerifierReceipt({
                    version: 1,
                    completionConditionId: condition.id,
                    commandSaid: `E${'j'.repeat(43)}`,
                    recordedAt: postExpiry,
                    outcome: { kind: 'Unresolved', reason: 'NotAttempted' },
                  });
                  if (receipt.kind !== 'Prepared') throw new Error('receipt');
                  return receipt.receipt;
                })
              : [],
            evidence: { eventCount: 5, finalSequence: 4, chainHeadSaid: debit.d },
            budget: {
              consumed: {
                ...run.consumedBudget,
                runWallTimeSeconds: 85,
                changedWorktreeBytes: overrun,
              },
              remaining: {
                ...run.binding.budget,
                runWallTimeSeconds: run.binding.budget.runWallTimeSeconds - 85,
                changedWorktreeBytes: Math.max(
                  0,
                  run.binding.budget.changedWorktreeBytes - overrun,
                ),
              },
            },
            runState: {
              kind: 'Ended',
              outcome: cancellation
                ? { kind: 'Cancelled' }
                : { kind: 'CalibrationExcluded', reason: 'BudgetExhausted' },
              verification: { kind: 'NotSubmitted' },
            },
            continuation: { kind: 'NoContinuation' },
          },
          taskCommand.revision.completionConditions.map((condition) => condition.id),
        );
        if (checkpoint.kind !== 'Prepared')
          throw new Error(`Checkpoint fixture: ${checkpoint.reason}`);
        const verified = event(
          run,
          5,
          { kind: 'Previous', eventSaid: debit.d },
          { kind: 'CheckpointVerified', checkpointSaid: checkpoint.checkpoint.d },
          { kind: 'EvidenceRecorder' },
          postExpiry,
        );
        const calibrated = event(
          run,
          6,
          { kind: 'Previous', eventSaid: verified.d },
          {
            kind: 'RunCalibrationRecorded',
            checkpointSaid: checkpoint.checkpoint.d,
            disposition: { kind: 'Excluded', reason: 'BudgetExhausted' },
          },
          { kind: 'RunSupervisor' },
          postExpiry,
        );
        const terminal = {
          ...body(run, cancellation ? [debit, verified] : [debit, verified, calibrated]),
          checkpoint: checkpoint.checkpoint,
        };
        expect(
          (
            await post({
              version: 1,
              expected: { ...initialExpected, chainHeadSaid: `E${'z'.repeat(43)}` },
              body: terminal,
            })
          ).status,
        ).toBe(409);
        const wrongIncarnation = 'cf6774df-9797-4295-8e74-a974819babec';
        expect(
          (
            await post({
              version: 1,
              expected: { ...initialExpected, incarnationId: wrongIncarnation },
              body: terminal,
            })
          ).status,
        ).toBe(409);
        currentOwner = `E${'o'.repeat(43)}`;
        expect((await post({ version: 1, expected: initialExpected, body: terminal })).status).toBe(
          404,
        );
        currentOwner = ownerAid;
        const accepted = await post({ version: 1, expected: initialExpected, body: terminal });
        expect(accepted.status, await accepted.clone().text()).toBe(201);
        const acceptedBody: unknown = await accepted.json();
        expect(acceptedBody).toMatchObject({
          batchSaid: terminal.batch.d,
          acceptedThroughSequence: cancellation ? 5 : 6,
        });
        expect((await post({ version: 1, expected: initialExpected, body: terminal })).status).toBe(
          200,
        );
        const acknowledgement = event(
          run,
          cancellation ? 6 : 7,
          { kind: 'Previous', eventSaid: cancellation ? verified.d : calibrated.d },
          { kind: 'CheckpointAccepted', checkpointSaid: checkpoint.checkpoint.d },
          { kind: 'EvidenceRecorder' },
          postExpiry,
        );
        const finalBody = body(run, [acknowledgement]);
        expect(
          (
            await post({
              version: 1,
              expected: {
                ...initialExpected,
                acceptedThroughSequence: cancellation ? 5 : 6,
                chainHeadSaid: cancellation ? verified.d : calibrated.d,
              },
              body: finalBody,
            })
          ).status,
        ).toBe(201);
        const stream = decodeEvidenceStreamDocument(
          await database
            .collection<EvidenceStreamDocument>(evidenceCollectionNames.streams)
            .findOne({ _id: run.binding.evidenceStreamId }),
        );
        expect(stream.cursor).toMatchObject({
          kind: 'Continued',
          acceptedThrough: cancellation ? 6 : 7,
          chainHeadSaid: acknowledgement.d,
        });
        expect(stream.provisional).toMatchObject({
          kind: 'Checkpointed',
          checkpointSaid: checkpoint.checkpoint.d,
        });
        await expect(
          new MongoEvidenceSeals(client, database).commit({
            ownerAid,
            runId,
            expectedRunVersion: run.version,
            expectedStreamVersion: stream.version,
            exchangeSaid: `E${'s'.repeat(43)}`,
            sealedAt: '2026-09-24T20:01:02.000Z',
          }),
        ).resolves.toMatchObject({ kind: 'EvidenceStreamSealed' });
        const settled = await database
          .collection<RunDocument>(runsCollectionName)
          .findOne({ _id: runId });
        expect(settled?.lifecycle).toMatchObject({
          kind: 'Ended',
          outcome: { kind: cancellation ? 'Cancelled' : 'CalibrationExcluded' },
        });
        expect(settled).not.toHaveProperty('activeOwnerSlot');
        expect(settled).not.toHaveProperty('activeGlobalSlot');
      } finally {
        await server.close();
      }
    },
  );
});
