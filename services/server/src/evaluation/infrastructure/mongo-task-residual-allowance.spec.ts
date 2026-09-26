import { randomUUID } from 'node:crypto';

import { MongoClient, type Db } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  acceptEvidenceBatch,
  continueCalibrationRun,
  type Run,
  createEvidenceStream,
  evaluationConsumables,
  sealEvidenceStream,
  type EvaluationAllowance,
} from '@devrandom/domain';
import {
  prepareEvaluationClosure,
  prepareRunSuccessorSegment,
  type EvidenceEvent,
  prepareEvidenceArtifact,
  prepareEvidenceEvent,
  preparePublicVerifierReceipt,
  prepareVerifiedCheckpoint,
  taskCommandFingerprint,
} from '@devrandom/protocol';

import {
  encodeEvidenceCheckpointDocument,
  type EvidenceCheckpointDocument,
} from '../../evidence/infrastructure/evidence-checkpoint-document.js';
import {
  encodeEvidenceArtifactDocument,
  type EvidenceArtifactDocument,
} from '../../evidence/infrastructure/evidence-artifact-document.js';
import {
  encodeEvidenceEventDocument,
  type EvidenceEventDocument,
} from '../../evidence/infrastructure/evidence-event-document.js';
import { evidenceCollectionNames } from '../../evidence/infrastructure/evidence-storage-contract.js';
import {
  encodeEvidenceStreamDocument,
  type EvidenceStreamDocument,
} from '../../evidence/infrastructure/evidence-stream-document.js';
import { encodeRunDocument, type RunDocument } from '../../run/infrastructure/run-document.js';
import { runsCollectionName } from '../../run/infrastructure/mongo-runs.js';
import { runCommandFingerprint, runFixture } from '../../run/test/run-fixture.js';
import { encodeTaskDocument, type TaskDocument } from '../../task/infrastructure/task-document.js';
import { tasksCollectionName } from '../../task/infrastructure/mongo-tasks.js';
import { taskCommandFixture, taskOwnerAid } from '../../task/test/task-command-fixture.js';
import {
  evaluationCollectionNames,
  MongoEvaluationReservations,
  type EvaluationDocument,
} from './mongo-evaluation-reservations.js';
import { sealedRunPredecessorFixture } from '../../run/test/sealed-run-predecessor-fixture.js';
import {
  runSuccessorSegmentsCollectionName,
  type RunSuccessorSegmentDocument,
} from '../../run/infrastructure/mongo-run-continuations.js';
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
    evidenceIndexSaid: `E${'i'.repeat(43)}`,
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
  const incarnationId = 'd9cb18e4-f4f8-4378-a852-353eef083d91';
  const run = {
    ...original,
    version: 1,
    binding: { ...original.binding, ownerAid: taskOwnerAid, taskId, taskRevisionSaid },
    lease: {
      kind: 'Held' as const,
      incarnationId,
      acquiredAt: '2026-09-24T20:00:00.000Z',
      expiresAt: '2026-09-24T20:05:00.000Z',
      lastChange: { kind: 'Acquired' as const, fromRunVersion: 0 },
    },
    consumedBudget,
  };
  const raw = new TextEncoder().encode('retained Run observation');
  const artifact = prepareEvidenceArtifact(raw, 'text/plain; charset=utf-8');
  if (artifact.kind !== 'Prepared') throw new Error('artifact rejected');
  const eventDraft = {
    version: 1 as const,
    taskId,
    taskRevisionSaid,
    runId: run.binding.runId,
    incarnationId,
    harnessRevisionSaid: run.binding.initialHarnessRevisionSaid,
    personalAgentAid: run.binding.personalAgentAid,
    taskMandateSaid: run.binding.taskMandateSaid,
    occurredAt: '2026-09-24T20:00:00.000Z',
    recordedAt: '2026-09-24T20:00:00.000Z',
    producer: { kind: 'EvidenceRecorder' as const },
  };
  const first = prepareEvidenceEvent({
    ...eventDraft,
    sequence: 0,
    predecessor: { kind: 'Genesis' },
    event: { kind: 'Observation', source: 'Repository', artifactSaid: artifact.artifact.d },
  });
  if (first.kind !== 'Prepared') throw new Error('first event rejected');
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
      evidence: { eventCount: 1, finalSequence: 0, chainHeadSaid: first.event.d },
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
  const verified = prepareEvidenceEvent({
    ...eventDraft,
    sequence: 1,
    predecessor: { kind: 'Previous', eventSaid: first.event.d },
    event: { kind: 'CheckpointVerified', checkpointSaid: checkpoint.checkpoint.d },
  });
  if (verified.kind !== 'Prepared') throw new Error('verified event rejected');
  const acceptedEvent = prepareEvidenceEvent({
    ...eventDraft,
    sequence: 2,
    predecessor: { kind: 'Previous', eventSaid: verified.event.d },
    event: { kind: 'CheckpointAccepted', checkpointSaid: checkpoint.checkpoint.d },
  });
  if (acceptedEvent.kind !== 'Prepared') throw new Error('accepted event rejected');
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
    eventSaids: [first.event.d],
    encodedBytes: 256,
    checkpoint: {
      kind: 'Present',
      checkpointSaid: checkpoint.checkpoint.d,
      lifecycle: blocked.lifecycle,
      submissionVerification: blocked.submissionVerification,
    },
  });
  if (accepted.kind !== 'Accepted') throw new Error('stream batch rejected');
  const continued = acceptEvidenceBatch(accepted.stream, {
    batchSaid: `E${'k'.repeat(43)}`,
    startingSequence: 1,
    endingSequence: 2,
    predecessor: { kind: 'Previous', eventSaid: first.event.d },
    eventSaids: [verified.event.d, acceptedEvent.event.d],
    encodedBytes: 256,
    checkpoint: { kind: 'Absent' },
  });
  if (continued.kind !== 'Accepted') throw new Error('post-checkpoint batch rejected');
  const sealed = sealEvidenceStream(continued.stream, {
    exchangeSaid: `E${'l'.repeat(43)}`,
    eventCount: 3,
    finalSequence: 2,
    chainHeadSaid: acceptedEvent.event.d,
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
    events: [first.event, verified.event, acceptedEvent.event].map((event, index) =>
      encodeEvidenceEventDocument({
        ownerAid: taskOwnerAid,
        evidenceStreamId: run.binding.evidenceStreamId,
        batchSaid: `E${(index === 0 ? 'j' : 'k').repeat(43)}`,
        event,
        receivedAt: '2026-09-24T20:00:05.000Z',
      }),
    ),
    artifacts: [
      encodeEvidenceArtifactDocument({
        ownerAid: taskOwnerAid,
        runId: run.binding.runId,
        evidenceStreamId: run.binding.evidenceStreamId,
        artifact: artifact.artifact,
        bytes: raw,
        acceptedAt: '2026-09-24T20:00:05.000Z',
      }),
    ],
  };
}

