import type { EvidenceRecorder } from '@devrandom/runtime';
import { describe, expect, it, vi } from 'vitest';

import type { ExactChildCommand, ExactChildCommands } from './exact-child-command.js';
import { RunWorktreeCommands } from './run-worktree-commands.js';
import type {
  CheckpointRepository,
  CheckpointRepositoryCapture,
} from './verified-run-checkpoint.js';

const worktree = {
  directory: '/managed/worktree',
  branch: 'devrandom/run/fixture',
  repository: { objectFormat: 'sha1' as const, commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
};
const captured: CheckpointRepositoryCapture = {
  kind: 'Captured',
  repository: {
    objectFormat: 'sha1',
    baseCommit: 'a'.repeat(40),
    baseTree: 'b'.repeat(40),
    changedFiles: [],
  },
  changedWorktreeBytes: 0,
};
const completed = {
  kind: 'Completed' as const,
  exitCode: 0,
  terminationSignal: null,
  elapsedMilliseconds: 10,
  output: {
    disclosure: { kind: 'Recordable' as const },
    stdout: { path: '/capture/stdout', byteLength: 0 },
    stderr: { path: '/capture/stderr', byteLength: 0 },
    acknowledge: () => Promise.resolve({ kind: 'Cleaned' as const }),
  },
};
const command: ExactChildCommand = {
  executableRealpath: '/exact/executable',
  arguments: [],
  timeoutSeconds: 1,
  expectedExitCode: 0,
  budgetProducer: { kind: 'PublicTaskVerifier' },
};

function fixture() {
  const capture = vi.fn<CheckpointRepository['capture']>(() => Promise.resolve(captured));
  const run = vi.fn<ExactChildCommands['run']>(() => Promise.resolve(completed));
  const withhold = vi.fn<EvidenceRecorder['withhold']>(() => ({
    kind: 'SecretDetected',
    dataWithheldEventSaid: 'E'.padEnd(44, 'w'),
    securityViolationEventSaid: 'E'.padEnd(44, 'z'),
  }));
  const commands = new RunWorktreeCommands({
    worktree,
    limits: { changedFiles: 1, changedWorktreeBytes: 100 },
    repository: { capture },
    commands: { run },
    evidence: { withhold },
    now: () => '2026-09-24T20:00:04.000Z',
  });
  return { commands, capture, run, withhold };
}

describe('Run command worktree admission and reconciliation', () => {
  it('retains a lawful command outcome and checks the same Task limits before and after it', async () => {
    const { commands, capture, run } = fixture();
    const signal = new AbortController().signal;
    await expect(commands.run(command, signal)).resolves.toBe(completed);
    expect(run).toHaveBeenCalledExactlyOnceWith(command, signal);
    expect(capture.mock.calls).toEqual([
      [worktree, { changedFiles: 1, changedWorktreeBytes: 100 }, signal],
      [worktree, { changedFiles: 1, changedWorktreeBytes: 100 }, undefined],
    ]);
  });

  it.each(['BeforeInspection', 'DuringInspection'] as const)(
    'does not execute a command cancelled %s',
    async (timing) => {
      const { commands, capture, run } = fixture();
      const cancellation = new AbortController();
      if (timing === 'BeforeInspection') cancellation.abort();
      else
        capture.mockImplementationOnce(() => {
          cancellation.abort();
          return Promise.resolve(captured);
        });
      await expect(commands.run(command, cancellation.signal)).resolves.toEqual({
        kind: 'AbortedBeforeStart',
      });
      expect(capture).toHaveBeenCalledTimes(timing === 'BeforeInspection' ? 0 : 1);
      expect(run).not.toHaveBeenCalled();
    },
  );

  it('reconciles incurred mutation after cancellation while retaining the aborted child outcome', async () => {
    const { commands, capture, run } = fixture();
    const cancellation = new AbortController();
    const execution = {
      ...completed,
      kind: 'Aborted' as const,
      exitCode: null,
      terminationSignal: 'SIGTERM' as const,
    };
    run.mockImplementationOnce(() => {
      cancellation.abort();
      return Promise.resolve(execution);
    });
    capture
      .mockResolvedValueOnce(captured)
      .mockResolvedValueOnce({ kind: 'ChangedWorktreeLimitExceeded' });
    await expect(commands.run(command, cancellation.signal)).resolves.toEqual({
      kind: 'WorktreeReconciliationFailed',
      failure: 'BudgetExhausted',
      execution,
    });
    expect(capture.mock.calls.at(-1)?.[2]).toBeUndefined();
  });

  it.each(['GitUnavailable', 'RepositoryBindingRejected'] as const)(
    'closes command admission on %s without retrying an effect',
    async (kind) => {
      const { commands, capture, run } = fixture();
      capture.mockResolvedValueOnce({ kind });
      const outcome = { kind: 'WorktreeAdmissionRejected', failure: 'DependencyUnavailable' };
      await expect(commands.run(command, new AbortController().signal)).resolves.toEqual(outcome);
      await expect(commands.run(command, new AbortController().signal)).resolves.toEqual(outcome);
      expect(capture).toHaveBeenCalledOnce();
      expect(run).not.toHaveBeenCalled();
    },
  );

  it('retains observed output when post-command inspection itself fails', async () => {
    const { commands, capture } = fixture();
    capture.mockResolvedValueOnce(captured).mockRejectedValueOnce(new Error('Git unavailable'));
    await expect(commands.run(command, new AbortController().signal)).resolves.toEqual({
      kind: 'WorktreeReconciliationFailed',
      failure: 'DependencyUnavailable',
      execution: completed,
    });
  });

  it.each([
    { recording: 'OutboxBackpressure', failure: 'OutboxBackpressure' },
    { recording: 'OutboxBoundReached', failure: 'OutboxBackpressure' },
    { recording: 'Unavailable', failure: 'DependencyUnavailable' },
    { recording: 'ObservationRejected', failure: 'EvidenceIntegrityFailure' },
    { recording: 'LocalStateCorruption', failure: 'EvidenceIntegrityFailure' },
  ] as const)(
    'does not claim a retained secret disposition when withholding returns $recording',
    async ({ recording, failure }) => {
      const { commands, capture, run, withhold } = fixture();
      capture.mockResolvedValueOnce({
        kind: 'WithheldSecret',
        reason: 'Credential',
        byteLength: 25,
      });
      withhold.mockReturnValueOnce({ kind: recording });
      await expect(commands.run(command, new AbortController().signal)).resolves.toEqual({
        kind: 'WorktreeAdmissionRejected',
        failure,
      });
      expect(run).not.toHaveBeenCalled();
      expect(withhold).toHaveBeenCalledExactlyOnceWith({
        occurredAt: '2026-09-24T20:00:04.000Z',
        producer: command.budgetProducer,
        disclosure: { kind: 'WithheldSecret', reason: 'Credential', byteLength: 25 },
      });
    },
  );

  it.each(['SecretDetected', 'ProcessGroupSurvived', 'ProcessCleanupUnconfirmed'] as const)(
    'preserves %s instead of asserting a stable worktree after an unsafe command',
    async (kind) => {
      const { commands, capture, run } = fixture();
      const execution = { ...completed, kind };
      run.mockResolvedValueOnce(execution);
      await expect(commands.run(command, new AbortController().signal)).resolves.toBe(execution);
      await expect(commands.run(command, new AbortController().signal)).resolves.toEqual({
        kind: 'WorktreeAdmissionRejected',
        failure: kind === 'SecretDetected' ? 'SecretDetected' : 'EvidenceIntegrityFailure',
      });
      expect(capture).toHaveBeenCalledOnce();
      expect(run).toHaveBeenCalledOnce();
    },
  );
});
