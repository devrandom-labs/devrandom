import {
  acquireFirstRunLease,
  beginRunSubmission,
  createRun,
  startRunExecution,
  taskBudgetCeilings,
  type Run,
} from '@devrandom/domain';
import {
  prepareEvidenceEvent,
  preparePublicVerifierReceipt,
  type BaselineHarnessRevision,
  type PublicVerifierReceipt,
} from '@devrandom/protocol';
import type {
  EvidenceObservation,
  EvidenceRecorder,
  EvidenceRecording,
  RunStopCause,
} from '@devrandom/runtime';
import { describe, expect, it, vi } from 'vitest';

import { baselineHarnessCommandFixture } from '../../../test/baseline-harness-fixture.js';
import { taskProjectionFixture } from '../../../test/task-source-fixture.js';
import type { SubmittedVerificationCustody } from './run-submissions.js';
import type { PreparedCompatibilityCalibrationConfirmations } from './prepared-compatibility-calibration.js';
import type { PreparedCompatibilityFailures } from './prepared-compatibility.js';
import { RetainedRunSettlement } from './retained-run-settlement.js';
import type { RunCheckpointing } from './verified-run-checkpoint.js';
import type { RunEvidenceSealing } from './sealed-evidence-settlement.js';
import type { RetainedSubmittedVerification } from './public-task-verification.js';

const said = (character: string): string => `E${character.repeat(43)}`;

