import { acquireFirstRunLease, startRunExecution } from '@devrandom/domain';
import { decodeRunProjection } from '@devrandom/protocol';
import { describe, expect, it, vi } from 'vitest';

import { baselineHarnessCommandFixture } from '../../../test/baseline-harness-fixture.js';
import { runProjectionFixture, runIncarnationId } from '../../../test/run-fixture.js';
import { taskProjectionFixture } from '../../../test/task-source-fixture.js';
import type { PreparedCompatibilityFailures } from './prepared-compatibility.js';
import type { SubmittedResultVerification } from './public-task-verification.js';
import { RunSubmissions } from './run-submissions.js';

function runningRun() {
  const decoded = decodeRunProjection(runProjectionFixture());
  if (decoded.kind !== 'Accepted') throw new Error('Run fixture must decode');
  const leased = acquireFirstRunLease(decoded.run, {
    incarnationId: runIncarnationId,
    expectedRunVersion: 0,
    serverTime: '2026-09-24T20:00:01.000Z',
  });
  if (leased.kind !== 'Acquired') throw new Error('Run fixture must acquire lease');
  const started = startRunExecution(leased.run, {
    incarnationId: runIncarnationId,
    leaseObservedAt: '2026-09-24T20:00:02.000Z',
    worktree: { repository: leased.run.binding.repository },
    evidence: { kind: 'Genesis', streamId: leased.run.binding.evidenceStreamId },
  });
  if (started.kind !== 'Started') throw new Error('Run fixture must start');
  return started.run;
}

describe('Run submission adjudication and receipt custody', () => {
  it('keeps an unavailable artifact outside submission custody so a corrected result can settle', async () => {
    const accepted = { kind: 'Accepted' as const, receipts: [], outputArtifactSaids: [] };
    const verify = vi
      .fn<SubmittedResultVerification['verify']>()
      .mockResolvedValueOnce({ kind: 'ArtifactUnavailable' })
      .mockResolvedValueOnce(accepted);
    const classify = vi.fn<PreparedCompatibilityFailures['classify']>();
    const submissions = new RunSubmissions({
      task: taskProjectionFixture(),
      harness: baselineHarnessCommandFixture().revision,
      run: runningRun(),
      verification: { verify },
      compatibility: { classify },
    });
    const signal = new AbortController().signal;
    await expect(
      submissions.verify({ artifactSaids: [`E${'z'.repeat(43)}`] }, signal),
    ).resolves.toEqual({ kind: 'ArtifactUnavailable' });
    expect(submissions.transferSubmittedVerification()).toEqual({ kind: 'NoSubmission' });
    await expect(submissions.verify({ artifactSaids: [] }, signal)).resolves.toEqual(accepted);
    expect(submissions.transferSubmittedVerification()).toEqual({
      kind: 'Transferred',
      verification: accepted,
    });
    expect(classify).not.toHaveBeenCalled();
  });
  it.each(['NotConfirmed', 'Confirmed'] as const)(
    'preserves rejected receipts while classifying %s',
    async (kind) => {
      const run = runningRun();
      const task = taskProjectionFixture();
      const harness = baselineHarnessCommandFixture().revision;
      const rejected = {
        kind: 'Rejected' as const,
        feedback: 'Public completion condition rejected; output artifacts retain the details.',
        receipts: [],
        outputArtifactSaids: [`E${'x'.repeat(43)}`],
      };
      const verify = vi.fn<SubmittedResultVerification['verify']>(() => Promise.resolve(rejected));
      const classify = vi.fn<PreparedCompatibilityFailures['classify']>(() =>
        kind === 'NotConfirmed'
          ? { kind, reason: 'ReceiptPatternMismatch' }
          : {
              kind,
              category: {
                version: 1,
                taskId: task.taskId,
                taskRevisionSaid: task.revisionSaid,
                harnessRevisionSaid: harness.d,
                currentCommandSaid: `E${'c'.repeat(43)}`,
                tamperCommandSaid: `E${'t'.repeat(43)}`,
                legacyCommandSaid: `E${'l'.repeat(43)}`,
                legacyObservedExitCode: 101,
              },
              verifierReceiptSaids: [],
            },
      );
      const submissions = new RunSubmissions({
        task,
        harness,
        run,
        verification: { verify },
        compatibility: { classify },
      });
      const signal = new AbortController().signal;
      expect(submissions.transferSubmittedVerification()).toEqual({ kind: 'NoSubmission' });
      await expect(submissions.verify({ artifactSaids: [] }, signal)).resolves.toEqual({
        ...rejected,
        kind: kind === 'Confirmed' ? 'CompatibilityFailure' : 'Rejected',
      });
      expect(classify).toHaveBeenCalledExactlyOnceWith({
        task,
        harness,
        run,
        verification: rejected,
      });
      expect(submissions.transferSubmittedVerification()).toEqual({
        kind: 'Transferred',
        verification: rejected,
      });
      expect(submissions.transferSubmittedVerification()).toEqual({ kind: 'AlreadyTransferred' });
      await expect(submissions.verify({ artifactSaids: [] }, signal)).resolves.toEqual({
        kind: 'EvidenceIntegrityFailure',
      });
      expect(verify).toHaveBeenCalledTimes(1);
    },
  );

  it('retains the latest accepted verification after an ordinary rejection', async () => {
    const rejected = {
      kind: 'Rejected' as const,
      feedback: 'Public completion condition rejected; output artifacts retain the details.',
      receipts: [],
      outputArtifactSaids: [`E${'r'.repeat(43)}`],
    };
    const accepted = {
      kind: 'Accepted' as const,
      receipts: [],
      outputArtifactSaids: [`E${'a'.repeat(43)}`],
    };
    const verify = vi
      .fn<SubmittedResultVerification['verify']>()
      .mockResolvedValueOnce(rejected)
      .mockResolvedValueOnce(accepted);
    const classify = vi.fn<PreparedCompatibilityFailures['classify']>(() => ({
      kind: 'NotConfirmed',
      reason: 'ReceiptPatternMismatch',
    }));
    const submissions = new RunSubmissions({
      task: taskProjectionFixture(),
      harness: baselineHarnessCommandFixture().revision,
      run: runningRun(),
      verification: { verify },
      compatibility: { classify },
    });
    const signal = new AbortController().signal;
    await expect(submissions.verify({ artifactSaids: [] }, signal)).resolves.toEqual(rejected);
    await expect(submissions.verify({ artifactSaids: [] }, signal)).resolves.toEqual(accepted);
    expect(classify).toHaveBeenCalledTimes(1);
    expect(submissions.transferSubmittedVerification()).toEqual({
      kind: 'Transferred',
      verification: accepted,
    });
  });
});
