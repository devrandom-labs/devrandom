import {
  acquireFirstRunLease,
  startRunExecution,
  taskBudgetNames,
  type Run,
} from '@devrandom/domain';
import {
  decodeRunProjection,
  prepareEvidenceEvent,
  preparePublicVerifierReceipt,
  type PublicVerifierReceipt,
} from '@devrandom/protocol';
import {
  RunResourceBudget,
  type EvidenceObservation,
  type EvidenceRecorder,
  type EvidenceRecording,
} from '@devrandom/runtime';
import { describe, expect, it, vi } from 'vitest';

import { baselineHarnessCommandFixture } from '../../../test/baseline-harness-fixture.js';
import { runProjectionFixture } from '../../../test/run-fixture.js';
import { taskProjectionFixture } from '../../../test/task-source-fixture.js';
import type { PreparedRunWorktree } from './run-worktree.js';
import { VerifiedRunCheckpoint } from './verified-run-checkpoint.js';

const said = (character: string): string => `E${character.repeat(43)}`;

function runningRun(): Run {
  const decoded = decodeRunProjection(runProjectionFixture());
  if (decoded.kind !== 'Accepted') throw new Error('fixture Run must decode');
  const leased = acquireFirstRunLease(decoded.run, {
    incarnationId: 'ee87e11d-fb5f-46b4-841f-8a7a5faad97c',
    expectedRunVersion: 0,
    serverTime: '2026-09-24T20:00:01.000Z',
  });
  if (leased.kind !== 'Acquired' || leased.run.lease.kind !== 'Held') {
    throw new Error('fixture Run must acquire its lease');
  }
  const started = startRunExecution(leased.run, {
    incarnationId: leased.run.lease.incarnationId,
    leaseObservedAt: '2026-09-24T20:00:02.000Z',
    worktree: { repository: leased.run.binding.repository },
    evidence: { kind: 'Genesis', streamId: leased.run.binding.evidenceStreamId },
  });
  if (started.kind !== 'Started') throw new Error('fixture Run must start');
  return started.run;
}

function rejectedReceipt(): PublicVerifierReceipt {
  const command = baselineHarnessCommandFixture().revision.completionCommands[0];
  if (command === undefined) throw new Error('fixture H1 must declare a completion command');
  const prepared = preparePublicVerifierReceipt({
    version: 1,
    completionConditionId: command.identity,
    commandSaid: command.contentSaid,
    recordedAt: '2026-09-24T20:00:03.000Z',
    outcome: {
      kind: 'Rejected',
      reason: { kind: 'UnexpectedExitCode', expected: 0, observed: 1 },
      elapsedMilliseconds: 25,
      outputArtifactSaids: [said('x'), said('y')],
    },
  });
  if (prepared.kind !== 'Prepared') throw new Error('fixture receipt must prepare');
  return prepared.receipt;
}

function recorder(run: Run, timeline: string[]): EvidenceRecorder {
  const chainHead = said('h');
  return {
    run,
    readiness: () => ({
      kind: 'Ready',
      readiness: {
        kind: 'Continued',
        streamId: run.binding.evidenceStreamId,
        nextSequence: 3,
        previousEventSaid: chainHead,
      },
    }),
    recordBudgetDebit(input): EvidenceRecording {
      let recorded: EvidenceRecording = { kind: 'ObservationRejected' };
      for (const event of input.debits) {
        recorded = this.record({ occurredAt: input.occurredAt, producer: input.producer, event });
        if (recorded.kind !== 'Recorded') return recorded;
      }
      return recorded;
    },
    withhold: () => ({ kind: 'Unavailable' }),
    record(observation: EvidenceObservation): EvidenceRecording {
      timeline.push(observation.event.kind);
      if (run.lease.kind !== 'Held') return { kind: 'ObservationRejected' };
      const prepared = prepareEvidenceEvent({
        version: 1,
        sequence: 3,
        predecessor: { kind: 'Previous', eventSaid: chainHead },
        taskId: run.binding.taskId,
        taskRevisionSaid: run.binding.taskRevisionSaid,
        runId: run.binding.runId,
        incarnationId: run.lease.incarnationId,
        harnessRevisionSaid: run.binding.initialHarnessRevisionSaid,
        personalAgentAid: run.binding.personalAgentAid,
        taskMandateSaid: run.binding.taskMandateSaid,
        occurredAt: observation.occurredAt,
        recordedAt: observation.occurredAt,
        producer: observation.producer,
        event: observation.event,
      });
      return prepared.kind === 'Prepared'
        ? { kind: 'Recorded', event: prepared.event }
        : { kind: 'ObservationRejected' };
    },
    page: () => ({ kind: 'Empty' }),
    acknowledge: () => ({ kind: 'AcknowledgementRejected' }),
    storeArtifact: () => ({ kind: 'ArtifactRejected' }),
    artifact: () => ({ kind: 'ArtifactNotFound' }),
    storeCheckpoint: ({ checkpoint }) => {
      timeline.push('CheckpointStored');
      return { kind: 'Stored', checkpoint };
    },
    checkpoint: () => ({ kind: 'CheckpointNotFound' }),
    recordCheckpointAcceptance: () => ({ kind: 'Unavailable' }),
    recordSealAcknowledgement: () => ({ kind: 'AcknowledgementRejected' }),
    sealAcknowledgement: () => ({ kind: 'NotFound' }),
    close: vi.fn(),
  };
}

