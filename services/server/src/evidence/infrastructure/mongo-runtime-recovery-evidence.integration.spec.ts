import {
  encodeEvidenceCheckpointDocument,
  type EvidenceCheckpointDocument,
} from './evidence-checkpoint-document.js';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { MongoClient } from 'mongodb';
import { describe, it, expect } from 'vitest';
import {
  prepareEvidenceEvent,
  prepareEvidenceBatch,
  harnessCommandFingerprint,
  authorizedTaskCommandFingerprint,
} from '@devrandom/protocol';
import { runtimeRecoveryFixture } from '../test/runtime-recovery-fixture.js';
import { runtimeRecoveryRoutes } from '../route/runtime-recovery-routes.js';
import { MongoRuntimeRecoveryEvidence } from './mongo-runtime-recovery-evidence.js';
import { MongoEvidenceBootstrap } from './mongo-evidence-bootstrap.js';
import { MongoRunContinuations } from '../../run/infrastructure/mongo-run-continuations.js';
import {
  encodeEvidenceArtifactDocument,
  type EvidenceArtifactDocument,
} from './evidence-artifact-document.js';
import { MongoEvidenceSeals } from './mongo-evidence-seals.js';
import {
  encodeRunDocument,
  decodeRunDocument,
  type RunDocument,
} from '../../run/infrastructure/run-document.js';
import { encodeTaskDocument, type TaskDocument } from '../../task/infrastructure/task-document.js';
import {
  encodeHarnessDocument,
  type HarnessDocument,
} from '../../harness/infrastructure/harness-document.js';
import {
  encodeEvidenceEventDocument,
  type EvidenceEventDocument,
} from './evidence-event-document.js';
import {
  encodeEvidenceStreamDocument,
  type EvidenceStreamDocument,
} from './evidence-stream-document.js';
import { evidenceCollectionNames } from './evidence-storage-contract.js';
import type { CurrentRunMandates } from '../../run/application/run-authority.js';

