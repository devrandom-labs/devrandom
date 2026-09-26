import { randomUUID } from 'node:crypto';

import { type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify from 'fastify';
import { MongoClient, Binary, type Db } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  acceptEvidenceBatch,
  acquireFirstRunLease,
  admitEvidenceArtifact,
  blockRun,
  createEvidenceStream,
  createRun,
  continueCalibrationRun,
  openTask,
  recordRunCalibration,
  sealEvidenceStream,
  startRunExecution,
  taskBudgetCeilings,
  type Run,
  type RunCalibrationDisposition,
  type TaskBudgets,
} from '@devrandom/domain';
import {
  prepareEvaluationExecutionProfile,
  prepareEvidenceArtifact,
  prepareEvidenceBatch,
  prepareEvidenceEvent,
  preparePublicVerifierReceipt,
  prepareTaskCommand,
  prepareVerifiedCheckpoint,
  prepareRunSuccessorSegment,
  decodeRunSuccessorSegment,
  taskCommandFingerprint,
  type EvidenceEvent,
  type EvidenceEventDetail,
  type PublicVerifierReceipt,
  type TaskSourceCommand,
  type VerifiedCheckpoint,
} from '@devrandom/protocol';

import { projectTask } from '../../task/application/task-projection.js';
import { MongoTaskBootstrap } from '../../task/infrastructure/mongo-task-bootstrap.js';
import { tasksCollectionName } from '../../task/infrastructure/mongo-tasks.js';
import { encodeTaskDocument, type TaskDocument } from '../../task/infrastructure/task-document.js';
import {
  runSuccessorSegmentsCollectionName,
  type RunSuccessorSegmentDocument,
} from '../../run/infrastructure/mongo-run-continuations.js';
import { MongoRunBootstrap } from '../../run/infrastructure/mongo-run-bootstrap.js';
import { runsCollectionName } from '../../run/infrastructure/mongo-runs.js';
import { encodeRunDocument, type RunDocument } from '../../run/infrastructure/run-document.js';
import {
  encodeEvidenceArtifactDocument,
  evidenceArtifactDocumentId,
  type EvidenceArtifactDocument,
} from '../../evidence/infrastructure/evidence-artifact-document.js';
import {
  encodeEvidenceCheckpointDocument,
  type EvidenceCheckpointDocument,
} from '../../evidence/infrastructure/evidence-checkpoint-document.js';
import {
  encodeEvidenceEventDocument,
  type EvidenceEventDocument,
} from '../../evidence/infrastructure/evidence-event-document.js';
import { evidenceCollectionNames } from '../../evidence/infrastructure/evidence-storage-contract.js';
import {
  encodeEvidenceStreamDocument,
  type EvidenceStreamDocument,
} from '../../evidence/infrastructure/evidence-stream-document.js';
import { MongoEvidenceBootstrap } from '../../evidence/infrastructure/mongo-evidence-bootstrap.js';
import { MongoRunVerifierReceiptReading } from '../../evidence/infrastructure/mongo-run-verifier-receipt-reading.js';
import { evidenceRoutes } from '../../evidence/route/evidence-routes.js';
import { MongoFailureQualification } from './mongo-failure-qualification.js';

const uri = process.env.DEVRANDOM_MONGODB_URI;
const describeMongo = uri === undefined ? describe.skip : describe;
const said = (letter: string): string => `E${letter.repeat(43)}`;
const ownerAid = said('o');
const agentAid = said('a');
const governorAid = said('g');
const mandateSaid = said('m');
const promotionSaid = said('p');
const harnessSaid = said('h');
const campaignId = '03dd7aa2-f39b-4c73-b73c-275acfb3f3b7';
const taskId = 'a8b30f2c-89a5-45c8-8384-5782e77b1bdd';
const lineageId = '28e8c6ca-9a94-44d4-aa3f-088431c027e4';
const firstCalibrationId = randomUUID();
const repo = { objectFormat: 'sha1' as const, commit: '1'.repeat(40), tree: '2'.repeat(40) };
const commandIds = ['cesr-current', 'cesr-tamper', 'cesr-legacy'] as const;
const commandSaids = [said('c'), said('t'), said('l')] as const;
const receivedAt = '2026-09-24T20:00:30.000Z';

function taskCommand() {
  const source: TaskSourceCommand = {
    version: 1,
    label: 'cesr-compat',
    title: 'Repair the compatibility fixture',
    objective: 'Make the selected public condition pass.',
    repository: { kind: 'currentHead' },
    deliverables: [{ kind: 'repositoryFile', id: 'implementation', path: 'src/index.ts' }],
    completionConditions: commandIds.map((id) => ({
      id,
      argv: ['cargo', 'test', '--locked', '--test', id],
      timeoutSeconds: 300,
      expected: { kind: 'exitCode' as const, code: 0 },
    })),
    constraints: {
      protectedPaths: ['.devrandom'],
      prohibitedEffects: ['NetworkAccess'],
      dataPolicy: 'RepositoryContentOnly',
    },
    requestedCapabilities: ['ReadRepository', 'EditRepository', 'RunTests'],
    unavailableCapabilities: [],
    budgets: taskBudgetCeilings,
    expiresAt: '2026-09-24T23:00:00.000Z',
    evolutionClasses: ['C1'],
    checkpointExpectations: [
      { kind: 'deliverable', deliverableId: 'implementation' },
      ...commandIds.map((completionConditionId) => ({
        kind: 'completionCondition' as const,
        completionConditionId,
      })),
    ],
  };
  const prepared = prepareTaskCommand(source, randomUUID(), repo);
  if (prepared.kind !== 'Prepared') throw new Error(`Task fixture rejected: ${prepared.reason}`);
  return prepared.command;
}