describe('verified Run checkpoint', () => {
  it.each(['Storage', 'Readiness', 'Observation', 'Concurrent'] as const)(
    'preserves one checkpoint and budget debit across $0 calls',
    async (failure) => {
      const run = runningRun();
      const timeline: string[] = [];
      const evidence = recorder(run, timeline);
      const storeCheckpoint = vi.spyOn(evidence, 'storeCheckpoint');
      if (failure === 'Storage') storeCheckpoint.mockReturnValueOnce({ kind: 'Unavailable' });
      if (failure === 'Readiness')
        vi.spyOn(evidence, 'readiness').mockReturnValueOnce({ kind: 'Unavailable' });
      if (failure === 'Observation') {
        const record = evidence.record.bind(evidence);
        let checkpointAttempts = 0;
        vi.spyOn(evidence, 'record').mockImplementation((observation) => {
          if (observation.event.kind === 'CheckpointVerified' && checkpointAttempts++ === 0)
            return { kind: 'Unavailable' };
          return record(observation);
        });
      }
      const budget = new RunResourceBudget({
        run,
        evidence,
        now: () => '2026-09-24T20:00:04.000Z',
      });
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
                contentSaid: said('f'),
              },
            ],
          },
          changedWorktreeBytes: 20,
        }),
      );
      const checkpointing = new VerifiedRunCheckpoint({
        task: taskProjectionFixture(),
        harness: baselineHarnessCommandFixture().revision,
        worktree: {
          directory: '/state/runs/run/worktree',
          branch: `devrandom/run/${run.binding.runId}`,
          repository: run.binding.repository,
        },
        evidence,
        budget,
        repository: { capture },
        now: () => '2026-09-24T20:00:04.000Z',
      });
      const input = {
        run,
        outputArtifactSaids: [said('x'), said('y')],
        verifierReceipts: [rejectedReceipt()],
        disposition: {
          runState: {
            kind: 'Active' as const,
            phase: { kind: 'Blocked' as const, reason: 'HarnessCompatibilityFailure' as const },
            verification: { kind: 'Rejected' as const },
          },
          continuation: { kind: 'LaterHarnessCompatibilityResolutionRequired' as const },
        },
      };
      if (failure !== 'Concurrent') {
        await expect(checkpointing.materialize(input)).resolves.toEqual({
          kind: 'EvidenceUnavailable',
        });
      }
      const [outcome, concurrent] = await Promise.all([
        checkpointing.materialize(input),
        checkpointing.materialize(input),
      ]);
      expect(concurrent).toEqual(outcome);
      expect(outcome.kind).toBe('Materialized');
      expect(budget.snapshot().changedFiles).toBe(1);
      expect(budget.snapshot().changedWorktreeBytes).toBe(20);
      expect(capture).toHaveBeenCalledTimes(1);
      if (failure === 'Storage' || failure === 'Observation') {
        expect(storeCheckpoint.mock.calls[1]?.[0]).toEqual(storeCheckpoint.mock.calls[0]?.[0]);
      } else expect(storeCheckpoint).toHaveBeenCalledTimes(1);
      await expect(checkpointing.materialize(input)).resolves.toEqual(outcome);
      expect(timeline).toEqual([
        'BudgetDebited',
        'BudgetDebited',
        ...(failure === 'Observation' ? ['CheckpointStored'] : []),
        'CheckpointStored',
        'CheckpointVerified',
      ]);
      await expect(
        checkpointing.materialize({ ...input, outputArtifactSaids: [] }),
      ).resolves.toEqual({ kind: 'BindingRejected' });
      expect(capture).toHaveBeenCalledTimes(1);
    },
  );

  it('reuses one atomic withholding pair across a lost checkpoint-store response', async () => {
    const run = runningRun();
    const timeline: string[] = [];
    const evidence = recorder(run, timeline);
    const disclosure = { kind: 'WithheldSecret', reason: 'Credential', byteLength: 43 } as const;
    const withhold = vi.fn<EvidenceRecorder['withhold']>(() => ({
      kind: 'SecretDetected',
      dataWithheldEventSaid: said('w'),
      securityViolationEventSaid: said('z'),
    }));
    vi.spyOn(evidence, 'readiness').mockReturnValue({
      kind: 'Ready',
      readiness: {
        kind: 'Continued',
        streamId: run.binding.evidenceStreamId,
        nextSequence: 5,
        previousEventSaid: said('z'),
      },
    });
    const store = vi.spyOn(evidence, 'storeCheckpoint');
    store.mockReturnValueOnce({ kind: 'Unavailable' });
    const budget = new RunResourceBudget({
      run,
      evidence,
      now: () => '2026-09-24T20:00:04.000Z',
    });
    const checkpointing = new VerifiedRunCheckpoint({
      task: taskProjectionFixture(),
      harness: baselineHarnessCommandFixture().revision,
      worktree: {
        directory: '/state/runs/run/worktree',
        branch: `devrandom/run/${run.binding.runId}`,
        repository: run.binding.repository,
      },
      evidence: { ...evidence, withhold },
      budget,
      repository: { capture: () => Promise.resolve(disclosure) },
      now: () => '2026-09-24T20:00:04.000Z',
    });
    const input = {
      run,
      outputArtifactSaids: [],
      verifierReceipts: [rejectedReceipt()],
      disposition: {
        runState: {
          kind: 'Active' as const,
          phase: { kind: 'Blocked' as const, reason: 'SecretDetected' as const },
          verification: { kind: 'Rejected' as const },
        },
        continuation: {
          kind: 'ExternalResolutionRequired' as const,
          reason: 'SecretDetected' as const,
        },
      },
    };
    await expect(checkpointing.materialize(input)).resolves.toEqual({
      kind: 'EvidenceUnavailable',
    });
    const settled = await checkpointing.materialize(input);
    expect(settled.kind).toBe('Materialized');
    if (settled.kind !== 'Materialized') throw new Error('privacy checkpoint must materialize');
    expect(settled.checkpoint.version).toBe(2);
    if (settled.checkpoint.version !== 2) throw new Error('privacy checkpoint version must be two');
    expect(settled.checkpoint.repository.repositoryMeasurement).toEqual({
      kind: 'UnavailableBecauseSecret',
      disclosure,
      dataWithheldEventSaid: said('w'),
      securityViolationEventSaid: said('z'),
    });
    expect(withhold).toHaveBeenCalledTimes(1);
    expect(store.mock.calls[1]?.[0]).toEqual(store.mock.calls[0]?.[0]);
    await expect(checkpointing.materialize(input)).resolves.toEqual(settled);
    expect(withhold).toHaveBeenCalledTimes(1);
    expect(budget.snapshot().changedFiles).toBe(0);
    expect(budget.snapshot().changedWorktreeBytes).toBe(0);
  });

  it.each([{ recording: { kind: 'Unavailable' }, terminal: 'EvidenceUnavailable' }] as const)(
    'refuses a protected-content checkpoint when withholding returns $recording.kind',
    async ({ recording, terminal }) => {
      const run = runningRun();
      const timeline: string[] = [];
      const evidence = recorder(run, timeline);
      const withhold = vi.fn<EvidenceRecorder['withhold']>(() => recording);
      const budget = new RunResourceBudget({
        run,
        evidence,
        now: () => '2026-09-24T20:00:04.000Z',
      });
      const disclosure = {
        kind: 'WithheldSecret' as const,
        reason: 'Credential' as const,
        byteLength: 43,
      };
      const checkpointing = new VerifiedRunCheckpoint({
        task: taskProjectionFixture(),
        harness: baselineHarnessCommandFixture().revision,
        worktree: {
          directory: '/state/runs/run/worktree',
          branch: `devrandom/run/${run.binding.runId}`,
          repository: run.binding.repository,
        },
        evidence: {
          ...evidence,
          withhold,
        },
        budget,
        repository: { capture: () => Promise.resolve(disclosure) },
        now: () => '2026-09-24T20:00:04.000Z',
      });

      await expect(
        checkpointing.materialize({
          run,
          outputArtifactSaids: [],
          verifierReceipts: [],
          disposition: {
            runState: {
              kind: 'Active',
              phase: { kind: 'Blocked', reason: 'SecretDetected' },
              verification: { kind: 'NotSubmitted' },
            },
            continuation: { kind: 'ExternalResolutionRequired', reason: 'SecretDetected' },
          },
        }),
      ).resolves.toEqual({ kind: terminal });
      expect(withhold).toHaveBeenCalledExactlyOnceWith({
        occurredAt: '2026-09-24T20:00:04.000Z',
        producer: { kind: 'EvidenceRecorder' },
        disclosure,
      });
      expect(timeline).toEqual([]);
      expect(budget.snapshot().changedFiles).toBe(0);
      expect(budget.snapshot().changedWorktreeBytes).toBe(0);
    },
  );

  it.each([
    {
      providerOutputTokens: 0,
      changedFiles: 256,
      changedWorktreeBytes: 16 * 1024 * 1024,
      reason: 'HarnessCompatibilityFailure',
      expectation: 'Materialized',
    },
    {
      providerOutputTokens: 100_001,
      changedFiles: 256,
      changedWorktreeBytes: 16 * 1024 * 1024,
      reason: 'BudgetExhausted',
      expectation: 'Materialized',
    },
    {
      providerOutputTokens: 0,
      changedFiles: 0,
      changedWorktreeBytes: 0,
      reason: 'BudgetExhausted',
      expectation: 'Materialized',
    },
    {
      providerOutputTokens: 0,
      changedFiles: 1,
      changedWorktreeBytes: 10,
      reason: 'BudgetExhausted',
      expectation: 'Materialized',
    },
    {
      providerOutputTokens: 0,
      changedFiles: 0,
      changedWorktreeBytes: 0,
      reason: 'HarnessCompatibilityFailure',
      expectation: 'ChangedFileLimitExceeded',
    },
    {
      providerOutputTokens: 0,
      changedFiles: 1,
      changedWorktreeBytes: 10,
      reason: 'HarnessCompatibilityFailure',
      expectation: 'ChangedWorktreeLimitExceeded',
    },
  ] as const)(
    '$reason with $providerOutputTokens tokens and $changedFiles/$changedWorktreeBytes ceilings yields $expectation',
    async ({ providerOutputTokens, changedFiles, changedWorktreeBytes, reason, expectation }) => {
      const base = runningRun();
      const run = {
        ...base,
        binding: {
          ...base.binding,
          budget: { ...base.binding.budget, changedFiles, changedWorktreeBytes },
        },
        consumedBudget: { ...base.consumedBudget, providerOutputTokens },
      };
      const task = taskProjectionFixture();
      const harness = baselineHarnessCommandFixture().revision;
      const worktree: PreparedRunWorktree = {
        directory: '/state/runs/run/worktree',
        branch: `devrandom/run/${run.binding.runId}`,
        repository: run.binding.repository,
      };
      const timeline: string[] = [];
      const evidence = recorder(run, timeline);
      const budget = new RunResourceBudget({
        run,
        evidence,
        now: () => '2026-09-24T20:00:04.000Z',
      });
      const providerReservation = budget.reserve([{ budget: 'providerRequests', amount: 1 }]);
      if (providerReservation.kind !== 'Reserved') {
        throw new Error('provider request fixture reservation must fit');
      }
      expect(
        budget.commit(providerReservation.reservation, {
          producer: { kind: 'PiExecutor' },
          actual: [{ budget: 'providerRequests', amount: 1 }],
        }),
      ).toEqual({ kind: 'Committed' });
      const capture = vi.fn(() =>
        Promise.resolve({
          kind: 'Captured' as const,
          repository: {
            objectFormat: 'sha1' as const,
            baseCommit: run.binding.repository.commit,
            baseTree: run.binding.repository.tree,
            changedFiles: [
              {
                path: 'src/parser.ts',
                disposition: 'Modified' as const,
                mode: '100644',
                contentSaid: said('f'),
              },
            ],
          },
          changedWorktreeBytes: 20,
        }),
      );
      const checkpointing = new VerifiedRunCheckpoint({
        task,
        harness,
        worktree,
        evidence,
        budget,
        repository: { capture },
        now: () => '2026-09-24T20:00:04.000Z',
      });

      const outcome = await checkpointing.materialize({
        run,
        outputArtifactSaids: [said('x'), said('y')],
        verifierReceipts: [rejectedReceipt()],
        disposition: {
          runState: {
            kind: 'Active',
            phase: { kind: 'Blocked', reason },
            verification: { kind: 'Rejected' },
          },
          continuation:
            reason === 'BudgetExhausted'
              ? { kind: 'ExternalResolutionRequired', reason }
              : { kind: 'LaterHarnessCompatibilityResolutionRequired' },
        },
      });

      expect(capture).toHaveBeenCalledWith(worktree, {
        changedFiles: 256,
        changedWorktreeBytes: reason === 'BudgetExhausted' ? 32 * 1024 * 1024 : 16 * 1024 * 1024,
      });

      if (expectation !== 'Materialized') {
        expect(outcome).toEqual({ kind: 'RepositoryRejected', reason: expectation });
        expect(budget.snapshot().changedFiles).toBe(0);
        expect(budget.snapshot().changedWorktreeBytes).toBe(0);
        expect(timeline).toEqual(['BudgetDebited']);
        return;
      }
      expect(outcome).toMatchObject({
        kind: 'Materialized',
        checkpoint: {
          taskId: task.taskId,
          taskRevisionSaid: task.revisionSaid,
          runId: run.binding.runId,
          harnessRevisionSaid: harness.d,
          repository: {
            baseCommit: run.binding.repository.commit,
            baseTree: run.binding.repository.tree,
            changedFiles: [{ path: 'src/parser.ts', disposition: 'Modified' }],
          },
          evidence: { eventCount: 3, finalSequence: 2, chainHeadSaid: said('h') },
          runState: {
            kind: 'Active',
            phase: { kind: 'Blocked', reason },
          },
        },
      });
      if (outcome.kind !== 'Materialized') throw new Error('checkpoint must materialize');
      for (const budget of taskBudgetNames) {
        const expected =
          budget === 'changedFiles'
            ? Math.max(0, run.binding.budget[budget] - 1)
            : budget === 'changedWorktreeBytes'
              ? Math.max(0, run.binding.budget[budget] - 20)
              : budget === 'providerRequests'
                ? Math.max(0, run.binding.budget[budget] - 1)
                : budget === 'providerOutputTokens'
                  ? Math.max(0, run.binding.budget[budget] - providerOutputTokens)
                  : run.binding.budget[budget];
        expect(outcome.checkpoint.budget.remaining[budget]).toBe(expected);
      }
      expect(outcome.checkpoint.budget.consumed.providerOutputTokens).toBe(providerOutputTokens);
      expect(outcome.checkpoint.budget.consumed.changedFiles).toBe(1);
      expect(outcome.checkpoint.budget.consumed.changedWorktreeBytes).toBe(20);
      expect(outcome.checkpoint.budget.consumed.providerRequests).toBe(1);
      expect(timeline).toEqual([
        'BudgetDebited',
        'BudgetDebited',
        'BudgetDebited',
        'CheckpointStored',
        'CheckpointVerified',
      ]);
    },
  );
});
