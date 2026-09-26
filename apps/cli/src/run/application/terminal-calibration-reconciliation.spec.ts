import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  prepareEvidenceEvent,
  projectRun,
  type EvidenceEvent,
  type EvidenceStreamProjection,
  type AppendEvidenceBatchBody,
  type EvidenceBatchAcknowledgement,
} from '@devrandom/protocol';
import { SqliteEvidenceOutboxes } from '../infrastructure/sqlite-evidence-outbox.js';
import { deliverNextEvidencePage } from './evidence-delivery.js';
import {
  PreparedCompatibilityCalibration,
  type PreparedCompatibilityCalibrationRecord,
} from './prepared-compatibility-calibration.js';
import {
  acquireFirstRunLease,
  createRun,
  startRunExecution,
  recordRunCalibration,
  taskBudgetCeilings,
  type Run,
} from '@devrandom/domain';
import { describe, expect, it, vi } from 'vitest';
import { baselineHarnessCommandFixture } from '../../../test/baseline-harness-fixture.js';
import {
  TerminalCalibrationComposition,
  type TerminalCalibrationCompositionInput,
} from '../composition/terminal-calibration.js';
import { issuerAid } from '@devrandom/identity';
import { taskProjectionFixture } from '../../../test/task-source-fixture.js';
import {
  reconcileTerminalCalibrationRun,
  reconcileSealedTerminalCalibration,
  type TerminalCalibrationDependencies,
} from './terminal-calibration-reconciliation.js';

const said = (character: string): string => `E${character.repeat(43)}`;
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

describe('terminal calibration reconciliation', () => {
  it('stops at the accepted snapshot head even when the open stream offers a polling cursor', async () => {
    const run = calibrationRun();
    const head = said('x');
    const inspect = vi.fn().mockResolvedValue({
      kind: 'Found',
      page: {
        stream: {
          runId: run.binding.runId,
          evidenceStreamId: run.binding.evidenceStreamId,
          cursor: {
            kind: 'Accepted',
            eventCount: 1,
            acceptedThroughSequence: 0,
            chainHeadSaid: head,
          },
          checkpoint: { kind: 'Absent' },
          seal: { kind: 'Unsealed' },
        },
        events: [{ event: { d: head, sequence: 0 } }],
        nextCursor: 'poll-after-head',
      },
    });
    const input = {
      user: { principal: { aid: run.binding.ownerAid } },
      runId: run.binding.runId,
      task: taskProjectionFixture(),
      harness: baselineHarnessCommandFixture().revision,
      mandates: {
        executionAuthority: { personalAgentAid: run.binding.personalAgentAid },
        summary: {
          taskMandate: { credentialSaid: run.binding.taskMandateSaid },
          governor: { aid: run.binding.governorAid },
          promotionMandate: { credentialSaid: run.binding.promotionMandateSaid },
        },
      },
      runs: { inspect: () => Promise.resolve({ kind: 'Found', run: projectRun(run) }) },
      evidence: { inspect },
    } as unknown as TerminalCalibrationCompositionInput;
    await new TerminalCalibrationComposition({
      stateRoot: '/absent-calibration-fixture',
      issuerAid: issuerAid(said('A')),
      now: () => '2026-09-24T20:10:00.000Z',
      wait: () => Promise.resolve(),
    }).reconcile(input, new AbortController().signal);
    expect(inspect).toHaveBeenCalledTimes(1);
  });
  it.each(['Retained', 'LeaseCurrent', 'OwnerChanged'] as const)(
    'rejects %s before opening local custody or delivering evidence',
    async (mismatch) => {
      const original = calibrationRun();
      const run: Run =
        mismatch === 'Retained'
          ? { ...original, binding: { ...original.binding, purpose: { kind: 'Retained' } } }
          : original;
      const open = vi.fn();
      const dependencies = {
        now: () =>
          mismatch === 'LeaseCurrent' ? '2026-09-24T20:00:02.000Z' : '2026-09-24T20:10:00.000Z',
        outboxes: { reconcileCalibration: open },
      } as unknown as TerminalCalibrationDependencies;
      const outcome = await reconcileTerminalCalibrationRun(
        {
          run,
          hostedPrefix: [],
          ownerAid: mismatch === 'OwnerChanged' ? said('z') : run.binding.ownerAid,
          task: taskProjectionFixture(),
          harness: baselineHarnessCommandFixture().revision,
          stateRoot: '/tmp/not-opened',
        },
        dependencies,
      );
      expect(outcome).toEqual({ kind: 'BindingRejected' });
      expect(open).not.toHaveBeenCalled();
    },
  );
});

