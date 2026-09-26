import { expect, it } from 'vitest';
import {
  acquireFirstRunLease,
  createRun,
  startRunExecution,
  continueCalibrationRun,
  taskBudgetCeilings,
  type Run,
} from '@devrandom/domain';
import {
  prepareEvidenceEvent,
  prepareRunSuccessorSegment,
  verifyInterruptedCalibrationPrefix,
  type EvidenceEvent,
  type EvidenceEventDetail,
} from '@devrandom/protocol';
import { baselineHarnessCommandFixture } from '../../../test/baseline-harness-fixture.js';
import { taskProjectionFixture } from '../../../test/task-source-fixture.js';
const said = (c: string) => `E${c.repeat(43)}`;
const campaignId = '57ed9f1a-b444-44b2-95c9-fd780c90a7dd';
function calibrationRun(): Run {
  const task = taskProjectionFixture();
  const harness = baselineHarnessCommandFixture().revision;
  const runId = '1cc482f1-98e9-4454-8e4c-5566cb47ce3d';
  const acceptedAt = '2026-09-24T20:00:00.000Z';
  const created = createRun({
    runId,
    ownerAid: task.ownerAid,
    taskId: task.taskId,
    taskRevisionSaid: task.revisionSaid,
    harnessLineageId: task.harnessLineageId,
    personalAgentAid: harness.authority.personalAgentAid,
    taskMandateSaid: harness.authority.taskMandateSaid,
    governorAid: said('g'),
    promotionMandateSaid: said('p'),
    initialHarnessRevisionSaid: harness.d,
    purpose: { kind: 'PreparedCompatibilityCalibration', campaignId, ordinal: 1 },
    initialSpecialization: {
      kind: 'InitialSpecializationAccepted',
      harnessLineageId: task.harnessLineageId,
      harnessRevisionSaid: harness.d,
      runId,
      acceptedAt,
    },
    repository: task.revision.repository,
    commandId: 'd2c9160a-58f8-4d43-ae67-22124c6e9112',
    admissionExchangeSaid: said('a'),
    evidenceStreamId: 'a1975db1-6130-41c2-b9dd-c8ec8bc12c94',
    budget: taskBudgetCeilings,
    acceptedAt,
  });
  if (created.kind !== 'Created') throw new Error('calibration Run fixture must create');
  const leased = acquireFirstRunLease(created.run, {
    incarnationId: 'ee87e11d-fb5f-46b4-841f-8a7a5faad97c',
    expectedRunVersion: 0,
    serverTime: '2026-09-24T20:00:01.000Z',
  });
  if (leased.kind !== 'Acquired' || leased.run.lease.kind !== 'Held') {
    throw new Error('calibration Run fixture must acquire its lease');
  }
  const started = startRunExecution(leased.run, {
    incarnationId: leased.run.lease.incarnationId,
    leaseObservedAt: '2026-09-24T20:00:02.000Z',
    worktree: { repository: leased.run.binding.repository },
    evidence: { kind: 'Genesis', streamId: leased.run.binding.evidenceStreamId },
  });
  if (started.kind !== 'Started') throw new Error('calibration Run fixture must start');
  return leased.run;
}