const uri = process.env.DEVRANDOM_MONGODB_URI;
const integration = uri === undefined ? describe.skip : describe;
integration('accounting-only ProcessLost reconciliation over HTTP and Mongo', () => {
  it('records and seals actual interrupted startup without execution, lease renewal, or budget reset', async () => {
    const client = new MongoClient(uri ?? 'mongodb://127.0.0.1:27017');
    const db = client.db(`devrandom_runtime_recovery_${randomUUID().replaceAll('-', '')}`);
    const server = Fastify();
    try {
      await client.connect();
      await new MongoEvidenceBootstrap(db).bootstrap();
      const fixture = runtimeRecoveryFixture();
      const {
        run,
        task,
        taskCommand,
        harness,
        stream,
        segment,
        acceptedEvents,
        body,
        expected,
        receivedAt,
      } = fixture;
      await db
        .collection<EvidenceCheckpointDocument>(evidenceCollectionNames.checkpoints)
        .insertOne(
          encodeEvidenceCheckpointDocument(
            {
              ownerAid: run.binding.ownerAid,
              evidenceStreamId: fixture.originalStream.binding.streamId,
              batchSaid: `E${'b'.repeat(43)}`,
              checkpoint: fixture.predecessorCheckpoint,
              receivedAt:
                fixture.predecessorCheckpoint.verifierReceipts[0]?.recordedAt ?? receivedAt,
            },
            fixture.completionConditionIds,
          ),
        );
      const fingerprint = `sha256:${'c'.repeat(64)}`;
      await db.collection<RunDocument>('runs').insertOne(encodeRunDocument(run, fingerprint));
      await db.collection<TaskDocument>('tasks').insertOne(
        encodeTaskDocument(task, authorizedTaskCommandFingerprint(taskCommand), {
          ownerSlot: 0,
          globalSlot: 0,
        }),
      );
      const initial = encodeHarnessDocument(
        {
          version: 1,
          ownerAid: run.binding.ownerAid,
          commandId: harness.commandId,
          acceptedAt: run.binding.acceptedAt,
          revision: harness.revision,
        },
        harnessCommandFingerprint(harness),
      );
      await db.collection<HarnessDocument>('harnessRevisions').insertOne({
        ...initial,
        activation: {
          ...run.binding.initialSpecialization,
          acceptedAt: new Date(run.binding.initialSpecialization.acceptedAt),
        },
      });
      await db
        .collection<{
          _id: string;
          ownerAid: string;
          runId: string;
          segment: typeof segment;
          acceptedAt: Date;
        }>('runSuccessorSegments')
        .insertOne({
          _id: segment.d,
          ownerAid: run.binding.ownerAid,
          runId: run.binding.runId,
          segment,
          acceptedAt: new Date(segment.admittedAt),
        });
      await db
        .collection<EvidenceStreamDocument>(evidenceCollectionNames.streams)
        .insertOne(encodeEvidenceStreamDocument(stream));
      await db.collection<EvidenceEventDocument>(evidenceCollectionNames.events).insertMany(
        acceptedEvents.map((event) =>
          encodeEvidenceEventDocument({
            ownerAid: run.binding.ownerAid,
            evidenceStreamId: stream.binding.streamId,
            batchSaid: `E${'b'.repeat(43)}`,
            event,
            receivedAt: segment.admittedAt,
          }),
        ),
      );
      await db
        .collection<EvidenceStreamDocument>(evidenceCollectionNames.streams)
        .insertOne(encodeEvidenceStreamDocument(fixture.originalStream));
      await db.collection<EvidenceArtifactDocument>(evidenceCollectionNames.artifacts).insertOne(
        encodeEvidenceArtifactDocument({
          ownerAid: run.binding.ownerAid,
          runId: run.binding.runId,
          evidenceStreamId: fixture.originalStream.binding.streamId,
          artifact: fixture.profile,
          bytes: fixture.profileBytes,
          acceptedAt: segment.admittedAt,
        }),
      );
      let revoked = false;
      const mandates: CurrentRunMandates = {
        authorize: () =>
          Promise.resolve(
            revoked
              ? { kind: 'TaskMandateRevoked' }
              : {
                  kind: 'CurrentRunMandatesAuthorized',
                  task,
                  personalAgentAid: run.binding.personalAgentAid,
                  taskMandateSaid: run.binding.taskMandateSaid,
                  taskMandateBudget: run.binding.budget,
                  governorAid: run.binding.governorAid,
                  promotionMandateSaid: run.binding.promotionMandateSaid,
                },
          ),
      };
      const writer = new MongoRuntimeRecoveryEvidence(client, db, mandates);
      const command = { version: 1 as const, expected, body };
      revoked = true;
      expect(
        await writer.reconcile({
          ownerAid: run.binding.ownerAid,
          runId: run.binding.runId,
          command,
          receivedAt,
        }),
      ).toMatchObject({ kind: 'EvidenceBatchRejected' });
      revoked = false;
      await server.register(
        runtimeRecoveryRoutes({
          access: {
            authorize: () =>
              Promise.resolve({ kind: 'EvidenceAccessAuthorized', ownerAid: run.binding.ownerAid }),
          },
          reconciliation: writer,
          now: () => receivedAt,
          newCorrelationId: randomUUID,
        }),
      );
      const address = await server.listen({ host: '127.0.0.1', port: 0 });
      const request = () =>
        fetch(`${address}/api/runs/${run.binding.runId}/evidence-runtime-reconciliation`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${'s'.repeat(43)}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(command),
        });
      expect((await request()).status).toBe(201);
      expect((await request()).status).toBe(200);
      const blocked = body.events[1];
      if (blocked === undefined) throw new Error('blocked fixture');
      // Preparing a new event never carries the previous event's digest.
      const ackDraft = {
        ...blocked,
        sequence: 6,
        predecessor: { kind: 'Previous' as const, eventSaid: blocked.d },
        occurredAt: receivedAt,
        recordedAt: receivedAt,
        producer: { kind: 'EvidenceRecorder' as const },
        event: { kind: 'CheckpointAccepted' as const, checkpointSaid: body.checkpoint.d },
      };
      const { d: oldDigest, ...draft } = ackDraft;
      expect(oldDigest).toBe(blocked.d);
      const preparedAck = prepareEvidenceEvent(draft);
      if (preparedAck.kind !== 'Prepared') throw new Error('ack fixture');
      const ackBatch = prepareEvidenceBatch({
        version: 1,
        runId: run.binding.runId,
        evidenceStreamId: stream.binding.streamId,
        events: [preparedAck.event],
      });
      if (ackBatch.kind !== 'Prepared') throw new Error('ack batch');
      expect(
        await writer.reconcile({
          ownerAid: run.binding.ownerAid,
          runId: run.binding.runId,
          receivedAt,
          command: {
            version: 1,
            expected: { ...expected, acceptedThroughSequence: 5, chainHeadSaid: blocked.d },
            body: { version: 1, batch: ackBatch.batch, events: [preparedAck.event] },
          },
        }),
      ).toMatchObject({ kind: 'EvidenceBatchAccepted' });
      const unchanged = await db
        .collection<RunDocument>('runs')
        .findOne({ _id: run.binding.runId });
      if (unchanged === null) throw new Error('Run missing');
      expect(decodeRunDocument(unchanged).run).toEqual(run);
      const sealed = await new MongoEvidenceSeals(client, db).commit({
        ownerAid: run.binding.ownerAid,
        runId: run.binding.runId,
        expectedRunVersion: run.version,
        expectedStreamVersion: 3,
        exchangeSaid: `E${'s'.repeat(43)}`,
        sealedAt: receivedAt,
      });
      expect(sealed.kind).toBe('EvidenceStreamSealed');
      const sealedRunDocument = await db
        .collection<RunDocument>('runs')
        .findOne({ _id: run.binding.runId });
      if (sealedRunDocument === null) throw new Error('sealed Run');
      const sealedRun = decodeRunDocument(sealedRunDocument).run;
      expect(sealedRun.lifecycle).toMatchObject({
        kind: 'Active',
        phase: { kind: 'Blocked', reason: 'ProcessLost' },
      });
      expect(sealedRun.consumedBudget.runWallTimeSeconds).toBe(274);
      const next = await new MongoRunContinuations(client, db).admit({
        ownerAid: run.binding.ownerAid,
        run: sealedRun,
        activation: {
          version: 1,
          kind: 'Initial',
          pointerVersion: 1,
          taskId: run.binding.taskId,
          taskRevisionSaid: run.binding.taskRevisionSaid,
          harnessLineageId: run.binding.harnessLineageId,
          activeRevisionSaid: run.binding.initialHarnessRevisionSaid,
        },
        observedAt: new Date().toISOString(),
        command: {
          version: 2,
          kind: 'CalibrationContinuation',
          expectedRunVersion: sealedRun.version,
          predecessorCheckpointSaid: body.checkpoint.d,
          predecessorSealSaid: `E${'s'.repeat(43)}`,
          predecessorHeadSaid: preparedAck.event.d,
          successorIncarnationId: randomUUID(),
          successorStreamId: randomUUID(),
          expectedHarnessRevisionSaid: run.binding.initialHarnessRevisionSaid,
        },
      });
      expect(next.kind).toBe('Admitted');
      if (next.kind !== 'Admitted') throw new Error('next continuation');
      expect(next.segment.predecessor.segmentSaid).toBe(segment.d);
      expect(next.run.consumedBudget).toEqual(sealedRun.consumedBudget);
    } finally {
      await server.close();
      await db.dropDatabase();
      await client.close();
    }
  });
});
