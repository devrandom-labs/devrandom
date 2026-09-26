import { randomUUID } from 'node:crypto';

import { MongoClient, type Db } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  acceptEvidenceBatch,
  createEvidenceStream,
  evaluationConsumables,
  sealEvidenceStream,
  type EvaluationAllowance,
} from '@devrandom/domain';
import {
  prepareEvaluationClosure,
  prepareEvidenceArtifact,
  preparePublicVerifierReceipt,
  prepareVerifiedCheckpoint,
  taskCommandFingerprint,
} from '@devrandom/protocol';

import { encodeEvidenceCheckpointDocument } from '../../evidence/infrastructure/evidence-checkpoint-document.js';
import { evidenceCollectionNames } from '../../evidence/infrastructure/evidence-storage-contract.js';
import { encodeEvidenceStreamDocument } from '../../evidence/infrastructure/evidence-stream-document.js';
import { encodeRunDocument } from '../../run/infrastructure/run-document.js';
import { runsCollectionName } from '../../run/infrastructure/mongo-runs.js';
import { runCommandFingerprint, runFixture } from '../../run/test/run-fixture.js';
import { encodeTaskDocument, type TaskDocument } from '../../task/infrastructure/task-document.js';
import { tasksCollectionName } from '../../task/infrastructure/mongo-tasks.js';
import { taskCommandFixture, taskOwnerAid } from '../../task/test/task-command-fixture.js';
import {
  evaluationCollectionNames,
  type EvaluationDocument,
} from './mongo-evaluation-reservations.js';
import { MongoTaskResidualAllowance } from './mongo-task-residual-allowance.js';

const taskId = '4df838a8-5109-49fd-bdad-805880a3ecee';
const evaluationId = 'f12ce50a-d0eb-4945-9978-691790351844';
const command = taskCommandFixture();
const taskRevisionSaid = command.revision.d;
const mandateCeiling = Object.fromEntries(
  evaluationConsumables.map((name) => [name, 30]),
) as EvaluationAllowance;

function taskDocument() {
  return encodeTaskDocument(
    {
      version: 1,
      taskId,
      ownerAid: taskOwnerAid,
      label: command.label,
      harnessLineageId: '5ebf49b9-df26-4a49-9194-da868f97cf9d',
      revisionSaid: taskRevisionSaid,
      revision: command.revision,
      lifecycle: { kind: 'Open' },
      commandId: command.commandId,
      createdAt: '2026-09-24T12:00:00.000Z',
      expectedVersion: 0,
    },
    taskCommandFingerprint(command),
    { ownerSlot: 0, globalSlot: 0 },
  );
}

function amount(value: number): EvaluationAllowance {
  return Object.fromEntries(
    evaluationConsumables.map((name) => [name, value]),
  ) as EvaluationAllowance;
}

function reservation(value = 5): EvaluationDocument {
  const reserved = amount(value);
  const admission = {
    version: 1 as const,
    commandId: '1b41cba8-9863-4136-b5bf-234351064905',
    fingerprint: `sha256:${'a'.repeat(64)}`,
    taskId,
    taskRevisionSaid,
    originRunId: 'e14e399e-76d7-4501-9f6d-d48cef2d6418',
    retainedCheckpointSaid: `E${'c'.repeat(43)}`,
    retainedSealSaid: `E${'s'.repeat(43)}`,
    expectedActiveRevisionSaid: `E${'h'.repeat(43)}`,
    personalAgentAid: `E${'a'.repeat(43)}`,
    taskMandateSaid: `E${'m'.repeat(43)}`,
    policySaid: `E${'p'.repeat(43)}`,
    executionProfileSaid: `E${'e'.repeat(43)}`,
    sourceInventorySaid: `E${'i'.repeat(43)}`,
    allocation: { diagnosis: amount(1), perEntry: amount(1), finalization: amount(1) },
  };
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      evaluationId,
      ownerAid: taskOwnerAid,
      commandId: admission.commandId,
      originRunId: admission.originRunId,
      reserved,
    }),
  );
  const prepared = prepareEvidenceArtifact(bytes, 'application/json');
  if (prepared.kind !== 'Prepared') throw new Error('reservation proof rejected');
  return {
    _id: evaluationId,
    ownerAid: taskOwnerAid,
    command: admission,
    reserved,
    reservationSaid: prepared.artifact.d,
    evidenceStreamId: '4cd43809-837d-4e64-a1a2-e7ed9b39bc8e',
    version: 1,
    lease: {
      evaluationId,
      leaseId: '5ca0f0f1-2281-4b06-93c6-c3d76dc12f92',
      version: 1,
      serverTime: '2026-09-24T12:00:00.000Z',
      expiresAt: '2026-09-24T12:05:00.000Z',
    },
    acceptedThroughSequence: -1,
    chainHeadSaid: null,
    acceptedBytes: 0,
    activeOwnerSlot: taskOwnerAid,
    acceptedAt: new Date('2026-09-24T12:00:00.000Z'),
  };
}