function fixture(checkpointSaid = said('c')) {
  const initial = calibrationRun();
  if (initial.lease.kind !== 'Held') throw Error('fixture');
  const prior: Run = {
    ...initial,
    version: 19,
    lifecycle: {
      kind: 'Active',
      phase: { kind: 'Blocked', reason: 'ContextLimitReached', checkpointSaid },
    },
    consumedBudget: { ...initial.consumedBudget, runWallTimeSeconds: 265, providerRequests: 7 },
  };
  const prepared = prepareRunSuccessorSegment({
    version: 2,
    kind: 'CalibrationContinuationSegment',
    runId: prior.binding.runId,
    taskId: prior.binding.taskId,
    taskRevisionSaid: prior.binding.taskRevisionSaid,
    ownerAid: prior.binding.ownerAid,
    personalAgentAid: prior.binding.personalAgentAid,
    taskMandateSaid: prior.binding.taskMandateSaid,
    fromRunVersion: 19,
    predecessor: {
      incarnationId: initial.lease.incarnationId,
      evidenceStreamId: prior.binding.evidenceStreamId,
      checkpointSaid,
      sealExchangeSaid: said('s'),
      finalSequence: 73,
      chainHeadSaid: said('h'),
    },
    successor: {
      incarnationId: '10000000-0000-4000-8000-000000000001',
      evidenceStreamId: '10000000-0000-4000-8000-000000000002',
      harnessRevisionSaid: prior.binding.initialHarnessRevisionSaid,
    },
    baseline: { pointerVersion: 1, harnessRevisionSaid: prior.binding.initialHarnessRevisionSaid },
    consumedBudget: prior.consumedBudget,
    admittedAt: '2026-09-24T20:02:00.000Z',
  });
  if (prepared.kind !== 'Prepared') throw Error('segment');
  const segment = prepared.segment;
  const continued = continueCalibrationRun(prior, {
    expectedRunVersion: 19,
    serverTime: segment.admittedAt,
    predecessor: segment.predecessor,
    successor: { ...segment.successor, segmentSaid: segment.d },
    baseline:
      segment.version === 2
        ? segment.baseline
        : { pointerVersion: 1, harnessRevisionSaid: prior.binding.initialHarnessRevisionSaid },
    effects: 'Settled',
  });
  if (continued.kind !== 'Admitted' || continued.run.lease.kind !== 'Held')
    throw Error('continuation');
  const run = continued.run;
  const events: EvidenceEvent[] = [];
  const append = (event: EvidenceEventDetail) => {
    const previous = events.at(-1);
    const prepared = prepareEvidenceEvent({
      version: 1,
      sequence: events.length,
      predecessor:
        previous === undefined ? { kind: 'Genesis' } : { kind: 'Previous', eventSaid: previous.d },
      taskId: run.binding.taskId,
      taskRevisionSaid: run.binding.taskRevisionSaid,
      runId: run.binding.runId,
      incarnationId: segment.successor.incarnationId,
      harnessRevisionSaid: run.binding.initialHarnessRevisionSaid,
      personalAgentAid: run.binding.personalAgentAid,
      taskMandateSaid: run.binding.taskMandateSaid,
      occurredAt: '2026-09-24T20:02:02.000Z',
      recordedAt: '2026-09-24T20:02:02.000Z',
      producer: { kind: 'RunSupervisor' },
      event,
    });
    if (prepared.kind !== 'Prepared') throw Error('event');
    events.push(prepared.event);
  };
  append({ kind: 'RunStarted', fromRunVersion: run.version });
  append({ kind: 'IncarnationStarted' });
  append({
    kind: 'RunExecutionProfileBound',
    executionProfileSaid: said('p'),
    profileArtifactSaid: said('a'),
    worktreeBranch: `devrandom/run/${run.binding.runId}`,
  });
  append({ kind: 'BudgetDebited', budget: 'runWallTimeSeconds', amount: 9, consumed: 274 });
  return { run, segment, events };
}
it('reconstructs startup without resetting inherited model or wall consumption', () => {
  const input = fixture();
  const verified = verifyInterruptedCalibrationPrefix(input);
  expect(verified).toMatchObject({
    kind: 'Verified',
    run: {
      lifecycle: { kind: 'Active', phase: { kind: 'Running' } },
      consumedBudget: { runWallTimeSeconds: 274, providerRequests: 7 },
    },
  });
  for (const altered of [
    input.events.slice(0, 3),
    [...input.events, ...input.events.slice(3)],
    input.events.slice(1),
  ])
    expect(verifyInterruptedCalibrationPrefix({ ...input, events: altered })).toEqual({
      kind: 'Rejected',
    });
  expect(
    verifyInterruptedCalibrationPrefix({
      ...input,
      run: { ...input.run, consumedBudget: { ...input.run.consumedBudget, providerRequests: 0 } },
    }),
  ).toEqual({ kind: 'Rejected' });
});