function continuedCalibrationProof(
  options: {
    readonly consumed?: number;
    readonly debitConsumed?: number;
    readonly confirmed?: boolean;
  } = {},
) {
  const original = runFixture();
  const base = {
    ...original,
    consumedBudget: { ...original.consumedBudget, providerRequests: 2 },
    binding: { ...original.binding, ownerAid: taskOwnerAid, taskId, taskRevisionSaid },
  };
  const raw = new TextEncoder().encode('original calibration raw observation');
  const artifact = prepareEvidenceArtifact(raw, 'text/plain; charset=utf-8');
  if (artifact.kind !== 'Prepared') throw new Error('artifact fixture');
  const predecessor = sealedRunPredecessorFixture(
    [
      { kind: 'BudgetDebited', budget: 'providerRequests', amount: 2, consumed: 2 },
      { kind: 'Observation', source: 'Repository', artifactSaid: artifact.artifact.d },
    ],
    'ContextLimitReached',
    {
      run: base,
      leaseAt: '2026-09-24T20:00:00.000Z',
      at: '2026-09-24T20:00:01.000Z',
      completionConditionIds: ['public-check'],
    },
  );
  const admittedAt = '2026-09-24T20:10:00.000Z';
  const successor = {
    incarnationId: randomUUID(),
    evidenceStreamId: randomUUID(),
    harnessRevisionSaid: base.binding.initialHarnessRevisionSaid,
  };
  const prepared = prepareRunSuccessorSegment({
    version: 2,
    kind: 'CalibrationContinuationSegment',
    runId: base.binding.runId,
    taskId,
    taskRevisionSaid,
    ownerAid: taskOwnerAid,
    personalAgentAid: base.binding.personalAgentAid,
    taskMandateSaid: base.binding.taskMandateSaid,
    fromRunVersion: predecessor.run.version,
    predecessor: {
      incarnationId: predecessor.checkpoint.incarnationId,
      evidenceStreamId: base.binding.evidenceStreamId,
      checkpointSaid: predecessor.checkpoint.d,
      sealExchangeSaid: predecessor.sealExchangeSaid,
      finalSequence: predecessor.stream.cursor.acceptedThrough,
      chainHeadSaid: predecessor.chainHeadSaid,
    },
    successor,
    baseline: { pointerVersion: 1, harnessRevisionSaid: base.binding.initialHarnessRevisionSaid },
    consumedBudget: predecessor.run.consumedBudget,
    admittedAt,
  });
  if (prepared.kind !== 'Prepared') throw new Error('segment fixture rejected');
  const segment = prepared.segment;
  const continued = continueCalibrationRun(predecessor.run, {
    expectedRunVersion: predecessor.run.version,
    serverTime: admittedAt,
    predecessor: segment.predecessor,
    successor: { ...successor, segmentSaid: segment.d },
    baseline: { pointerVersion: 1, harnessRevisionSaid: base.binding.initialHarnessRevisionSaid },
    effects: 'Settled',
  });
  if (continued.kind !== 'Admitted') throw new Error('continuation fixture rejected');
  const events: EvidenceEvent[] = [];
  const firstEvent = predecessor.events[0];
  if (firstEvent === undefined) throw new Error('first event');
  const eventDraft = { ...firstEvent };
  Reflect.deleteProperty(eventDraft, 'd');
  if (predecessor.checkpoint.version !== 1) throw new Error('expected ordinary predecessor');
  const checkpointDraft = { ...predecessor.checkpoint };
  Reflect.deleteProperty(checkpointDraft, 'd');
  function add(event: EvidenceEvent['event']) {
    const prepared = prepareEvidenceEvent({
      ...eventDraft,
      incarnationId: successor.incarnationId,
      occurredAt: admittedAt,
      recordedAt: admittedAt,
      sequence: events.length,
      predecessor:
        events.length === 0
          ? { kind: 'Genesis' }
          : { kind: 'Previous', eventSaid: events.at(-1)?.d ?? '' },
      event,
    });
    if (prepared.kind !== 'Prepared') throw new Error('successor event fixture');
    events.push(prepared.event);
  }
  add({ kind: 'RunStarted', fromRunVersion: continued.run.version });
  add({
    kind: 'BudgetDebited',
    budget: 'providerRequests',
    amount: 2,
    consumed: options.debitConsumed ?? 4,
  });
  const consumedBudget = {
    ...continued.run.consumedBudget,
    providerRequests: options.consumed ?? 4,
  };
  const category = {
    version: 1 as const,
    taskId,
    taskRevisionSaid,
    harnessRevisionSaid: base.binding.initialHarnessRevisionSaid,
    currentCommandSaid: `E${'c'.repeat(43)}`,
    tamperCommandSaid: `E${'t'.repeat(43)}`,
    legacyCommandSaid: `E${'l'.repeat(43)}`,
    legacyObservedExitCode: 101 as const,
  };
  const rejected = preparePublicVerifierReceipt({
    version: 1,
    completionConditionId: 'public-check',
    commandSaid: category.legacyCommandSaid,
    recordedAt: admittedAt,
    outcome: {
      kind: 'Rejected',
      reason: { kind: 'UnexpectedExitCode', expected: 0, observed: 101 },
      elapsedMilliseconds: 10,
      outputArtifactSaids: [artifact.artifact.d],
    },
  });
  if (rejected.kind !== 'Prepared') throw new Error('rejected receipt fixture');
  const checkpoint = prepareVerifiedCheckpoint(
    {
      ...checkpointDraft,
      ...(options.confirmed
        ? {
            verifierReceipts: [rejected.receipt],
            runState: {
              kind: 'Ended' as const,
              outcome: { kind: 'CalibrationConfirmed' as const, category },
              verification: { kind: 'Rejected' as const },
            },
            continuation: { kind: 'NoContinuation' as const },
          }
        : {}),
      incarnationId: successor.incarnationId,
      evidence: {
        eventCount: events.length,
        finalSequence: events.length - 1,
        chainHeadSaid: events.at(-1)?.d ?? '',
      },
      budget: {
        consumed: consumedBudget,
        remaining: {
          ...base.binding.budget,
          providerRequests: base.binding.budget.providerRequests - consumedBudget.providerRequests,
        },
      },
    },
    ['public-check'],
  );
  if (checkpoint.kind !== 'Prepared') throw new Error('successor checkpoint fixture');
  if (options.confirmed) {
    add({ kind: 'CheckpointVerified', checkpointSaid: checkpoint.checkpoint.d });
    add({
      kind: 'RunCalibrationRecorded',
      checkpointSaid: checkpoint.checkpoint.d,
      disposition: { kind: 'Confirmed', category },
    });
    add({ kind: 'CheckpointAccepted', checkpointSaid: checkpoint.checkpoint.d });
  } else
    add({
      kind: 'RunBlocked',
      reason: 'ContextLimitReached',
      checkpointSaid: checkpoint.checkpoint.d,
    });
  const run: Run = {
    ...continued.run,
    consumedBudget,
    ...(options.confirmed ? { submissionVerification: { kind: 'Rejected' as const } } : {}),
    lifecycle: options.confirmed
      ? {
          kind: 'Ended',
          outcome: {
            kind: 'CalibrationConfirmed',
            category,
            checkpointSaid: checkpoint.checkpoint.d,
          },
        }
      : {
          kind: 'Active',
          phase: {
            kind: 'Blocked',
            reason: 'ContextLimitReached',
            checkpointSaid: checkpoint.checkpoint.d,
          },
        },
  };
  const stream = {
    ...predecessor.stream,
    binding: {
      ...predecessor.stream.binding,
      streamId: successor.evidenceStreamId,
      incarnationId: successor.incarnationId,
    },
    cursor: {
      kind: 'Continued' as const,
      acceptedThrough: events.length - 1,
      chainHeadSaid: events.at(-1)?.d ?? '',
    },
    provisional: {
      ...predecessor.stream.provisional,
      checkpointSaid: checkpoint.checkpoint.d,
      lifecycle: run.lifecycle,
      submissionVerification: run.submissionVerification,
    },
    seal: { kind: 'Sealed' as const, exchangeSaid: `E${'q'.repeat(43)}`, sealedAt: admittedAt },
  };
  return {
    task: taskDocument(),
    artifacts: [
      encodeEvidenceArtifactDocument({
        ownerAid: taskOwnerAid,
        runId: run.binding.runId,
        evidenceStreamId: base.binding.evidenceStreamId,
        artifact: artifact.artifact,
        bytes: raw,
        acceptedAt: admittedAt,
      }),
    ],
    runs: [encodeRunDocument(run, runCommandFingerprint)],
    segments: [
      {
        _id: segment.d,
        ownerAid: taskOwnerAid,
        runId: run.binding.runId,
        segment,
        acceptedAt: new Date(admittedAt),
      },
    ],
    streams: [predecessor.stream, stream].map(encodeEvidenceStreamDocument),
    checkpoints: [
      [predecessor.checkpoint, base.binding.evidenceStreamId],
      [checkpoint.checkpoint, successor.evidenceStreamId],
    ].map(([value, streamId]) => {
      if (typeof value === 'string' || typeof streamId !== 'string' || value === undefined)
        throw new Error('checkpoint fixture');
      return encodeEvidenceCheckpointDocument(
        {
          ownerAid: taskOwnerAid,
          evidenceStreamId: streamId,
          batchSaid: `E${'j'.repeat(43)}`,
          checkpoint: value,
          receivedAt: admittedAt,
        },
        ['public-check'],
      );
    }),
    events: [
      ...predecessor.events.map((event) => ({ event, streamId: base.binding.evidenceStreamId })),
      ...events.map((event) => ({ event, streamId: successor.evidenceStreamId })),
    ].map(({ event, streamId }) =>
      encodeEvidenceEventDocument({
        ownerAid: taskOwnerAid,
        evidenceStreamId: streamId,
        batchSaid: `E${'j'.repeat(43)}`,
        event,
        receivedAt: admittedAt,
      }),
    ),
  };
}