function closedEvaluation(consumed = amount(3)) {
  const held = { ...reservation() };
  Reflect.deleteProperty(held, 'activeOwnerSlot');
  const prepared = prepareEvaluationClosure({
    evaluationId,
    evidenceStreamId: held.evidenceStreamId,
    originRunId: held.command.originRunId,
    manifestSaid: `E${'m'.repeat(43)}`,
    acceptedEventCount: 42,
    acceptedHeadSaid: `E${'q'.repeat(43)}`,
    observationSaids: Array.from(
      { length: 18 },
      (_, index) => `E${String.fromCharCode(65 + index).repeat(43)}`,
    ),
    measurementSaids: Array.from(
      { length: 15 },
      (_, index) => `E${String.fromCharCode(97 + index).repeat(43)}`,
    ),
    sharedAuditSaid: `E${'u'.repeat(43)}`,
    armAuditSaids: {
      H1: `E${'a'.repeat(43)}`,
      C1: `E${'b'.repeat(43)}`,
      C2: `E${'c'.repeat(43)}`,
      C3: `E${'d'.repeat(43)}`,
      H1TaskSearch: `E${'e'.repeat(43)}`,
    },
    protectedCustodySaid: `E${'w'.repeat(43)}`,
    agentSealSaid: `E${'z'.repeat(43)}`,
  });
  if (prepared.kind !== 'Prepared') throw new Error('closure fixture rejected');
  const bytes = new TextEncoder().encode(
    JSON.stringify({ evaluationId, closureSaid: prepared.closure.d, consumed }),
  );
  const proof = prepareEvidenceArtifact(bytes, 'application/json');
  if (proof.kind !== 'Prepared') throw new Error('debit fixture rejected');
  return {
    ...held,
    closure: prepared.closure,
    settledDebit: { closureSaid: prepared.closure.d, consumed, artifactSaid: proof.artifact.d },
  };
}

function sealedRunProof() {
  const original = runFixture();
  const consumedBudget = { ...original.consumedBudget, providerRequests: 4 };
  const run = {
    ...original,
    binding: { ...original.binding, ownerAid: taskOwnerAid, taskRevisionSaid },
    consumedBudget,
  };
  const incarnationId = 'd9cb18e4-f4f8-4378-a852-353eef083d91';
  const chainHeadSaid = `E${'q'.repeat(43)}`;
  const receipt = preparePublicVerifierReceipt({
    version: 1,
    completionConditionId: 'public-check',
    commandSaid: `E${'w'.repeat(43)}`,
    recordedAt: '2026-09-24T20:00:03.000Z',
    outcome: { kind: 'Unresolved', reason: 'RunBlocked' },
  });
  if (receipt.kind !== 'Prepared') throw new Error('verifier receipt rejected');
  const checkpoint = prepareVerifiedCheckpoint(
    {
      version: 1,
      taskId,
      taskRevisionSaid,
      runId: run.binding.runId,
      incarnationId,
      harnessRevisionSaid: run.binding.initialHarnessRevisionSaid,
      harnessLineageId: run.binding.harnessLineageId,
      personalAgentAid: run.binding.personalAgentAid,
      governorAid: run.binding.governorAid,
      taskMandateSaid: run.binding.taskMandateSaid,
      promotionMandateSaid: run.binding.promotionMandateSaid,
      purpose: { kind: 'Retained' },
      repository: {
        objectFormat: 'sha1',
        baseCommit: '1'.repeat(40),
        baseTree: '2'.repeat(40),
        changedFiles: [],
      },
      outputArtifactSaids: [],
      verifierReceipts: [receipt.receipt],
      evidence: { eventCount: 1, finalSequence: 0, chainHeadSaid },
      budget: {
        consumed: consumedBudget,
        remaining: {
          ...run.binding.budget,
          providerRequests: run.binding.budget.providerRequests - 4,
        },
      },
      runState: {
        kind: 'Active',
        phase: { kind: 'Blocked', reason: 'HarnessCompatibilityFailure' },
        verification: { kind: 'NotSubmitted' },
      },
      continuation: { kind: 'LaterHarnessCompatibilityResolutionRequired' },
    },
    ['public-check'],
  );
  if (checkpoint.kind !== 'Prepared') throw new Error('checkpoint rejected');
  const blocked = {
    ...run,
    lifecycle: {
      kind: 'Active' as const,
      phase: {
        kind: 'Blocked' as const,
        reason: 'HarnessCompatibilityFailure' as const,
        checkpointSaid: checkpoint.checkpoint.d,
      },
    },
  };
  const created = createEvidenceStream({
    streamId: run.binding.evidenceStreamId,
    runId: run.binding.runId,
    ownerAid: taskOwnerAid,
    taskId,
    taskRevisionSaid,
    incarnationId,
    harnessRevisionSaid: run.binding.initialHarnessRevisionSaid,
    personalAgentAid: run.binding.personalAgentAid,
    taskMandateSaid: run.binding.taskMandateSaid,
    combinedByteCeiling: run.binding.budget.evidencePlusArtifactsPerRunBytes,
  });
  if (created.kind !== 'Created') throw new Error('stream rejected');
  const accepted = acceptEvidenceBatch(created.stream, {
    batchSaid: `E${'j'.repeat(43)}`,
    startingSequence: 0,
    endingSequence: 0,
    predecessor: { kind: 'Genesis' },
    eventSaids: [chainHeadSaid],
    encodedBytes: 256,
    checkpoint: {
      kind: 'Present',
      checkpointSaid: checkpoint.checkpoint.d,
      lifecycle: blocked.lifecycle,
      submissionVerification: blocked.submissionVerification,
    },
  });
  if (accepted.kind !== 'Accepted') throw new Error('stream batch rejected');
  const sealed = sealEvidenceStream(accepted.stream, {
    exchangeSaid: `E${'l'.repeat(43)}`,
    eventCount: 1,
    finalSequence: 0,
    chainHeadSaid,
    sealedAt: '2026-09-24T20:00:05.000Z',
  });
  if (sealed.kind !== 'Sealed') throw new Error('stream seal rejected');
  return {
    run: encodeRunDocument(blocked, runCommandFingerprint),
    stream: encodeEvidenceStreamDocument(sealed.stream),
    checkpoint: encodeEvidenceCheckpointDocument(
      {
        ownerAid: taskOwnerAid,
        evidenceStreamId: run.binding.evidenceStreamId,
        batchSaid: `E${'j'.repeat(43)}`,
        checkpoint: checkpoint.checkpoint,
        receivedAt: '2026-09-24T20:00:05.000Z',
      },
      ['public-check'],
    ),
  };
}