import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  prepareVerifiedCheckpoint,
  preparePublicVerifierReceipt,
  type AppendEvidenceBatchBody,
  type EvidenceBatchAcknowledgement,
  type RuntimeRecoveryReconciliationBody,
} from '@devrandom/protocol';
import { SqliteEvidenceOutboxes } from '../infrastructure/sqlite-evidence-outbox.js';
import { deliverNextEvidencePage } from './evidence-delivery.js';
import { reconcileInterruptedCalibration } from './interrupted-calibration-reconciliation.js';
it.each(['Exact', 'ChangedSource', 'ModelStarted', 'SealRejected', 'RetrySeal'] as const)(
  'reconciles actual durable startup custody only: %s',
  async (mode) => {
    const seed = fixture();
    const task = taskProjectionFixture();
    const receipts = baselineHarnessCommandFixture().revision.completionCommands.map((c) => {
      const p = preparePublicVerifierReceipt({
        version: 1,
        completionConditionId: c.identity,
        commandSaid: c.contentSaid,
        recordedAt: '2026-09-24T20:01:00.000Z',
        outcome: { kind: 'Unresolved', reason: 'RunBlocked' },
      });
      if (p.kind !== 'Prepared') throw Error('receipt');
      return p.receipt;
    });
    const remaining = { ...seed.run.binding.budget };
    for (const name of Object.keys(remaining) as (keyof typeof remaining)[])
      remaining[name] -= seed.segment.consumedBudget[name];
    const cp = prepareVerifiedCheckpoint(
      {
        version: 1,
        taskId: seed.run.binding.taskId,
        taskRevisionSaid: seed.run.binding.taskRevisionSaid,
        runId: seed.run.binding.runId,
        incarnationId: seed.segment.predecessor.incarnationId,
        harnessRevisionSaid: seed.run.binding.initialHarnessRevisionSaid,
        harnessLineageId: seed.run.binding.harnessLineageId,
        personalAgentAid: seed.run.binding.personalAgentAid,
        governorAid: seed.run.binding.governorAid,
        taskMandateSaid: seed.run.binding.taskMandateSaid,
        promotionMandateSaid: seed.run.binding.promotionMandateSaid,
        purpose: seed.run.binding.purpose,
        repository: {
          objectFormat: 'sha1',
          baseCommit: seed.run.binding.repository.commit,
          baseTree: seed.run.binding.repository.tree,
          changedFiles: [],
        },
        outputArtifactSaids: [],
        verifierReceipts: receipts,
        evidence: { eventCount: 1, finalSequence: 0, chainHeadSaid: said('e') },
        budget: { consumed: seed.segment.consumedBudget, remaining },
        runState: {
          kind: 'Active',
          phase: { kind: 'Blocked', reason: 'ContextLimitReached' },
          verification: { kind: 'NotSubmitted' },
        },
        continuation: { kind: 'ExternalResolutionRequired', reason: 'ContextLimitReached' },
      },
      task.revision.completionConditions.map((c) => c.id),
    );
    if (cp.kind !== 'Prepared' || cp.checkpoint.version !== 1) throw Error('checkpoint');
    const predecessorCheckpoint = cp.checkpoint;
    const { run, segment, events: planned } = fixture(cp.checkpoint.d);
    const root = await realpath(await mkdtemp(join(tmpdir(), 'interrupted-calibration-')));
    let time = '2026-09-24T20:02:02.000Z';
    const outboxes = new SqliteEvidenceOutboxes(() => time);
    try {
      const opened = outboxes.open({ run, stateRoot: root });
      if (opened.kind !== 'Opened') throw Error(opened.kind);
      const artifact = opened.recorder.storeArtifact({
        bytes: Buffer.from('profile fixture'),
        mediaType: 'text/plain; charset=utf-8',
      });
      if (artifact.kind !== 'Stored') throw Error(artifact.kind);
      const events: EvidenceEvent[] = [];
      for (const p of planned) {
        const recorded = opened.recorder.record({
          occurredAt: time,
          producer: p.producer,
          event:
            p.event.kind === 'RunExecutionProfileBound'
              ? { ...p.event, profileArtifactSaid: artifact.artifact.d }
              : p.event,
        });
        if (recorded.kind !== 'Recorded') throw Error(recorded.kind);
        events.push(recorded.event);
      }
      if (mode === 'ModelStarted') {
        const rec = opened.recorder.record({
          occurredAt: time,
          producer: { kind: 'PiExecutor' },
          event: {
            kind: 'ModelRequest',
            piSessionId: '10000000-0000-4000-8000-000000000099',
            modelTurnId: '10000000-0000-4000-8000-000000000099:0',
            provider: 'concentrate',
            model: 'fixture',
            maximumOutputTokens: 8192,
          },
        });
        expect(rec.kind).toBe('Recorded');
      }
      opened.recorder.close();
      time = '2026-09-24T20:03:00.000Z';
      const ordinary: AppendEvidenceBatchBody[] = [];
      const terminal: AppendEvidenceBatchBody[] = [];
      const ack = (body: AppendEvidenceBatchBody): EvidenceBatchAcknowledgement => {
        const last = body.events.at(-1);
        if (last === undefined) throw Error('batch');
        return {
          version: 1,
          disposition: { kind: 'Accepted' },
          runId: run.binding.runId,
          evidenceStreamId: segment.successor.evidenceStreamId,
          batchSaid: body.batch.d,
          acceptedThroughSequence: last.sequence,
          chainHeadSaid: last.d,
          receivedAt: time,
        };
      };
      const hosted = {
        storeArtifact: () =>
          Promise.resolve({
            kind: 'AlreadyStored' as const,
            acknowledgement: {
              version: 1 as const,
              disposition: 'AlreadyStored' as const,
              runId: run.binding.runId,
              artifact: artifact.artifact,
              receivedAt: time,
            },
          }),
        appendBatch: (_id: string, body: AppendEvidenceBatchBody) => {
          ordinary.push(body);
          return Promise.resolve({ kind: 'Accepted' as const, acknowledgement: ack(body) });
        },
        reconcileRuntimeRecovery: (_id: string, body: RuntimeRecoveryReconciliationBody) => {
          terminal.push(body.body);
          return Promise.resolve({ kind: 'Accepted' as const, acknowledgement: ack(body.body) });
        },
      };
      let sealingAttempts = 0;
      const reconcile = () =>
        reconcileInterruptedCalibration(
          {
            run,
            executionProfileSaid: said('p'),
            segment,
            task,
            hostedPrefix: events.slice(0, 2),
            predecessor: cp.checkpoint,
            stateRoot: root,
            worktree: {
              directory: '/fixture',
              branch: 'fixture',
              repository: run.binding.repository,
            },
            signal: new AbortController().signal,
          },
          {
            outboxes,
            hosted,
            repository: {
              capture: () =>
                Promise.resolve({
                  kind: 'Captured' as const,
                  repository: {
                    ...predecessorCheckpoint.repository,
                    ...(mode === 'ChangedSource' ? { baseTree: '0'.repeat(40) } : {}),
                  },
                  changedWorktreeBytes: 0,
                }),
            },
            now: () => time,
            sealing: (transport) => ({
              settle: async (recorder) => {
                sealingAttempts += 1;
                if (mode === 'SealRejected' || (mode === 'RetrySeal' && sealingAttempts === 1))
                  return { kind: 'SealAcknowledgementRejected' };
                expect((await deliverNextEvidencePage({ recorder, hosted: transport })).kind).toBe(
                  'Delivered',
                );
                return { kind: 'Sealed' };
              },
            }),
          },
        );
      let outcome = await reconcile();
      if (mode === 'RetrySeal') {
        expect(outcome.kind).toBe('Rejected');
        outcome = await reconcile();
      }
      expect(outcome.kind).toBe(
        mode === 'Exact' || mode === 'RetrySeal' ? 'Reconciled' : 'Rejected',
      );
      if (mode === 'Exact' || mode === 'RetrySeal') {
        expect(ordinary[0]?.events).toEqual(events);
        expect(terminal[0]?.events.map((e) => e.event.kind)).toEqual([
          'CheckpointVerified',
          'RunBlocked',
        ]);
        expect(terminal[0]?.checkpoint?.verifierReceipts).toEqual(
          predecessorCheckpoint.verifierReceipts,
        );
        expect(terminal[0]?.checkpoint?.budget.consumed).toMatchObject({
          providerRequests: 7,
          runWallTimeSeconds: 274,
        });
        expect(
          terminal[0]?.events.every((e) => e.recordedAt === time && e.occurredAt === time),
        ).toBe(true);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