it.each(['Accepted', 'Rejected'] as const)(
  'preserves original accounting before terminal checkpoint and requires seal acknowledgement: %s',
  async (seal) => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-calibration-'));
    try {
      const original = calibrationRun();
      const run: Run = {
        ...original,
        binding: {
          ...original.binding,
          budget: { ...original.binding.budget, changedWorktreeBytes: 10 },
        },
      };
      let time = '2026-09-24T20:00:02.000Z';
      const outboxes = new SqliteEvidenceOutboxes(() => time);
      const opened = outboxes.open({ run, stateRoot: root });
      if (opened.kind !== 'Opened') throw new Error(opened.kind);
      const started = opened.recorder.record({
        occurredAt: time,
        producer: { kind: 'RunSupervisor' },
        event: { kind: 'RunStarted', fromRunVersion: run.version },
      });
      if (started.kind !== 'Recorded') throw new Error(started.kind);
      const acknowledge = (body: AppendEvidenceBatchBody): EvidenceBatchAcknowledgement => {
        const last = body.events.at(-1);
        if (last === undefined) throw new Error('empty batch');
        return {
          version: 1,
          disposition: { kind: 'Accepted' },
          runId: run.binding.runId,
          evidenceStreamId: run.binding.evidenceStreamId,
          batchSaid: body.batch.d,
          acceptedThroughSequence: last.sequence,
          chainHeadSaid: last.d,
          receivedAt: time,
        };
      };
      const originalBodies: AppendEvidenceBatchBody[] = [];
      const ordinary = {
        storeArtifact: vi.fn(),
        appendBatch: vi.fn((_runId: string, body: AppendEvidenceBatchBody) => {
          originalBodies.push(body);
          return Promise.resolve({ kind: 'Accepted' as const, acknowledgement: acknowledge(body) });
        }),
      };
      expect(
        (await deliverNextEvidencePage({ recorder: opened.recorder, hosted: ordinary })).kind,
      ).toBe('Delivered');
      expect(
        opened.recorder.recordBudgetDebit({
          occurredAt: time,
          producer: { kind: 'PiExecutor' },
          debits: [{ kind: 'BudgetDebited', budget: 'providerRequests', amount: 3, consumed: 3 }],
        }).kind,
      ).toBe('Recorded');
      opened.recorder.close();
      time = '2026-09-24T20:10:00.000Z';
      let record: PreparedCompatibilityCalibrationRecord | undefined;
      const calibration = new PreparedCompatibilityCalibration({
        load: () =>
          Promise.resolve(record === undefined ? { kind: 'NotFound' } : { kind: 'Loaded', record }),
        commit: (_count, next) => {
          record = next;
          return Promise.resolve({ kind: 'Committed' });
        },
      });
      const terminalBodies: AppendEvidenceBatchBody[] = [];
      const capture = vi.fn(() =>
        Promise.resolve({
          kind: 'Captured' as const,
          repository: {
            objectFormat: run.binding.repository.objectFormat,
            baseCommit: run.binding.repository.commit,
            baseTree: run.binding.repository.tree,
            changedFiles: [
              {
                path: 'src/parser.ts',
                disposition: 'Modified' as const,
                mode: '100644',
                contentSaid: said('x'),
              },
            ],
          },
          changedWorktreeBytes: 20,
        }),
      );
      const outcome = await reconcileTerminalCalibrationRun(
        {
          run,
          hostedPrefix: [started.event],
          ownerAid: run.binding.ownerAid,
          task: taskProjectionFixture(),
          harness: baselineHarnessCommandFixture().revision,
          stateRoot: root,
        },
        {
          outboxes,
          ordinary,
          terminal: {
            reconcileTerminalCalibration: (_runId, body) => {
              terminalBodies.push(body.body);
              return Promise.resolve({ kind: 'Accepted', acknowledgement: acknowledge(body.body) });
            },
          },
          repository: { capture },
          worktree: {
            directory: '/read-only-fixture',
            branch: 'fixture',
            repository: run.binding.repository,
          },
          calibration,
          now: () => time,
          sealing: (hosted) => ({
            settle: async (recorder) => {
              const delivery = await deliverNextEvidencePage({ recorder, hosted });
              expect(delivery.kind).toBe('Delivered');
              return seal === 'Accepted'
                ? { kind: 'Sealed' }
                : { kind: 'SealAcknowledgementRejected' };
            },
          }),
        },
      );
      expect(outcome.kind).toBe(seal === 'Accepted' ? 'Reconciled' : 'SealingRejected');
      expect(originalBodies).toHaveLength(2);
      expect(originalBodies[1]?.events[0]?.event).toEqual({
        kind: 'BudgetDebited',
        budget: 'providerRequests',
        amount: 3,
        consumed: 3,
      });
      expect(terminalBodies).toHaveLength(1);
      expect(terminalBodies[0]?.checkpoint?.budget.consumed.providerRequests).toBe(3);
      expect(terminalBodies[0]?.checkpoint?.budget.consumed.changedWorktreeBytes).toBe(20);
      expect(terminalBodies[0]?.checkpoint?.runState).toMatchObject({
        kind: 'Ended',
        outcome: { kind: 'CalibrationExcluded', reason: 'BudgetExhausted' },
      });
      expect(capture).toHaveBeenCalledTimes(1);
      expect(record?.attempts).toEqual(
        seal === 'Accepted'
          ? [{ kind: 'Excluded', runId: run.binding.runId, reason: 'BudgetExhausted' }]
          : undefined,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each(['Exact', 'Tampered', 'Unsealed'] as const)(
  'restores a sealed excluded calibration record only from exact hosted closure: %s',
  async (proof) => {
    const leased = calibrationRun();
    if (leased.lease.kind !== 'Held') throw new Error('lease');
    const started = startRunExecution(leased, {
      incarnationId: leased.lease.incarnationId,
      leaseObservedAt: '2026-09-24T20:00:02.000Z',
      worktree: { repository: leased.binding.repository },
      evidence: { kind: 'Genesis', streamId: leased.binding.evidenceStreamId },
    });
    if (started.kind !== 'Started') throw new Error(started.kind);
    const disposition = { kind: 'Excluded' as const, reason: 'BudgetExhausted' as const };
    const checkpointSaid = said('q');
    const ended = recordRunCalibration(started.run, { checkpointSaid, disposition });
    if (ended.kind !== 'Recorded') throw new Error(ended.kind);
    const events: EvidenceEvent[] = [];
    for (const event of [
      { kind: 'RunStarted' as const, fromRunVersion: leased.version },
      { kind: 'CheckpointVerified' as const, checkpointSaid },
      { kind: 'RunCalibrationRecorded' as const, checkpointSaid, disposition },
      { kind: 'CheckpointAccepted' as const, checkpointSaid },
    ]) {
      const previous = events.at(-1);
      const prepared = prepareEvidenceEvent({
        version: 1,
        sequence: events.length,
        predecessor:
          previous === undefined
            ? { kind: 'Genesis' }
            : { kind: 'Previous', eventSaid: previous.d },
        taskId: leased.binding.taskId,
        taskRevisionSaid: leased.binding.taskRevisionSaid,
        runId: leased.binding.runId,
        incarnationId: leased.lease.incarnationId,
        harnessRevisionSaid: leased.binding.initialHarnessRevisionSaid,
        personalAgentAid: leased.binding.personalAgentAid,
        taskMandateSaid: leased.binding.taskMandateSaid,
        occurredAt: '2026-09-24T20:00:02.000Z',
        recordedAt: '2026-09-24T20:00:02.000Z',
        producer: {
          kind:
            event.kind === 'RunStarted' || event.kind === 'RunCalibrationRecorded'
              ? 'RunSupervisor'
              : 'EvidenceRecorder',
        },
        event,
      });
      if (prepared.kind !== 'Prepared') throw new Error(prepared.kind);
      events.push(prepared.event);
    }
    const last = events.at(-1);
    if (last === undefined) throw new Error('last');
    const stream: EvidenceStreamProjection = {
      version: 1,
      runId: leased.binding.runId,
      evidenceStreamId: leased.binding.evidenceStreamId,
      cursor: {
        kind: 'Accepted',
        eventCount: events.length,
        acceptedThroughSequence: last.sequence,
        chainHeadSaid: last.d,
      },
      checkpoint: { kind: 'Accepted', checkpointSaid },
      seal:
        proof === 'Unsealed'
          ? { kind: 'Unsealed' }
          : {
              kind: 'Sealed',
              sealExchangeSaid: said('s'),
              eventCount: events.length,
              finalSequence: last.sequence,
              chainHeadSaid: last.d,
              sealedAt: '2026-09-24T20:10:00.000Z',
            },
    };
    const record = vi.fn(() =>
      Promise.resolve({
        kind: 'Recorded' as const,
        disposition: {
          kind: 'Collecting' as const,
          acceptedCleanRuns: 0,
          excludedRuns: 1,
          remainingAttempts: 4,
        },
      }),
    );
    const calibration = { record } as unknown as TerminalCalibrationDependencies['calibration'];
    const outcome = await reconcileSealedTerminalCalibration(
      {
        ownerAid: leased.binding.ownerAid,
        run: ended.run,
        hostedPrefix:
          proof === 'Tampered'
            ? events.map((event, index) => (index === 1 ? { ...event, d: said('x') } : event))
            : events,
        task: taskProjectionFixture(),
        harness: baselineHarnessCommandFixture().revision,
        stateRoot: '/not-opened',
      },
      stream,
      calibration,
    );
    expect(outcome.kind).toBe(proof === 'Exact' ? 'Reconciled' : 'BindingRejected');
    expect(record).toHaveBeenCalledTimes(proof === 'Exact' ? 1 : 0);
  },
);