function runningRun(): Run {
  const task = taskProjectionFixture();
  const harness = baselineHarnessCommandFixture().revision;
  const created = createRun({
    runId: '1cc482f1-98e9-4454-8e4c-5566cb47ce3d',
    ownerAid: task.ownerAid,
    taskId: task.taskId,
    taskRevisionSaid: task.revisionSaid,
    harnessLineageId: task.harnessLineageId,
    personalAgentAid: harness.authority.personalAgentAid,
    taskMandateSaid: harness.authority.taskMandateSaid,
    governorAid: said('g'),
    promotionMandateSaid: said('p'),
    initialHarnessRevisionSaid: harness.d,
    purpose: { kind: 'Retained' },
    initialSpecialization: {
      kind: 'InitialSpecializationAccepted',
      harnessLineageId: task.harnessLineageId,
      harnessRevisionSaid: harness.d,
      runId: '3cc482f1-98e9-4454-8e4c-5566cb47ce3d',
      acceptedAt: '2026-09-24T19:59:00.000Z',
    },
    repository: task.revision.repository,
    commandId: 'd2c9160a-58f8-4d43-ae67-22124c6e9112',
    admissionExchangeSaid: said('a'),
    evidenceStreamId: 'a1975db1-6130-41c2-b9dd-c8ec8bc12c94',
    budget: taskBudgetCeilings,
    acceptedAt: '2026-09-24T20:00:00.000Z',
  });
  if (created.kind !== 'Created') throw new Error('fixture Run must create');
  const leased = acquireFirstRunLease(created.run, {
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

function rejectedLegacyReceipt(harness: BaselineHarnessRevision): PublicVerifierReceipt {
  const command = harness.completionCommands.at(-1);
  if (command === undefined) throw new Error('fixture H1 must declare the legacy command');
  const prepared = preparePublicVerifierReceipt({
    version: 1,
    completionConditionId: command.identity,
    commandSaid: command.contentSaid,
    recordedAt: '2026-09-24T20:00:04.000Z',
    outcome: {
      kind: 'Rejected',
      reason: { kind: 'UnexpectedExitCode', expected: 0, observed: 101 },
      elapsedMilliseconds: 30,
      outputArtifactSaids: [],
    },
  });
  if (prepared.kind !== 'Prepared') throw new Error('fixture receipt must prepare');
  return prepared.receipt;
}

function recorder(run: Run, timeline: string[]): EvidenceRecorder {
  let sequence = 0;
  let predecessor:
    { readonly kind: 'Genesis' } | { readonly kind: 'Previous'; readonly eventSaid: string } = {
    kind: 'Genesis',
  };
  const close = vi.fn(() => timeline.push('closed'));
  return {
    run,
    readiness: () => ({
      kind: 'Ready',
      readiness:
        predecessor.kind === 'Genesis'
          ? { kind: 'Genesis', streamId: run.binding.evidenceStreamId }
          : {
              kind: 'Continued',
              streamId: run.binding.evidenceStreamId,
              nextSequence: sequence,
              previousEventSaid: predecessor.eventSaid,
            },
    }),
    recordBudgetDebit: () => ({ kind: 'Unavailable' }),
    withhold: () => ({ kind: 'Unavailable' }),
    record(observation: EvidenceObservation): EvidenceRecording {
      if (run.lease.kind !== 'Held') return { kind: 'ObservationRejected' };
      timeline.push(observation.event.kind);
      const prepared = prepareEvidenceEvent({
        version: 1,
        sequence,
        predecessor,
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
      if (prepared.kind !== 'Prepared') return { kind: 'ObservationRejected' };
      sequence += 1;
      predecessor = { kind: 'Previous', eventSaid: prepared.event.d };
      return { kind: 'Recorded', event: prepared.event };
    },
    page: () => ({ kind: 'Empty' }),
    acknowledge: () => ({ kind: 'AcknowledgementRejected' }),
    storeArtifact: () => ({ kind: 'ArtifactRejected' }),
    artifact: () => ({ kind: 'ArtifactNotFound' }),
    storeCheckpoint: () => ({ kind: 'CheckpointRejected' }),
    checkpoint: () => ({ kind: 'CheckpointNotFound' }),
    recordCheckpointAcceptance: () => ({ kind: 'Unavailable' }),
    recordSealAcknowledgement: () => ({ kind: 'AcknowledgementRejected' }),
    sealAcknowledgement: () => ({ kind: 'NotFound' }),
    close,
  };
}

describe('retained Run settlement', () => {
  it.each(['Sealed', 'SealObservationUnavailable'] as const)(
    'settles revoked authority only with its checkpoint and acknowledged seal: %s',
    async (sealKind) => {
      const run = runningRun();
      const timeline: string[] = [];
      const materialize = vi.fn<RunCheckpointing['materialize']>(() => {
        timeline.push('checkpoint');
        return Promise.resolve({ kind: 'Materialized', checkpoint: { d: said('k') } });
      });
      const receipts = baselineHarnessCommandFixture().revision.completionCommands.map(
        (command) => {
          const prepared = preparePublicVerifierReceipt({
            version: 1,
            completionConditionId: command.identity,
            commandSaid: command.contentSaid,
            recordedAt: '2026-09-24T20:00:04.000Z',
            outcome: { kind: 'Unresolved', reason: 'RunBlocked' },
          });
          if (prepared.kind !== 'Prepared') throw new Error('unresolved receipt must prepare');
          return prepared.receipt;
        },
      );
      const unresolvedReceipts = vi.fn(() => receipts);
      const classify = vi.fn<PreparedCompatibilityFailures['classify']>();
      const settlement = new RetainedRunSettlement({
        task: taskProjectionFixture(),
        harness: baselineHarnessCommandFixture().revision,
        evidence: recorder(run, timeline),
        custody: { transferSubmittedVerification: () => ({ kind: 'NoSubmission' }) },
        verification: { unresolvedReceipts },
        compatibility: { classify },
        calibration: { confirm: vi.fn() },
        checkpointing: { materialize },
        sealing: {
          settle: () => {
            timeline.push('seal');
            return Promise.resolve({ kind: sealKind });
          },
        },
        now: () => '2026-09-24T20:00:05.000Z',
      });
      const outcome = await settlement.settle({
        run,
        cause: { kind: 'ExecutorSettled', disposition: { kind: 'AuthorityRevoked' } },
        latestHostedRunVersion: run.version,
      });
      expect(outcome).toEqual(
        sealKind === 'Sealed'
          ? {
              kind: 'Settled',
              run: {
                ...run,
                version: run.version + 1,
                lifecycle: {
                  kind: 'Ended',
                  outcome: {
                    kind: 'AuthorityRevoked',
                    mandateSaid: run.binding.taskMandateSaid,
                    checkpointSaid: said('k'),
                  },
                },
              },
            }
          : {
              kind: 'EvidenceSealingFailed',
              failure: {
                kind: 'EvidenceSealingRejected',
                reason: 'SealObservationUnavailable',
              },
            },
      );
      expect(materialize).toHaveBeenCalledExactlyOnceWith({
        run,
        verifierReceipts: receipts,
        outputArtifactSaids: [],
        disposition: {
          runState: {
            kind: 'Ended',
            outcome: { kind: 'AuthorityRevoked', mandateSaid: run.binding.taskMandateSaid },
            verification: run.submissionVerification,
          },
          continuation: { kind: 'NoContinuation' },
        },
      });
      expect(unresolvedReceipts).toHaveBeenCalledExactlyOnceWith('RunBlocked');
      expect(classify).not.toHaveBeenCalled();
      expect(timeline).toEqual(['checkpoint', 'seal', 'closed']);
    },
  );

  it.each(['Sealed', 'SealObservationUnavailable'] as const)(
    'retains an accepted submission only after its seal is acknowledged: %s',
    async (sealKind) => {
      const run = runningRun();
      const harness = baselineHarnessCommandFixture().revision;
      const receipts = harness.completionCommands.map((command) => {
        const prepared = preparePublicVerifierReceipt({
          version: 1,
          completionConditionId: command.identity,
          commandSaid: command.contentSaid,
          recordedAt: '2026-09-24T20:00:04.000Z',
          outcome: {
            kind: 'Accepted',
            observedExitCode: 0,
            elapsedMilliseconds: 1,
            outputArtifactSaids: [],
          },
        });
        if (prepared.kind !== 'Prepared') throw new Error('accepted receipt must prepare');
        return prepared.receipt;
      });
      const timeline: string[] = [];
      const materialize = vi.fn<RunCheckpointing['materialize']>(() => {
        timeline.push('checkpoint');
        return Promise.resolve({ kind: 'Materialized', checkpoint: { d: said('k') } });
      });
      const classify = vi.fn<PreparedCompatibilityFailures['classify']>();
      const settlement = new RetainedRunSettlement({
        task: taskProjectionFixture(),
        harness,
        evidence: recorder(run, timeline),
        custody: {
          transferSubmittedVerification: () => ({
            kind: 'Transferred',
            verification: { kind: 'Accepted', receipts, outputArtifactSaids: [said('o')] },
          }),
        },
        verification: { unresolvedReceipts: vi.fn() },
        compatibility: { classify },
        calibration: { confirm: vi.fn() },
        checkpointing: { materialize },
        sealing: {
          settle: () => {
            timeline.push('seal');
            return Promise.resolve({ kind: sealKind });
          },
        },
        now: () => '2026-09-24T20:00:05.000Z',
      });
      const outcome = await settlement.settle({
        run,
        cause: {
          kind: 'ExecutorSettled',
          disposition: { kind: 'Completed', sessionId: 'session-1' },
        },
        latestHostedRunVersion: run.version,
      });
      expect(outcome).toEqual(
        sealKind === 'Sealed'
          ? {
              kind: 'Settled',
              run: {
                ...run,
                version: run.version + 2,
                lifecycle: {
                  kind: 'Ended',
                  outcome: { kind: 'Submitted', checkpointSaid: said('k') },
                },
                submissionVerification: { kind: 'Accepted' },
              },
            }
          : {
              kind: 'EvidenceSealingFailed',
              failure: {
                kind: 'EvidenceSealingRejected',
                reason: 'SealObservationUnavailable',
              },
            },
      );
      expect(materialize).toHaveBeenCalledExactlyOnceWith({
        run: { ...run, version: run.version + 1, submissionVerification: { kind: 'Pending' } },
        verifierReceipts: receipts,
        outputArtifactSaids: [said('o')],
        disposition: {
          runState: {
            kind: 'Ended',
            outcome: { kind: 'Submitted' },
            verification: { kind: 'Accepted' },
          },
          continuation: { kind: 'NoContinuation' },
        },
      });
      expect(classify).not.toHaveBeenCalled();
      expect(timeline).toEqual(['checkpoint', 'seal', 'closed']);
    },
  );

  it.each([
    { cause: { kind: 'UserInterrupted' }, reason: 'UserInterrupted' },
    {
      cause: {
        kind: 'LeaseKeeperSettled',
        disposition: { kind: 'LeaseLost', lastAcceptedRunVersion: 1 },
      },
      reason: 'LeaseLost',
    },
    ...(
      [
        'ApprovalRequired',
        'BudgetExhausted',
        'ContextLimitReached',
        'TaskMandateExpired',
        'OutboxBackpressure',
        'SecretDetected',
        'DependencyUnavailable',
      ] as const
    ).map((reason) => ({
      cause: {
        kind: 'ExecutorSettled' as const,
        disposition:
          reason === 'ContextLimitReached'
            ? {
                kind: reason,
                measurement: {
                  kind: 'InitialInput' as const,
                  encodedBytes: 100_000,
                  allowedInputTokens: 98_000,
                  providerRequestsAdmitted: 0 as const,
                },
              }
            : { kind: reason },
      },
      reason,
    })),
  ] satisfies readonly { cause: RunStopCause; reason: string }[])(
    'seals the exact $reason stop without classifying it as a compatibility failure',
    async ({ cause, reason }) => {
      const run = runningRun();
      const timeline: string[] = [];
      const evidence = recorder(run, timeline);
      const receipt = preparePublicVerifierReceipt({
        version: 1,
        completionConditionId: 'legacy-compatibility',
        commandSaid: said('c'),
        recordedAt: '2026-09-24T20:00:04.000Z',
        outcome: { kind: 'Unresolved', reason: 'RunBlocked' },
      });
      if (receipt.kind !== 'Prepared') throw new Error('unresolved receipt must prepare');
      const materialize = vi.fn<RunCheckpointing['materialize']>(() => {
        timeline.push('checkpoint');
        return Promise.resolve({ kind: 'Materialized', checkpoint: { d: said('k') } });
      });
      const classify = vi.fn<PreparedCompatibilityFailures['classify']>();
      const transferSubmittedVerification = vi.fn<
        SubmittedVerificationCustody['transferSubmittedVerification']
      >(() => ({ kind: 'NoSubmission' }));
      const settlement = new RetainedRunSettlement({
        task: taskProjectionFixture(),
        harness: baselineHarnessCommandFixture().revision,
        evidence,
        custody: { transferSubmittedVerification },
        verification: { unresolvedReceipts: () => [receipt.receipt] },
        compatibility: { classify },
        calibration: { confirm: vi.fn() },
        checkpointing: { materialize },
        sealing: {
          settle: () => {
            timeline.push('sealed');
            return Promise.resolve({ kind: 'Sealed' });
          },
        },
        now: () => '2026-09-24T20:00:05.000Z',
      });

      await expect(
        settlement.settle({ run, cause, latestHostedRunVersion: run.version }),
      ).resolves.toEqual({
        kind: 'Settled',
        run: {
          ...run,
          version: run.version + 1,
          lifecycle: {
            kind: 'Active',
            phase: { kind: 'Blocked', reason, checkpointSaid: said('k') },
          },
        },
      });
      expect(materialize).toHaveBeenCalledExactlyOnceWith({
        run,
        verifierReceipts: [receipt.receipt],
        outputArtifactSaids: [],
        disposition: {
          runState: {
            kind: 'Active',
            phase: { kind: 'Blocked', reason },
            verification: { kind: 'NotSubmitted' },
          },
          continuation:
            reason === 'UserInterrupted'
              ? { kind: 'LaterRuntimeRecoveryRequired' }
              : { kind: 'ExternalResolutionRequired', reason },
        },
      });
      expect(classify).not.toHaveBeenCalled();
      expect(timeline).toEqual(['checkpoint', 'RunBlocked', 'sealed', 'closed']);
    },
  );

  it('retains rejected public verification in the blocked checkpoint after interruption', async () => {
    const run = runningRun();
    const timeline: string[] = [];
    const receipt = rejectedLegacyReceipt(baselineHarnessCommandFixture().revision);
    const materialize = vi.fn<RunCheckpointing['materialize']>(() => {
      timeline.push('checkpoint');
      return Promise.resolve({ kind: 'Materialized', checkpoint: { d: said('k') } });
    });
    const seal = vi.fn<RunEvidenceSealing['settle']>(() => {
      timeline.push('seal');
      return Promise.resolve({ kind: 'Sealed' });
    });
    const settlement = new RetainedRunSettlement({
      task: taskProjectionFixture(),
      harness: baselineHarnessCommandFixture().revision,
      evidence: recorder(run, timeline),
      custody: {
        transferSubmittedVerification: () => ({
          kind: 'Transferred',
          verification: {
            kind: 'Rejected',
            feedback: 'Public completion condition rejected.',
            receipts: [receipt],
            outputArtifactSaids: [said('o')],
          },
        }),
      },
      verification: { unresolvedReceipts: vi.fn() },
      compatibility: { classify: vi.fn() },
      calibration: { confirm: vi.fn() },
      checkpointing: { materialize },
      sealing: { settle: seal },
      now: () => '2026-09-24T20:00:05.000Z',
    });

    const result = await settlement.settle({
      run,
      cause: { kind: 'UserInterrupted' },
      latestHostedRunVersion: run.version,
    });

    expect(result).toEqual({
      kind: 'Settled',
      run: {
        ...run,
        version: run.version + 3,
        lifecycle: {
          kind: 'Active',
          phase: { kind: 'Blocked', reason: 'UserInterrupted', checkpointSaid: said('k') },
        },
        submissionVerification: { kind: 'Rejected' },
      },
    });
    expect(materialize).toHaveBeenCalledTimes(1);
    expect(materialize.mock.calls[0]?.[0]).toMatchObject({
      run: { submissionVerification: { kind: 'Rejected' } },
      verifierReceipts: [receipt],
      outputArtifactSaids: [said('o')],
      disposition: {
        runState: {
          kind: 'Active',
          phase: { kind: 'Blocked', reason: 'UserInterrupted' },
          verification: { kind: 'Rejected' },
        },
        continuation: { kind: 'LaterRuntimeRecoveryRequired' },
      },
    });
    expect(seal).toHaveBeenCalledExactlyOnceWith(expect.anything(), said('k'));
    expect(timeline).toEqual(['checkpoint', 'RunBlocked', 'seal', 'closed']);
  });

  it('blocks only the rejected exact fixture after checkpointing and sealing the evidence chain', async () => {
    const task = taskProjectionFixture();
    const harness = baselineHarnessCommandFixture().revision;
    const run = runningRun();
    const receipt = rejectedLegacyReceipt(harness);
    const verification: RetainedSubmittedVerification = {
      kind: 'Rejected',
      feedback: 'Public completion condition rejected; output artifacts retain the details.',
      receipts: [receipt],
      outputArtifactSaids: [said('o')],
    };
    const custody: SubmittedVerificationCustody = {
      transferSubmittedVerification: vi.fn<
        SubmittedVerificationCustody['transferSubmittedVerification']
      >(() => ({ kind: 'Transferred', verification })),
    };
    const compatibility: PreparedCompatibilityFailures = {
      classify: vi.fn<PreparedCompatibilityFailures['classify']>(() => ({
        kind: 'Confirmed',
        category: {
          version: 1,
          taskId: task.taskId,
          taskRevisionSaid: task.revisionSaid,
          harnessRevisionSaid: harness.d,
          currentCommandSaid: harness.completionCommands[0]?.contentSaid ?? said('c'),
          tamperCommandSaid: harness.completionCommands[1]?.contentSaid ?? said('t'),
          legacyCommandSaid: receipt.commandSaid,
          legacyObservedExitCode: 101,
        },
        verifierReceiptSaids: [receipt.d],
      })),
    };
    const timeline: string[] = [];
    const confirmCalibration = vi.fn<PreparedCompatibilityCalibrationConfirmations['confirm']>(() =>
      Promise.resolve({ kind: 'Confirmed', acceptedCleanRuns: 4, excludedRuns: 1 }),
    );
    const calibration: PreparedCompatibilityCalibrationConfirmations = {
      confirm: confirmCalibration,
    };
    const evidence = recorder(run, timeline);
    const checkpointSaid = said('k');
    const checkpointing: RunCheckpointing = {
      materialize: vi.fn<RunCheckpointing['materialize']>((input) => {
        timeline.push('checkpoint');
        expect(input.run.submissionVerification).toEqual({ kind: 'Rejected' });
        expect(input.disposition).toEqual({
          runState: {
            kind: 'Active',
            phase: { kind: 'Blocked', reason: 'HarnessCompatibilityFailure' },
            verification: { kind: 'Rejected' },
          },
          continuation: { kind: 'LaterHarnessCompatibilityResolutionRequired' },
        });
        return Promise.resolve({ kind: 'Materialized', checkpoint: { d: checkpointSaid } });
      }),
    };
    const sealing: RunEvidenceSealing = {
      settle: vi.fn<RunEvidenceSealing['settle']>((_evidence, receivedCheckpointSaid) => {
        timeline.push('sealed');
        expect(receivedCheckpointSaid).toBe(checkpointSaid);
        return Promise.resolve({ kind: 'Sealed' });
      }),
    };
    const settlement = new RetainedRunSettlement({
      task,
      harness,
      evidence,
      custody,
      verification: { unresolvedReceipts: vi.fn() },
      compatibility,
      calibration,
      checkpointing,
      sealing,
      now: () => '2026-09-24T20:00:05.000Z',
    });

    const outcome = await settlement.settle({
      run,
      cause: {
        kind: 'ExecutorSettled',
        disposition: { kind: 'Completed', sessionId: 'session-1' },
      },
      latestHostedRunVersion: run.version,
    });

    expect(outcome).toMatchObject({
      kind: 'Settled',
      run: {
        lifecycle: {
          kind: 'Active',
          phase: {
            kind: 'Blocked',
            reason: 'HarnessCompatibilityFailure',
            checkpointSaid,
          },
        },
        submissionVerification: { kind: 'Rejected' },
      },
    });
    expect(timeline).toEqual(['FailureObserved', 'checkpoint', 'RunBlocked', 'sealed', 'closed']);
    expect(confirmCalibration).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        taskId: task.taskId,
        taskRevisionSaid: task.revisionSaid,
        harnessRevisionSaid: harness.d,
      }),
    );
    expect(beginRunSubmission(outcome.kind === 'Settled' ? outcome.run : run)).toEqual({
      kind: 'RunNotRunning',
    });
  });

  it('refuses to retain a matching live failure before the exact four-of-five calibration passes', async () => {
    const task = taskProjectionFixture();
    const harness = baselineHarnessCommandFixture().revision;
    const run = runningRun();
    const receipt = rejectedLegacyReceipt(harness);
    const checkpoint = vi.fn<RunCheckpointing['materialize']>();
    const seal = vi.fn<RunEvidenceSealing['settle']>();
    const timeline: string[] = [];
    const settlement = new RetainedRunSettlement({
      task,
      harness,
      evidence: recorder(run, timeline),
      verification: { unresolvedReceipts: vi.fn() },
      custody: {
        transferSubmittedVerification: () => ({
          kind: 'Transferred',
          verification: {
            kind: 'Rejected',
            feedback: 'Public completion condition rejected; output artifacts retain the details.',
            receipts: [receipt],
            outputArtifactSaids: [],
          },
        }),
      },
      compatibility: {
        classify: () => ({
          kind: 'Confirmed',
          category: {
            version: 1,
            taskId: task.taskId,
            taskRevisionSaid: task.revisionSaid,
            harnessRevisionSaid: harness.d,
            currentCommandSaid: harness.completionCommands[0]?.contentSaid ?? said('c'),
            tamperCommandSaid: harness.completionCommands[1]?.contentSaid ?? said('t'),
            legacyCommandSaid: receipt.commandSaid,
            legacyObservedExitCode: 101,
          },
          verifierReceiptSaids: [receipt.d],
        }),
      },
      calibration: { confirm: () => Promise.resolve({ kind: 'NotCalibrated' }) },
      checkpointing: { materialize: checkpoint },
      sealing: { settle: seal },
      now: () => '2026-09-24T20:00:05.000Z',
    });

    await expect(
      settlement.settle({
        run,
        cause: {
          kind: 'ExecutorSettled',
          disposition: { kind: 'Completed', sessionId: 'session-1' },
        },
        latestHostedRunVersion: run.version,
      }),
    ).resolves.toEqual({ kind: 'Unavailable' });
    expect(checkpoint).not.toHaveBeenCalled();
    expect(seal).not.toHaveBeenCalled();
    expect(timeline).toEqual(['closed']);
  });
});