function database(input: {
  task?: unknown;
  runs?: unknown[];
  evaluations?: unknown[];
  streams?: unknown[];
  checkpoints?: unknown[];
}): Db {
  const collections = new Map<string, unknown[]>([
    ['tasks', input.task === undefined ? [] : [input.task]],
    ['runs', input.runs ?? []],
    [evaluationCollectionNames.evaluations, input.evaluations ?? []],
    [evidenceCollectionNames.streams, input.streams ?? []],
    [evidenceCollectionNames.checkpoints, input.checkpoints ?? []],
  ]);
  return {
    collection(name: string) {
      return {
        findOne: () => Promise.resolve((collections.get(name) ?? [])[0] ?? null),
        find: () => ({ toArray: () => Promise.resolve(collections.get(name) ?? []) }),
      };
    },
  } as unknown as Db;
}

const request = {
  ownerAid: taskOwnerAid,
  taskId,
  taskRevisionSaid,
  verifiedMandateCeiling: mandateCeiling,
};

describe('current Task residual allowance', () => {
  it('uses the exact Task and verified mandate ceilings, then holds active Evaluation reservations', async () => {
    expect(
      await new MongoTaskResidualAllowance(database({ task: taskDocument() })).inspect(request),
    ).toMatchObject({
      kind: 'Available',
      remaining: { providerRequests: 30 },
    });
    expect(
      await new MongoTaskResidualAllowance(
        database({ task: taskDocument(), evaluations: [reservation()] }),
      ).inspect(request),
    ).toMatchObject({
      kind: 'Available',
      remaining: { providerRequests: 25 },
    });
    expect(
      await new MongoTaskResidualAllowance(
        database({ task: taskDocument(), evaluations: [closedEvaluation()] }),
      ).inspect(request),
    ).toMatchObject({
      kind: 'Available',
      remaining: { providerRequests: 27 },
    });
  });

  it('blocks a closed Evaluation without a settled debit and an active Run with unresolved spend', async () => {
    const closed = { ...reservation() };
    Reflect.deleteProperty(closed, 'activeOwnerSlot');
    expect(
      await new MongoTaskResidualAllowance(
        database({
          task: taskDocument(),
          evaluations: [{ ...closed, closure: { d: `E${'z'.repeat(43)}` } }],
        }),
      ).inspect(request),
    ).toEqual({
      kind: 'Blocked',
      reason: 'EvaluationDebitProofMissing',
    });
    const activeRun = runFixture();
    const runDocument = encodeRunDocument(
      {
        ...activeRun,
        binding: { ...activeRun.binding, ownerAid: taskOwnerAid, taskRevisionSaid },
      },
      runCommandFingerprint,
    );
    expect(
      await new MongoTaskResidualAllowance(
        database({ task: taskDocument(), runs: [runDocument] }),
      ).inspect(request),
    ).toEqual({
      kind: 'Blocked',
      reason: 'UnresolvedRunSpend',
    });
  });

  it('subtracts a sealed retained Run debit only when checkpoint and stream prove its budget', async () => {
    const proof = sealedRunProof();
    const base = {
      task: taskDocument(),
      runs: [proof.run],
      streams: [proof.stream],
      checkpoints: [proof.checkpoint],
    };
    expect(await new MongoTaskResidualAllowance(database(base)).inspect(request)).toMatchObject({
      kind: 'Available',
      remaining: { providerRequests: 26 },
    });
    expect(
      await new MongoTaskResidualAllowance(database({ ...base, checkpoints: [] })).inspect(request),
    ).toEqual({
      kind: 'Blocked',
      reason: 'RunProofMissing',
    });
    expect(
      await new MongoTaskResidualAllowance(
        database({
          ...base,
          runs: [
            {
              ...proof.run,
              budget: {
                ...proof.run.budget,
                consumed: { ...proof.run.budget.consumed, providerRequests: 5 },
              },
            },
          ],
        }),
      ).inspect(request),
    ).toEqual({
      kind: 'Blocked',
      reason: 'RunProofInvalid',
    });
  });

  it('rejects a mismatched Task revision or unproved reservation instead of resetting allowance', async () => {
    expect(
      await new MongoTaskResidualAllowance(database({ task: taskDocument() })).inspect({
        ...request,
        taskRevisionSaid: `E${'x'.repeat(43)}`,
      }),
    ).toEqual({
      kind: 'Blocked',
      reason: 'TaskRevisionMismatch',
    });
    expect(
      await new MongoTaskResidualAllowance(
        database({
          task: taskDocument(),
          evaluations: [{ ...reservation(), reservationSaid: `E${'x'.repeat(43)}` }],
        }),
      ).inspect(request),
    ).toEqual({
      kind: 'Blocked',
      reason: 'EvaluationReservationProofInvalid',
    });
    const duplicate = reservation();
    expect(
      await new MongoTaskResidualAllowance(
        database({ task: taskDocument(), evaluations: [duplicate, duplicate] }),
      ).inspect(request),
    ).toEqual({
      kind: 'Blocked',
      reason: 'ResidualUnavailable',
      detail: 'DuplicateSource',
    });
    expect(
      await new MongoTaskResidualAllowance(
        database({ task: taskDocument(), evaluations: [closedEvaluation(amount(40))] }),
      ).inspect(request),
    ).toEqual({
      kind: 'Blocked',
      reason: 'EvaluationDebitProofInvalid',
    });
  });
});