function matches(
  value: unknown,
  query: { readonly _id?: unknown; readonly evidenceStreamId?: unknown },
): boolean {
  if (typeof value !== 'object' || value === null) return false;
  return (['_id', 'evidenceStreamId'] as const).every((key) => {
    const expected = query[key];
    return (
      !(key in query) ||
      (typeof expected === 'object' &&
      expected !== null &&
      '$in' in expected &&
      Array.isArray(expected.$in)
        ? expected.$in.includes(Reflect.get(value, key))
        : Reflect.get(value, key) === expected)
    );
  });
}

function database(input: {
  task?: unknown;
  runs?: unknown[];
  evaluations?: unknown[];
  streams?: unknown[];
  checkpoints?: unknown[];
  events?: unknown[];
  artifacts?: unknown[];
  segments?: unknown[];
}): Db {
  const collections = new Map<string, unknown[]>([
    [runSuccessorSegmentsCollectionName, input.segments ?? []],
    ['tasks', input.task === undefined ? [] : [input.task]],
    ['runs', input.runs ?? []],
    [evaluationCollectionNames.evaluations, input.evaluations ?? []],
    [evidenceCollectionNames.streams, input.streams ?? []],
    [evidenceCollectionNames.checkpoints, input.checkpoints ?? []],
    [evidenceCollectionNames.events, input.events ?? []],
    [evidenceCollectionNames.artifacts, input.artifacts ?? []],
  ]);
  return {
    collection(name: string) {
      return {
        findOne: (query: { readonly _id?: unknown; readonly evidenceStreamId?: unknown }) =>
          Promise.resolve(
            (collections.get(name) ?? []).find((value) => matches(value, query)) ?? null,
          ),
        find: (query: { readonly _id?: unknown; readonly evidenceStreamId?: unknown }) => ({
          sort: () => ({
            toArray: () =>
              Promise.resolve(
                (collections.get(name) ?? []).filter((value) => matches(value, query)),
              ),
          }),
          toArray: () =>
            Promise.resolve((collections.get(name) ?? []).filter((value) => matches(value, query))),
        }),
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
  it('counts a same-Run calibration continuation once and rejects a missing predecessor seal', async () => {
    const proof = continuedCalibrationProof();
    expect(await new MongoTaskResidualAllowance(database(proof)).inspect(request)).toMatchObject({
      kind: 'Available',
      remaining: { providerRequests: 26 },
    });
    expect(
      await new MongoTaskResidualAllowance(
        database({ ...proof, streams: proof.streams.slice(1) }),
      ).inspect(request),
    ).toMatchObject({ kind: 'Blocked' });
  });

  it('counts a terminal confirmed successor including prior-stream raw verifier evidence exactly once', async () => {
    const proof = continuedCalibrationProof({ confirmed: true });
    expect(await new MongoTaskResidualAllowance(database(proof)).inspect(request)).toMatchObject({
      kind: 'Available',
      remaining: { providerRequests: 26 },
    });
  });

  it('rejects a substituted segment, replayed cumulative debit, or decreasing checkpoint budget', async () => {
    const proof = continuedCalibrationProof();
    const segment = proof.segments[0];
    if (segment === undefined) throw new Error('segment missing');
    for (const invalid of [
      { ...proof, segments: [{ ...segment, ownerAid: `E${'z'.repeat(43)}` }] },
      { ...proof, segments: [] },
      { ...proof, artifacts: [] },
      continuedCalibrationProof({ debitConsumed: 2 }),
      continuedCalibrationProof({ consumed: 1 }),
    ])
      expect(
        await new MongoTaskResidualAllowance(database(invalid)).inspect(request),
      ).toMatchObject({ kind: 'Blocked' });
  });

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
      events: proof.events,
      artifacts: proof.artifacts,
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
        database({ ...base, events: [proof.events[0], proof.events[2]] }),
      ).inspect(request),
    ).toEqual({ kind: 'Blocked', reason: 'RunProofInvalid' });
    expect(
      await new MongoTaskResidualAllowance(database({ ...base, artifacts: [] })).inspect(request),
    ).toEqual({ kind: 'Blocked', reason: 'RunProofMissing' });
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

  it('accounts for a terminal confirmed successor as one cumulative Run debit in real Mongo', async () => {
    await database.dropDatabase();
    const proof = continuedCalibrationProof({ confirmed: true });
    await database.collection<TaskDocument>(tasksCollectionName).insertOne(proof.task);
    await database.collection<RunDocument>(runsCollectionName).insertMany(proof.runs);
    await database
      .collection<EvidenceStreamDocument>(evidenceCollectionNames.streams)
      .insertMany(proof.streams);
    await database
      .collection<EvidenceCheckpointDocument>(evidenceCollectionNames.checkpoints)
      .insertMany(proof.checkpoints);
    await database
      .collection<EvidenceEventDocument>(evidenceCollectionNames.events)
      .insertMany(proof.events);
    await database
      .collection<RunSuccessorSegmentDocument>(runSuccessorSegmentsCollectionName)
      .insertMany(proof.segments);
    await database
      .collection<EvidenceArtifactDocument>(evidenceCollectionNames.artifacts)
      .insertMany(proof.artifacts);
    expect(await new MongoTaskResidualAllowance(database).inspect(request)).toMatchObject({
      kind: 'Available',
      remaining: { providerRequests: 26 },
    });
    const predecessor = proof.streams[0];
    if (predecessor === undefined) throw new Error('stream missing');
    await database
      .collection<EvidenceStreamDocument>(evidenceCollectionNames.streams)
      .updateOne({ _id: predecessor._id }, { $set: { seal: { kind: 'Open' } } });
    expect(await new MongoTaskResidualAllowance(database).inspect(request)).toMatchObject({
      kind: 'Blocked',
      reason: 'RunProofInvalid',
    });
  });

  it('reads the exact Task, all Task reservations, and does not count another Task or owner', async () => {
    await database.dropDatabase();
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

  it('counts a retained Run whose checkpoint is an authenticated prefix of a later sealed chain', async () => {
    const proof = sealedRunProof();
    await database.dropDatabase();
    await database.collection<TaskDocument>(tasksCollectionName).insertOne(taskDocument());
    await database.collection<RunDocument>(runsCollectionName).insertOne(proof.run);
    await database
      .collection<EvidenceStreamDocument>(evidenceCollectionNames.streams)
      .insertOne(proof.stream);
    await database
      .collection<EvidenceCheckpointDocument>(evidenceCollectionNames.checkpoints)
      .insertOne(proof.checkpoint);
    await database
      .collection<EvidenceEventDocument>(evidenceCollectionNames.events)
      .insertMany(proof.events);
    await database
      .collection<EvidenceArtifactDocument>(evidenceCollectionNames.artifacts)
      .insertMany(proof.artifacts);
    expect(await new MongoTaskResidualAllowance(database).inspect(request)).toMatchObject({
      kind: 'Available',
      remaining: { providerRequests: 26 },
    });
    const middle = proof.events[1];
    if (middle === undefined) throw new Error('fixture middle event missing');
    await database
      .collection<EvidenceEventDocument>(evidenceCollectionNames.events)
      .deleteOne({ _id: middle.event.d });
    expect(await new MongoTaskResidualAllowance(database).inspect(request)).toEqual({
      kind: 'Blocked',
      reason: 'RunProofInvalid',
    });
  });

  it('rechecks the verified residual inside admission before reserving D + 15B + F', async () => {
    const proof = sealedRunProof();
    await database.dropDatabase();
    await database.collection<TaskDocument>(tasksCollectionName).insertOne(taskDocument());
    await database.collection<RunDocument>(runsCollectionName).insertOne(proof.run);
    await database
      .collection<EvidenceStreamDocument>(evidenceCollectionNames.streams)
      .insertOne(proof.stream);
    await database
      .collection<EvidenceCheckpointDocument>(evidenceCollectionNames.checkpoints)
      .insertOne(proof.checkpoint);
    await database
      .collection<EvidenceEventDocument>(evidenceCollectionNames.events)
      .insertMany(proof.events);
    await database
      .collection<EvidenceArtifactDocument>(evidenceCollectionNames.artifacts)
      .insertMany(proof.artifacts);
    const admission = {
      ...reservation().command,
      allocation: { diagnosis: amount(1), perEntry: amount(2), finalization: amount(1) },
      originRunId: proof.run._id,
      retainedCheckpointSaid: proof.checkpoint._id,
      retainedSealSaid:
        proof.stream.seal.kind === 'Sealed' ? proof.stream.seal.exchangeSaid : `E${'s'.repeat(43)}`,
      personalAgentAid: proof.run.personalAgentAid,
      taskMandateSaid: proof.run.taskMandateSaid,
      expectedActiveRevisionSaid: proof.run.harnessRevisionSaid,
    };
    await database
      .collection<{
        _id: string;
        ownerAid: string;
        command: { taskId: string; taskRevisionSaid: string };
        sourceInventory: { d: string };
        executionProfile: { d: string; sourceGitCommit: string; sourceGitTree: string };
      }>(evaluationCollectionNames.preparations)
      .insertOne({
        _id: randomUUID(),
        ownerAid: taskOwnerAid,
        command: { taskId, taskRevisionSaid },
        sourceInventory: { d: admission.sourceInventorySaid },
        executionProfile: {
          d: admission.executionProfileSaid,
          sourceGitCommit: proof.run.repository.commit,
          sourceGitTree: proof.run.repository.tree,
        },
      });
    const reservations = new MongoEvaluationReservations(client, database);
    await expect(
      reservations.reserve({
        ownerAid: taskOwnerAid,
        command: admission,
        reserved: amount(32),
        verifiedMandateCeiling: amount(35),
      }),
    ).resolves.toEqual({ kind: 'Blocked', gate: 'Budget' });
    expect(
      await database.collection(evaluationCollectionNames.evaluations).countDocuments({}),
    ).toBe(0);
    const admitted = await reservations.reserve({
      ownerAid: taskOwnerAid,
      command: admission,
      reserved: amount(32),
      verifiedMandateCeiling: amount(40),
    });
    expect(admitted.kind).toBe('Admitted');
    expect(
      await database
        .collection<{ _id: string }>(evaluationCollectionNames.taskReservationFences)
        .findOne({ _id: taskId }),
    ).toMatchObject({ ownerAid: taskOwnerAid, taskRevisionSaid, version: 1 });
    expect(
      await reservations.reserve({
        ownerAid: taskOwnerAid,
        command: { ...admission, commandId: randomUUID() },
        reserved: amount(32),
        verifiedMandateCeiling: amount(40),
      }),
    ).toEqual({ kind: 'Blocked', gate: 'Budget' });
    expect(
      await database.collection(evaluationCollectionNames.evaluations).countDocuments({}),
    ).toBe(1);
  });
});