function receipts(excluded: boolean): readonly PublicVerifierReceipt[] {
  if (excluded) return [];
  return commandIds.map((completionConditionId, index) => {
    const prepared = preparePublicVerifierReceipt({
      version: 1,
      completionConditionId,
      commandSaid: commandSaids[index] ?? said('x'),
      recordedAt: '2026-09-24T20:00:10.000Z',
      outcome:
        index === 2
          ? {
              kind: 'Rejected',
              reason: { kind: 'UnexpectedExitCode', expected: 0, observed: 101 },
              elapsedMilliseconds: 10,
              outputArtifactSaids: [],
            }
          : {
              kind: 'Accepted',
              observedExitCode: 0,
              elapsedMilliseconds: 10,
              outputArtifactSaids: [],
            },
    });
    if (prepared.kind !== 'Prepared') throw new Error('Receipt fixture failed');
    return prepared.receipt;
  });
}

function rawArtifact(content: string) {
  const bytes = new TextEncoder().encode(content);
  const prepared = prepareEvidenceArtifact(bytes, 'text/plain; charset=utf-8');
  if (prepared.kind !== 'Prepared') throw new Error('Referenced artifact fixture failed');
  return { bytes, artifact: prepared.artifact };
}

function profile() {
  const instruction = rawArtifact('H1 instruction fixture');
  const limits = rawArtifact('effective limits receipt fixture');
  const cleanup = rawArtifact('parent death cleanup receipt fixture');
  const prepared = prepareEvaluationExecutionProfile({
    os: 'linux',
    architecture: 'x86_64',
    imageDigest: `sha256:${'1'.repeat(64)}`,
    runtimeDigest: `sha256:${'2'.repeat(64)}`,
    toolchainDigest: `sha256:${'3'.repeat(64)}`,
    sourceGitCommit: repo.commit,
    sourceGitTree: repo.tree,
    h1InstructionSaid: instruction.artifact.d,
    h1RuntimePromptDigest: `sha256:${'4'.repeat(64)}`,
    effectiveLimitsReceiptSaid: limits.artifact.d,
    parentDeathCleanupReceiptSaid: cleanup.artifact.d,
    modelProvider: 'test-provider',
    modelId: 'test-model',
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
  if (prepared.kind !== 'Prepared') throw new Error('Profile fixture failed');
  const bytes = new TextEncoder().encode(JSON.stringify(prepared.profile));
  const artifact = prepareEvidenceArtifact(bytes, 'application/json');
  if (artifact.kind !== 'Prepared') throw new Error('Profile artifact fixture failed');
  return {
    profile: prepared.profile,
    bytes,
    artifact: artifact.artifact,
    references: [instruction, limits, cleanup],
  };
}

function zeroBudget(): TaskBudgets {
  return Object.fromEntries(
    Object.keys(taskBudgetCeilings).map((name) => [name, 0]),
  ) as unknown as TaskBudgets;
}

function runFor(
  ordinal: 1 | 2 | 3 | 4 | 5 | 6,
  revisionSaid: string,
): { run: Run; incarnationId: string } {
  const runId = ordinal === 1 ? firstCalibrationId : randomUUID();
  const incarnationId = randomUUID();
  const created = createRun({
    runId,
    ownerAid,
    taskId,
    taskRevisionSaid: revisionSaid,
    harnessLineageId: lineageId,
    personalAgentAid: agentAid,
    taskMandateSaid: mandateSaid,
    governorAid,
    promotionMandateSaid: promotionSaid,
    initialHarnessRevisionSaid: harnessSaid,
    purpose:
      ordinal === 6
        ? { kind: 'Retained' }
        : { kind: 'PreparedCompatibilityCalibration', campaignId, ordinal },
    initialSpecialization: {
      kind: 'InitialSpecializationAccepted',
      harnessLineageId: lineageId,
      harnessRevisionSaid: harnessSaid,
      runId: firstCalibrationId,
      acceptedAt: '2026-09-24T20:00:00.000Z',
    },
    repository: repo,
    commandId: randomUUID(),
    admissionExchangeSaid: said('x'),
    evidenceStreamId: randomUUID(),
    budget: taskBudgetCeilings,
    acceptedAt: '2026-09-24T20:00:00.000Z',
  });
  if (created.kind !== 'Created') throw new Error(`Run fixture failed: ${JSON.stringify(created)}`);
  const acquired = acquireFirstRunLease(created.run, {
    incarnationId,
    expectedRunVersion: 0,
    serverTime: '2026-09-24T20:00:00.000Z',
  });
  if (acquired.kind !== 'Acquired') throw new Error('Run lease fixture failed');
  const started = startRunExecution(acquired.run, {
    incarnationId,
    leaseObservedAt: '2026-09-24T20:00:01.000Z',
    worktree: { repository: repo },
    evidence: { kind: 'Genesis', streamId: acquired.run.binding.evidenceStreamId },
  });
  if (started.kind !== 'Started') throw new Error('Run start fixture failed');
  return { run: started.run, incarnationId };
}

function eventWriter(run: Run, incarnationId: string) {
  const events: EvidenceEvent[] = [];
  return {
    events,
    add(detail: EvidenceEventDetail): EvidenceEvent {
      const predecessor = events.at(-1);
      const sequence = events.length;
      const time =
        Date.parse(run.lease.kind === 'Held' ? run.lease.acquiredAt : receivedAt) +
        (sequence + 1) * 1_000;
      const prepared = prepareEvidenceEvent({
        version: 1,
        sequence,
        predecessor:
          predecessor === undefined
            ? { kind: 'Genesis' }
            : { kind: 'Previous', eventSaid: predecessor.d },
        taskId,
        taskRevisionSaid: run.binding.taskRevisionSaid,
        runId: run.binding.runId,
        incarnationId,
        harnessRevisionSaid: harnessSaid,
        personalAgentAid: agentAid,
        taskMandateSaid: mandateSaid,
        occurredAt: new Date(time).toISOString(),
        recordedAt: new Date(time + 1).toISOString(),
        producer: { kind: 'RunSupervisor' },
        event: detail,
      });
      if (prepared.kind !== 'Prepared') throw new Error(`Event fixture failed: ${prepared.reason}`);
      events.push(prepared.event);
      return prepared.event;
    },
  };
}

function checkpointFor(
  run: Run,
  incarnationId: string,
  events: readonly EvidenceEvent[],
  verifierReceipts: readonly PublicVerifierReceipt[],
  disposition:
    RunCalibrationDisposition | { readonly kind: 'Retained' | 'ContextLimit' | 'ProcessLost' },
): VerifiedCheckpoint {
  const head = events.at(-1);
  if (head === undefined) throw new Error('Missing checkpoint head');
  const runState =
    disposition.kind === 'Retained' ||
    disposition.kind === 'ContextLimit' ||
    disposition.kind === 'ProcessLost'
      ? {
          kind: 'Active' as const,
          phase: {
            kind: 'Blocked' as const,
            reason:
              disposition.kind === 'ProcessLost'
                ? ('ProcessLost' as const)
                : disposition.kind === 'ContextLimit'
                  ? ('ContextLimitReached' as const)
                  : ('HarnessCompatibilityFailure' as const),
          },
          verification: { kind: 'NotSubmitted' as const },
        }
      : disposition.kind === 'Confirmed'
        ? {
            kind: 'Ended' as const,
            outcome: { kind: 'CalibrationConfirmed' as const, category: disposition.category },
            verification: { kind: 'Rejected' as const },
          }
        : {
            kind: 'Ended' as const,
            outcome: {
              kind: 'CalibrationExcluded' as const,
              reason: 'ProviderUnavailable' as const,
            },
            verification: { kind: 'NotSubmitted' as const },
          };
  const prepared = prepareVerifiedCheckpoint(
    {
      version: 1,
      taskId,
      taskRevisionSaid: run.binding.taskRevisionSaid,
      runId: run.binding.runId,
      incarnationId,
      harnessRevisionSaid: harnessSaid,
      harnessLineageId: lineageId,
      personalAgentAid: agentAid,
      governorAid,
      taskMandateSaid: mandateSaid,
      promotionMandateSaid: promotionSaid,
      purpose: run.binding.purpose,
      repository: {
        objectFormat: 'sha1',
        baseCommit: repo.commit,
        baseTree: repo.tree,
        changedFiles: [],
      },
      outputArtifactSaids: [],
      verifierReceipts: [...verifierReceipts],
      evidence: { eventCount: events.length, finalSequence: head.sequence, chainHeadSaid: head.d },
      budget: { consumed: zeroBudget(), remaining: taskBudgetCeilings },
      runState,
      continuation:
        disposition.kind === 'ProcessLost'
          ? { kind: 'LaterRuntimeRecoveryRequired' }
          : disposition.kind === 'ContextLimit'
            ? { kind: 'ExternalResolutionRequired', reason: 'ContextLimitReached' }
            : disposition.kind === 'Retained'
              ? { kind: 'LaterHarnessCompatibilityResolutionRequired' }
              : { kind: 'NoContinuation' },
    },
    commandIds,
  );
  if (prepared.kind !== 'Prepared')
    throw new Error(`Checkpoint fixture failed: ${prepared.reason}`);
  return prepared.checkpoint;
}

async function continueCalibrationFixture(
  database: Db,
  running: Run,
  incarnationId: string,
  preparedProfile: ReturnType<typeof profile>,
  recoveryKind: 'ContextLimit' | 'ProcessLost' = 'ContextLimit',
): Promise<Run> {
  const writer = eventWriter(running, incarnationId);
  writer.add({ kind: 'RunStarted', fromRunVersion: running.version });
  writer.add({
    kind: 'RunExecutionProfileBound',
    executionProfileSaid: preparedProfile.profile.d,
    profileArtifactSaid: preparedProfile.artifact.d,
    worktreeBranch: `devrandom/run/${running.binding.runId}`,
  });
  const unresolved = commandIds.map((completionConditionId, index) => {
    const commandSaid = commandSaids[index];
    if (commandSaid === undefined) throw new Error('Missing verifier command fixture');
    const prepared = preparePublicVerifierReceipt({
      version: 1,
      completionConditionId,
      commandSaid,
      recordedAt: receivedAt,
      outcome: { kind: 'Unresolved', reason: 'RunBlocked' },
    });
    if (prepared.kind !== 'Prepared') throw new Error('Unresolved receipt fixture');
    return prepared.receipt;
  });
  const checkpoint = checkpointFor(running, incarnationId, writer.events, unresolved, {
    kind: recoveryKind,
  });
  const head = writer.add({
    kind: 'RunBlocked',
    reason: recoveryKind === 'ProcessLost' ? 'ProcessLost' : 'ContextLimitReached',
    checkpointSaid: checkpoint.d,
  });
  const blocked = blockRun(running, {
    reason: recoveryKind === 'ProcessLost' ? 'ProcessLost' : 'ContextLimitReached',
    checkpointSaid: checkpoint.d,
  });
  if (blocked.kind !== 'Blocked') throw new Error('Predecessor block failed');
  const batch = prepareEvidenceBatch({
    version: 1,
    runId: running.binding.runId,
    evidenceStreamId: running.binding.evidenceStreamId,
    events: writer.events,
  });
  const created = createEvidenceStream({
    streamId: running.binding.evidenceStreamId,
    runId: running.binding.runId,
    ownerAid,
    taskId,
    taskRevisionSaid: running.binding.taskRevisionSaid,
    incarnationId,
    harnessRevisionSaid: harnessSaid,
    personalAgentAid: agentAid,
    taskMandateSaid: mandateSaid,
    combinedByteCeiling: taskBudgetCeilings.evidencePlusArtifactsPerRunBytes,
  });
  if (batch.kind !== 'Prepared' || created.kind !== 'Created')
    throw new Error('Predecessor batch failed');
  const accepted = acceptEvidenceBatch(created.stream, {
    batchSaid: batch.batch.d,
    startingSequence: 0,
    endingSequence: head.sequence,
    predecessor: { kind: 'Genesis' },
    eventSaids: writer.events.map((event) => event.d),
    encodedBytes: batch.batch.encodedByteCount,
    checkpoint: {
      kind: 'Present',
      checkpointSaid: checkpoint.d,
      lifecycle: blocked.run.lifecycle,
      submissionVerification: blocked.run.submissionVerification,
    },
  });
  if (accepted.kind !== 'Accepted') throw new Error('Predecessor accept failed');
  const sealSaid = said('q');
  const sealed = sealEvidenceStream(accepted.stream, {
    exchangeSaid: sealSaid,
    eventCount: writer.events.length,
    finalSequence: head.sequence,
    chainHeadSaid: head.d,
    sealedAt: receivedAt,
  });
  if (sealed.kind !== 'Sealed') throw new Error('Predecessor seal failed');
  await database
    .collection<EvidenceStreamDocument>(evidenceCollectionNames.streams)
    .insertOne(encodeEvidenceStreamDocument(sealed.stream));
  await database
    .collection<EvidenceCheckpointDocument>(evidenceCollectionNames.checkpoints)
    .insertOne(
      encodeEvidenceCheckpointDocument(
        {
          ownerAid,
          evidenceStreamId: running.binding.evidenceStreamId,
          batchSaid: batch.batch.d,
          checkpoint,
          receivedAt,
        },
        commandIds,
      ),
    );
  await database.collection<EvidenceEventDocument>(evidenceCollectionNames.events).insertMany(
    writer.events.map((event) =>
      encodeEvidenceEventDocument({
        ownerAid,
        evidenceStreamId: running.binding.evidenceStreamId,
        batchSaid: batch.batch.d,
        event,
        receivedAt,
      }),
    ),
  );
  const prepared = prepareRunSuccessorSegment({
    version: 2,
    kind: 'CalibrationContinuationSegment',
    runId: running.binding.runId,
    taskId,
    taskRevisionSaid: running.binding.taskRevisionSaid,
    ownerAid,
    personalAgentAid: agentAid,
    taskMandateSaid: mandateSaid,
    fromRunVersion: blocked.run.version,
    predecessor: {
      incarnationId,
      evidenceStreamId: running.binding.evidenceStreamId,
      checkpointSaid: checkpoint.d,
      sealExchangeSaid: sealSaid,
      finalSequence: head.sequence,
      chainHeadSaid: head.d,
    },
    successor: {
      incarnationId: randomUUID(),
      evidenceStreamId: randomUUID(),
      harnessRevisionSaid: harnessSaid,
    },
    baseline: { pointerVersion: 1, harnessRevisionSaid: harnessSaid },
    consumedBudget: blocked.run.consumedBudget,
    admittedAt: '2026-09-24T20:01:00.000Z',
  });
  if (prepared.kind !== 'Prepared' || prepared.segment.kind !== 'CalibrationContinuationSegment')
    throw new Error('Segment fixture failed');
  const segment = prepared.segment;
  const continued = continueCalibrationRun(blocked.run, {
    expectedRunVersion: blocked.run.version,
    serverTime: segment.admittedAt,
    predecessor: segment.predecessor,
    successor: { ...segment.successor, segmentSaid: segment.d },
    baseline: segment.baseline,
    effects: 'Settled',
  });
  if (continued.kind !== 'Admitted')
    throw new Error(`Continuation fixture failed: ${continued.kind}`);
  await database
    .collection<RunSuccessorSegmentDocument>(runSuccessorSegmentsCollectionName)
    .insertOne({
      _id: segment.d,
      ownerAid,
      runId: running.binding.runId,
      segment,
      acceptedAt: new Date(segment.admittedAt),
    });
  const started = startRunExecution(continued.run, {
    incarnationId: segment.successor.incarnationId,
    leaseObservedAt: '2026-09-24T20:01:01.000Z',
    worktree: { repository: repo },
    evidence: { kind: 'Genesis', streamId: segment.successor.evidenceStreamId },
  });
  if (started.kind !== 'Started')
    throw new Error(`Continued start fixture failed: ${started.kind}`);
  return started.run;
}

describeMongo('Mongo six-Run failure qualification custody', () => {
  const client = new MongoClient(uri ?? 'mongodb://127.0.0.1:27017');
  const database = client.db(`devrandom_q_${randomUUID().replaceAll('-', '')}`);
  let qualificationInput: Parameters<MongoFailureQualification['assess']>[0];
  let firstCalibrationRunId: string;
  let profileArtifactSaid: string;
  let profileArtifactBytes: Uint8Array;
  let limitsReceiptArtifactSaid: string;

  beforeAll(async () => {
    await client.connect();
    await new MongoTaskBootstrap(database).bootstrap();
    await new MongoRunBootstrap(database).bootstrap();
    await new MongoEvidenceBootstrap(database).bootstrap();
    const command = taskCommand();
    const task = openTask({
      taskId,
      ownerAid,
      label: command.label,
      harnessLineageId: lineageId,
      revisionSaid: command.revision.d,
      commandId: command.commandId,
      createdAt: '2026-09-24T20:00:00.000Z',
    });
    await database.collection<TaskDocument>(tasksCollectionName).insertOne(
      encodeTaskDocument(projectTask(task, command.revision), taskCommandFingerprint(command), {
        ownerSlot: 0,
        globalSlot: 0,
      }),
    );
    const preparedProfile = profile();
    profileArtifactSaid = preparedProfile.artifact.d;
    profileArtifactBytes = preparedProfile.bytes;
    limitsReceiptArtifactSaid = preparedProfile.references[1]?.artifact.d ?? '';
    const category = {
      version: 1 as const,
      taskId,
      taskRevisionSaid: command.revision.d,
      harnessRevisionSaid: harnessSaid,
      currentCommandSaid: commandSaids[0],
      tamperCommandSaid: commandSaids[1],
      legacyCommandSaid: commandSaids[2],
      legacyObservedExitCode: 101 as const,
    };
    for (const ordinal of [1, 2, 3, 4, 5, 6] as const) {
      const initial = runFor(ordinal, command.revision.d);
      const running =
        ordinal === 1 || ordinal === 2
          ? await continueCalibrationFixture(
              database,
              initial.run,
              initial.incarnationId,
              preparedProfile,
              ordinal === 2 ? 'ProcessLost' : 'ContextLimit',
            )
          : initial.run;
      const incarnationId =
        running.lease.kind === 'Held' ? running.lease.incarnationId : initial.incarnationId;
      const streamId =
        running.currentExecution?.evidenceStreamId ?? running.binding.evidenceStreamId;
      if (ordinal === 1) firstCalibrationRunId = running.binding.runId;
      const excluded = ordinal === 5;
      const verifierReceipts = receipts(excluded);
      const writer = eventWriter(running, incarnationId);
      writer.add({ kind: 'RunStarted', fromRunVersion: running.version });
      writer.add({
        kind: 'RunExecutionProfileBound',
        executionProfileSaid: preparedProfile.profile.d,
        profileArtifactSaid: preparedProfile.artifact.d,
        worktreeBranch: `devrandom/run/${running.binding.runId}`,
      });
      if (!excluded) {
        const legacy = verifierReceipts[2];
        if (legacy === undefined) throw new Error('Missing legacy receipt');
        writer.add({
          kind: 'FailureObserved',
          failure: 'HarnessCompatibilityFailure',
          receiptSaid: legacy.d,
        });
      }
      const disposition: RunCalibrationDisposition | { kind: 'Retained' } =
        ordinal === 6
          ? { kind: 'Retained' }
          : excluded
            ? { kind: 'Excluded', reason: 'ProviderUnavailable' }
            : { kind: 'Confirmed', category };
      const checkpoint = checkpointFor(
        running,
        incarnationId,
        writer.events,
        verifierReceipts,
        disposition,
      );
      writer.add({ kind: 'CheckpointVerified', checkpointSaid: checkpoint.d });
      if (disposition.kind === 'Retained') {
        writer.add({
          kind: 'RunBlocked',
          reason: 'HarnessCompatibilityFailure',
          checkpointSaid: checkpoint.d,
        });
      } else {
        writer.add({ kind: 'RunCalibrationRecorded', checkpointSaid: checkpoint.d, disposition });
      }
      writer.add({ kind: 'CheckpointAccepted', checkpointSaid: checkpoint.d });
      const finalEvent = writer.events.at(-1);
      if (finalEvent === undefined) throw new Error('Missing final event');
      const settled =
        disposition.kind === 'Retained'
          ? blockRun(running, {
              reason: 'HarnessCompatibilityFailure',
              checkpointSaid: checkpoint.d,
            })
          : recordRunCalibration(running, { disposition, checkpointSaid: checkpoint.d });
      if (settled.kind !== 'Blocked' && settled.kind !== 'Recorded')
        throw new Error('Run settlement fixture failed');
      const run = settled.run;
      const createdStream = createEvidenceStream({
        streamId: streamId,
        runId: run.binding.runId,
        ownerAid,
        taskId,
        taskRevisionSaid: run.binding.taskRevisionSaid,
        incarnationId,
        harnessRevisionSaid: harnessSaid,
        personalAgentAid: agentAid,
        taskMandateSaid: mandateSaid,
        combinedByteCeiling: taskBudgetCeilings.evidencePlusArtifactsPerRunBytes,
      });
      if (createdStream.kind !== 'Created') throw new Error('Stream fixture failed');
      let artifactStream = createdStream.stream;
      for (const raw of [preparedProfile, ...preparedProfile.references]) {
        const admitted = admitEvidenceArtifact(artifactStream, {
          byteLength: raw.bytes.byteLength,
        });
        if (admitted.kind !== 'Admitted') throw new Error('Artifact stream fixture failed');
        artifactStream = admitted.stream;
      }
      const preparedBatch = prepareEvidenceBatch({
        version: 1,
        runId: run.binding.runId,
        evidenceStreamId: streamId,
        events: writer.events,
      });
      if (preparedBatch.kind !== 'Prepared') throw new Error('Batch fixture failed');
      const accepted = acceptEvidenceBatch(artifactStream, {
        batchSaid: preparedBatch.batch.d,
        startingSequence: 0,
        endingSequence: finalEvent.sequence,
        predecessor: { kind: 'Genesis' },
        eventSaids: writer.events.map((event) => event.d),
        encodedBytes: preparedBatch.batch.encodedByteCount,
        checkpoint: {
          kind: 'Present',
          checkpointSaid: checkpoint.d,
          lifecycle: run.lifecycle,
          submissionVerification: run.submissionVerification,
        },
      });
      if (accepted.kind !== 'Accepted')
        throw new Error(`Batch stream fixture failed: ${accepted.kind}`);
      const sealed = sealEvidenceStream(accepted.stream, {
        exchangeSaid: said(String(ordinal)),
        eventCount: writer.events.length,
        finalSequence: finalEvent.sequence,
        chainHeadSaid: finalEvent.d,
        sealedAt: receivedAt,
      });
      if (sealed.kind !== 'Sealed') throw new Error(`Seal fixture failed: ${sealed.kind}`);
      await database
        .collection<RunDocument>(runsCollectionName)
        .insertOne(encodeRunDocument(run, `sha256:${'c'.repeat(64)}`));
      await database
        .collection<EvidenceStreamDocument>(evidenceCollectionNames.streams)
        .insertOne(encodeEvidenceStreamDocument(sealed.stream));
      await database
        .collection<EvidenceCheckpointDocument>(evidenceCollectionNames.checkpoints)
        .insertOne(
          encodeEvidenceCheckpointDocument(
            {
              ownerAid,
              evidenceStreamId: streamId,
              batchSaid: preparedBatch.batch.d,
              checkpoint,
              receivedAt,
            },
            commandIds,
          ),
        );
      await database
        .collection<EvidenceArtifactDocument>(evidenceCollectionNames.artifacts)
        .insertMany(
          [preparedProfile, ...preparedProfile.references].map((raw) =>
            encodeEvidenceArtifactDocument({
              ownerAid,
              runId: run.binding.runId,
              evidenceStreamId: running.binding.evidenceStreamId,
              artifact: raw.artifact,
              bytes: raw.bytes,
              acceptedAt: receivedAt,
            }),
          ),
        );
      await database.collection<EvidenceEventDocument>(evidenceCollectionNames.events).insertMany(
        writer.events.map((event) =>
          encodeEvidenceEventDocument({
            ownerAid,
            evidenceStreamId: streamId,
            batchSaid: preparedBatch.batch.d,
            event,
            receivedAt,
          }),
        ),
      );
      if (ordinal === 6) {
        qualificationInput = {
          ownerAid,
          taskId,
          taskRevisionSaid: command.revision.d,
          retainedRunId: run.binding.runId,
          retainedCheckpointSaid: checkpoint.d,
          retainedSealSaid:
            sealed.stream.seal.kind === 'Sealed' ? sealed.stream.seal.exchangeSaid : '',
          executionProfileSaid: preparedProfile.profile.d,
          personalAgentAid: agentAid,
          taskMandateSaid: mandateSaid,
          expectedActiveRevisionSaid: harnessSaid,
        };
      }
    }
  });

  afterAll(async () => {
    await database.dropDatabase();
    await client.close();
  });

  it('serves only the sealed owner-bound public receipt over listening Fastify and Mongo', async () => {
    const checkpointDocument = await database
      .collection<EvidenceCheckpointDocument>(evidenceCollectionNames.checkpoints)
      .findOne({ runId: qualificationInput.retainedRunId });
    const receipt = checkpointDocument?.checkpoint.verifierReceipts.find(
      (candidate) => candidate.commandSaid === commandSaids[2],
    );
    if (checkpointDocument === null || receipt === undefined)
      throw new Error('Missing receipt fixture');
    const reading = new MongoRunVerifierReceiptReading(database);
    const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
    await server.register(
      evidenceRoutes({
        access: {
          authorize: ({ bearerSecret }) =>
            Promise.resolve({
              kind: 'EvidenceAccessAuthorized' as const,
              ownerAid: bearerSecret === 'a'.repeat(43) ? ownerAid : said('z'),
            }),
        },
        conversation: {
          admitArtifact: () => Promise.resolve({ kind: 'EvidenceRunNotFound' }),
          readArtifact: () => Promise.resolve({ kind: 'NotFound' }),
          readVerifierReceipt: (input) => reading.read(input),
          acceptBatch: () => Promise.resolve({ kind: 'EvidenceRunNotFound' }),
          reconcileSeal: () => Promise.resolve({ kind: 'EvidenceRunNotFound' }),
          inspectTimeline: () => Promise.resolve({ kind: 'EvidenceRunNotFound' }),
        },
        now: () => receivedAt,
        newCorrelationId: randomUUID,
      }),
    );
    const address = await server.listen({ host: '127.0.0.1', port: 0 });
    try {
      const url = `${address}/api/runs/${qualificationInput.retainedRunId}/verifier-receipts/${receipt.d}`;
      const authorized = { authorization: `Bearer ${'a'.repeat(43)}` };
      const exact = await fetch(url, { headers: authorized });
      expect(exact.status).toBe(200);
      expect(await exact.json()).toEqual({
        version: 1,
        runId: qualificationInput.retainedRunId,
        evidenceStreamId: checkpointDocument.evidenceStreamId,
        checkpointSaid: checkpointDocument.checkpoint.d,
        receipt,
      });
      expect((await fetch(url, { headers: authorized })).status).toBe(200);
      const foreign = await fetch(url, {
        headers: { authorization: `Bearer ${'b'.repeat(43)}` },
      });
      expect(foreign.status).toBe(404);
      expect(await foreign.text()).not.toContain(receipt.d);
      const absent = await fetch(
        `${address}/api/runs/${qualificationInput.retainedRunId}/verifier-receipts/${said('x')}`,
        { headers: authorized },
      );
      expect(absent.status).toBe(404);
      const failureEvent = await database
        .collection<EvidenceEventDocument>(evidenceCollectionNames.events)
        .findOne({
          runId: qualificationInput.retainedRunId,
          'event.event.kind': 'FailureObserved',
          'event.event.receiptSaid': receipt.d,
        });
      if (failureEvent === null) throw new Error('Missing failure event fixture');
      await database
        .collection<EvidenceEventDocument>(evidenceCollectionNames.events)
        .updateOne({ _id: failureEvent._id }, { $set: { 'event.event.receiptSaid': said('x') } });
      const corrupt = await fetch(url, { headers: authorized });
      expect(corrupt.status).toBe(503);
      await database
        .collection<EvidenceEventDocument>(evidenceCollectionNames.events)
        .replaceOne({ _id: failureEvent._id }, failureEvent);
      await database
        .collection<EvidenceCheckpointDocument>(evidenceCollectionNames.checkpoints)
        .deleteOne({
          _id: checkpointDocument._id,
        });
      expect((await fetch(url, { headers: authorized })).status).toBe(404);
    } finally {
      await database
        .collection<EvidenceCheckpointDocument>(evidenceCollectionNames.checkpoints)
        .replaceOne({ _id: checkpointDocument._id }, checkpointDocument, { upsert: true });
      await server.close();
    }
  });

  it('rejects a continued calibration when its exact predecessor segment is absent', async () => {
    const segments = database.collection<RunSuccessorSegmentDocument>(
      runSuccessorSegmentsCollectionName,
    );
    const original = await segments.findOne({ runId: firstCalibrationRunId });
    if (original === null) throw new Error('Missing continuation fixture');
    try {
      await segments.deleteOne({ _id: original._id });
      await expect(
        new MongoFailureQualification(database).assess(qualificationInput),
      ).resolves.toEqual({ kind: 'Blocked', gate: 'Evidence' });
    } finally {
      await segments.insertOne(original);
    }
  });

  it('rejects foreign bindings, changed H1, predecessor substitution, forks and orphan raw custody', async () => {
    const segments = database.collection<RunSuccessorSegmentDocument>(
      runSuccessorSegmentsCollectionName,
    );
    const original = await segments.findOne({ runId: firstCalibrationRunId });
    if (original === null) throw new Error('Missing continuation fixture');
    const decoded = decodeRunSuccessorSegment(original.segment);
    if (decoded.kind !== 'Accepted') throw new Error('Invalid continuation fixture');
    const body = Object.fromEntries(Object.entries(decoded.segment).filter(([key]) => key !== 'd'));
    const variants = [
      { ...body, ownerAid: said('z') },
      {
        ...body,
        baseline: { pointerVersion: 1, harnessRevisionSaid: said('z') },
        successor: { ...decoded.segment.successor, harnessRevisionSaid: said('z') },
      },
      { ...body, predecessor: { ...decoded.segment.predecessor, chainHeadSaid: said('z') } },
      {
        ...body,
        predecessor: { ...decoded.segment.predecessor, evidenceStreamId: randomUUID() },
      },
    ];
    for (const variant of variants) {
      const prepared = prepareRunSuccessorSegment(variant);
      if (prepared.kind !== 'Prepared') throw new Error('Invalid negative segment fixture');
      try {
        await segments.deleteOne({ _id: original._id });
        await segments.insertOne({
          ...original,
          _id: prepared.segment.d,
          segment: prepared.segment,
        });
        await expect(
          new MongoFailureQualification(database).assess(qualificationInput),
        ).resolves.toEqual({ kind: 'Blocked', gate: 'Evidence' });
      } finally {
        await segments.deleteOne({ _id: prepared.segment.d });
        await segments.replaceOne({ _id: original._id }, original, { upsert: true });
      }
    }
    const fork = prepareRunSuccessorSegment({
      ...body,
      successor: {
        ...decoded.segment.successor,
        incarnationId: randomUUID(),
        evidenceStreamId: randomUUID(),
      },
    });
    if (fork.kind !== 'Prepared') throw new Error('Invalid fork fixture');
    try {
      await segments.insertOne({ ...original, _id: fork.segment.d, segment: fork.segment });
      await expect(
        new MongoFailureQualification(database).assess(qualificationInput),
      ).resolves.toEqual({ kind: 'Blocked', gate: 'Evidence' });
    } finally {
      await segments.deleteOne({ _id: fork.segment.d });
    }
    const artifacts = database.collection<EvidenceArtifactDocument>(
      evidenceCollectionNames.artifacts,
    );
    const raw = await artifacts.findOne({
      runId: firstCalibrationRunId,
      'artifact.d': profileArtifactSaid,
    });
    if (raw === null) throw new Error('Missing original raw custody');
    try {
      await artifacts.updateOne({ _id: raw._id }, { $set: { evidenceStreamId: randomUUID() } });
      await expect(
        new MongoFailureQualification(database).assess(qualificationInput),
      ).resolves.toEqual({ kind: 'Blocked', gate: 'Evidence' });
    } finally {
      await artifacts.replaceOne({ _id: raw._id }, raw);
    }
    await expect(
      new MongoFailureQualification(database).assess(qualificationInput),
    ).resolves.toEqual({ kind: 'Qualified' });
  });

  it('qualifies six distinct, sealed exact-read Runs, then rejects corruption and a missing ordinal', async () => {
    const qualification = new MongoFailureQualification(database);
    await expect(qualification.assess(qualificationInput)).resolves.toEqual({
      kind: 'Qualified',
    });
    await expect(
      qualification.assess({ ...qualificationInput, ownerAid: said('z') }),
    ).resolves.toEqual({ kind: 'Blocked', gate: 'Qualification' });
    const limitsReceiptDocument = await database
      .collection<EvidenceArtifactDocument>(evidenceCollectionNames.artifacts)
      .findOne({
        _id: evidenceArtifactDocumentId(
          qualificationInput.retainedRunId,
          limitsReceiptArtifactSaid,
        ),
      });
    if (limitsReceiptDocument === null) throw new Error('Missing fixture limits receipt');
    await database
      .collection<EvidenceArtifactDocument>(evidenceCollectionNames.artifacts)
      .deleteOne({ _id: limitsReceiptDocument._id });
    await expect(qualification.assess(qualificationInput)).resolves.toEqual({
      kind: 'Blocked',
      gate: 'Profile',
    });
    await database
      .collection<EvidenceArtifactDocument>(evidenceCollectionNames.artifacts)
      .insertOne(limitsReceiptDocument);
    await database
      .collection<EvidenceArtifactDocument>(evidenceCollectionNames.artifacts)
      .updateOne(
        { _id: limitsReceiptDocument._id },
        { $set: { bytes: new Binary(new TextEncoder().encode('corrupt limits receipt')) } },
      );
    await expect(qualification.assess(qualificationInput)).resolves.toEqual({
      kind: 'Unavailable',
    });
    await database
      .collection<EvidenceArtifactDocument>(evidenceCollectionNames.artifacts)
      .replaceOne({ _id: limitsReceiptDocument._id }, limitsReceiptDocument);
    await expect(qualification.assess(qualificationInput)).resolves.toEqual({
      kind: 'Qualified',
    });
    await database
      .collection<EvidenceArtifactDocument>(evidenceCollectionNames.artifacts)
      .updateOne(
        { runId: qualificationInput.retainedRunId, 'artifact.d': profileArtifactSaid },
        { $set: { bytes: new Binary(new TextEncoder().encode('tampered')) } },
      );
    await expect(qualification.assess(qualificationInput)).resolves.toEqual({
      kind: 'Unavailable',
    });
    await database
      .collection<EvidenceArtifactDocument>(evidenceCollectionNames.artifacts)
      .updateOne(
        { runId: qualificationInput.retainedRunId, 'artifact.d': profileArtifactSaid },
        { $set: { bytes: new Binary(profileArtifactBytes) } },
      );
    const missingEvent = await database
      .collection<EvidenceEventDocument>(evidenceCollectionNames.events)
      .findOne({ runId: firstCalibrationRunId, sequence: 1 });
    if (missingEvent === null) throw new Error('Missing fixture profile event');
    const original = missingEvent.event;
    const prematureModelRequest = prepareEvidenceEvent({
      version: 1,
      sequence: original.sequence,
      predecessor: original.predecessor,
      taskId: original.taskId,
      taskRevisionSaid: original.taskRevisionSaid,
      runId: original.runId,
      incarnationId: original.incarnationId,
      harnessRevisionSaid: original.harnessRevisionSaid,
      personalAgentAid: original.personalAgentAid,
      taskMandateSaid: original.taskMandateSaid,
      occurredAt: original.occurredAt,
      recordedAt: original.recordedAt,
      producer: original.producer,
      event: {
        kind: 'ModelRequest',
        piSessionId: randomUUID(),
        modelTurnId: 'before-profile',
        provider: 'test-provider',
        model: 'test-model',
        maximumOutputTokens: 100,
      },
    });
    if (prematureModelRequest.kind !== 'Prepared') throw new Error('Model request fixture failed');
    await database
      .collection<EvidenceEventDocument>(evidenceCollectionNames.events)
      .deleteOne({ _id: missingEvent._id });
    const outOfOrder = encodeEvidenceEventDocument({
      ownerAid,
      evidenceStreamId: missingEvent.evidenceStreamId,
      batchSaid: missingEvent.batchSaid,
      event: prematureModelRequest.event,
      receivedAt,
    });
    await database
      .collection<EvidenceEventDocument>(evidenceCollectionNames.events)
      .insertOne(outOfOrder);
    await expect(qualification.assess(qualificationInput)).resolves.toEqual({
      kind: 'Blocked',
      gate: 'Profile',
    });
    await database
      .collection<EvidenceEventDocument>(evidenceCollectionNames.events)
      .deleteOne({ _id: outOfOrder._id });
    await database
      .collection<EvidenceEventDocument>(evidenceCollectionNames.events)
      .insertOne(missingEvent);
    await expect(qualification.assess(qualificationInput)).resolves.toEqual({
      kind: 'Qualified',
    });
    await database
      .collection<EvidenceEventDocument>(evidenceCollectionNames.events)
      .deleteOne({ _id: missingEvent._id });
    await expect(qualification.assess(qualificationInput)).resolves.toEqual({
      kind: 'Blocked',
      gate: 'Evidence',
    });
    await database
      .collection<EvidenceEventDocument>(evidenceCollectionNames.events)
      .insertOne(missingEvent);
    await expect(qualification.assess(qualificationInput)).resolves.toEqual({
      kind: 'Qualified',
    });
    await database
      .collection<RunDocument>(runsCollectionName)
      .deleteOne({ _id: firstCalibrationRunId });
    await expect(qualification.assess(qualificationInput)).resolves.toEqual({
      kind: 'Blocked',
      gate: 'Qualification',
    });
  });
});