const mongoUri = process.env.DEVRANDOM_MONGODB_URI;
const withMongo = mongoUri === undefined ? describe.skip : describe;

withMongo('Mongo current Task residual allowance', () => {
  const client = new MongoClient(mongoUri ?? 'mongodb://127.0.0.1:27017', {
    writeConcern: { w: 'majority' },
  });
  const database = client.db(`devrandom_residual_${randomUUID().replaceAll('-', '')}`);

  beforeAll(async () => {
    await client.connect();
  });
  afterAll(async () => {
    await database.dropDatabase();
    await client.close();
  });

  it('reads the exact Task, all Task reservations, and does not count another Task or owner', async () => {
    await database.collection<TaskDocument>(tasksCollectionName).insertOne(taskDocument());
    await database
      .collection<EvaluationDocument>(evaluationCollectionNames.evaluations)
      .insertMany([
        reservation(),
        {
          ...reservation(),
          _id: randomUUID(),
          ownerAid: `E${'x'.repeat(43)}`,
          reserved: amount(100),
        },
        {
          ...reservation(),
          _id: randomUUID(),
          command: { ...reservation().command, taskId: randomUUID() },
          reserved: amount(100),
        },
      ]);
    expect(await new MongoTaskResidualAllowance(database).inspect(request)).toMatchObject({
      kind: 'Available',
      remaining: { providerRequests: 25 },
    });
    await database
      .collection<EvaluationDocument>(evaluationCollectionNames.evaluations)
      .updateOne(
        { _id: evaluationId },
        { $set: { closure: { d: `E${'z'.repeat(43)}` } }, $unset: { activeOwnerSlot: '' } },
      );
    expect(await new MongoTaskResidualAllowance(database).inspect(request)).toEqual({
      kind: 'Blocked',
      reason: 'EvaluationDebitProofMissing',
    });
    expect(await database.collection(runsCollectionName).countDocuments({})).toBe(0);
  });
});
