import {
  acquireFirstRunLease,
  createRun,
  startRunExecution,
  taskBudgetCeilings,
  type Run,
} from '@devrandom/domain';
import {
  prepareEvidenceEvent,
  preparePublicVerifierReceipt,
  type EvidenceEvent,
  type PublicVerifierReceipt,
} from '@devrandom/protocol';
import type { EvidenceObservation, EvidenceRecording, RunStopCause } from '@devrandom/runtime';
import { describe, expect, it, vi } from 'vitest';

import { baselineHarnessCommandFixture } from '../../../test/baseline-harness-fixture.js';
import { taskProjectionFixture } from '../../../test/task-source-fixture.js';
import type { SubmittedVerificationCustody } from './run-submissions.js';
import {
  PreparedCompatibilityCalibration,
  type CompatibilityCalibrationRecords,
  type PreparedCompatibilityCalibrationRecord,
  type PreparedCompatibilityCalibrationSettlements,
  type PreparedCompatibilityProviderProof,
} from './prepared-compatibility-calibration.js';
import {
  PreparedCompatibilityCalibrationSettlement,
  type PreparedCompatibilityEvidence,
  type PreparedCompatibilityProviderProofs,
} from './prepared-compatibility-calibration-settlement.js';
import type { PreparedCompatibilityFailures } from './prepared-compatibility.js';
import type { RunCheckpointing } from './verified-run-checkpoint.js';
import type { RunEvidenceSealing } from './sealed-evidence-settlement.js';
import type { RetainedSubmittedVerification } from './public-task-verification.js';

const said = (character: string): string => `E${character.repeat(43)}`;
const campaignId = '57ed9f1a-b444-44b2-95c9-fd780c90a7dd';

function runningCalibrationRun(): Run {
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
  return started.run;
}

function receipt(): PublicVerifierReceipt {
  const command = baselineHarnessCommandFixture().revision.completionCommands[0];
  if (command === undefined) throw new Error('fixture H1 must declare a completion command');
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
  if (prepared.kind !== 'Prepared') throw new Error('receipt fixture must prepare');
  return prepared.receipt;
}

function acceptedReceipts(): readonly PublicVerifierReceipt[] {
  return baselineHarnessCommandFixture().revision.completionCommands.map((command) => {
    const prepared = preparePublicVerifierReceipt({
      version: 1,
      completionConditionId: command.identity,
      commandSaid: command.contentSaid,
      recordedAt: '2026-09-24T20:00:04.000Z',
      outcome: {
        kind: 'Accepted',
        observedExitCode: 0,
        elapsedMilliseconds: 30,
        outputArtifactSaids: [],
      },
    });
    if (prepared.kind !== 'Prepared') throw new Error('accepted receipt fixture must prepare');
    return prepared.receipt;
  });
}

function unresolvedReceipt(
  reason: 'NotAttempted' | 'RunBlocked' = 'NotAttempted',
): PublicVerifierReceipt {
  const command = baselineHarnessCommandFixture().revision.completionCommands[0];
  if (command === undefined) throw new Error('fixture H1 must declare a completion command');
  const prepared = preparePublicVerifierReceipt({
    version: 1,
    completionConditionId: command.identity,
    commandSaid: command.contentSaid,
    recordedAt: '2026-09-24T20:00:04.000Z',
    outcome: { kind: 'Unresolved', reason },
  });
  if (prepared.kind !== 'Prepared') throw new Error('unresolved receipt fixture must prepare');
  return prepared.receipt;
}

function evidenceEvent(
  run: Run,
  sequence: number,
  predecessor: EvidenceEvent['predecessor'],
  producer: EvidenceEvent['producer'],
  event: EvidenceEvent['event'],
): EvidenceEvent {
  if (run.lease.kind !== 'Held') throw new Error('fixture Run must hold its lease');
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
    occurredAt: '2026-09-24T20:00:03.000Z',
    recordedAt: '2026-09-24T20:00:03.001Z',
    producer,
    event,
  });
  if (prepared.kind !== 'Prepared') throw new Error('provider evidence fixture must prepare');
  return prepared.event;
}

function providerProof(run: Run): PreparedCompatibilityProviderProof {
  const attribution = {
    piSessionId: '46df3dc0-ff4f-4607-9c25-cad3b378e875',
    modelTurnId: 'turn-0',
    toolCallId: 'call-0',
    proposalIndex: 0,
    tool: 'run_tests' as const,
    requiredCapability: 'RunTests' as const,
    resource: `command://cesr-current@${said('c')}`,
  };
  const message = evidenceEvent(
    run,
    0,
    { kind: 'Genesis' },
    { kind: 'PiExecutor' },
    {
      kind: 'ModelMessageCompleted',
      piSessionId: attribution.piSessionId,
      modelTurnId: attribution.modelTurnId,
      messageArtifactSaid: said('m'),
      disposition: 'Completed',
      usage: {
        inputTokens: 120,
        outputTokens: 40,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        spendMicroUsd: 800,
      },
    },
  );
  const proposal = evidenceEvent(
    run,
    1,
    { kind: 'Previous', eventSaid: message.d },
    { kind: 'ToolGateway' },
    { kind: 'ToolProposed', ...attribution },
  );
  const effect = evidenceEvent(
    run,
    2,
    { kind: 'Previous', eventSaid: proposal.d },
    { kind: 'ToolGateway' },
    { kind: 'EffectCompleted', ...attribution, outputArtifactSaids: [said('o')] },
  );
  return { message, proposal, effect };
}

class MemoryCalibrationRecords implements CompatibilityCalibrationRecords {
  record: PreparedCompatibilityCalibrationRecord | undefined;
  readonly timeline: string[];

  constructor(timeline: string[]) {
    this.timeline = timeline;
  }

  load() {
    return Promise.resolve(
      this.record === undefined
        ? ({ kind: 'NotFound' } as const)
        : ({ kind: 'Loaded', record: this.record } as const),
    );
  }

  commit(expectedAttemptCount: number, record: PreparedCompatibilityCalibrationRecord) {
    if ((this.record?.attempts.length ?? 0) !== expectedAttemptCount) {
      return Promise.resolve({ kind: 'Conflict' as const });
    }
    this.timeline.push('local-calibration-recorded');
    this.record = record;
    return Promise.resolve({ kind: 'Committed' as const });
  }
}

function recorder(
  run: Run,
  timeline: string[],
  read: PreparedCompatibilityProviderProofs['read'] = () => ({ kind: 'NotFound' }),
): PreparedCompatibilityEvidence {
  let sequence = 3;
  let predecessor = said('m');
  return {
    run,
    readiness: () => ({
      kind: 'Ready',
      readiness: {
        kind: 'Continued',
        streamId: run.binding.evidenceStreamId,
        nextSequence: sequence,
        previousEventSaid: predecessor,
      },
    }),
    recordBudgetDebit: () => ({ kind: 'Unavailable' }),
    withhold: () => ({ kind: 'Unavailable' }),
    record(observation: EvidenceObservation): EvidenceRecording {
      timeline.push(observation.event.kind);
      if (run.lease.kind !== 'Held') return { kind: 'ObservationRejected' };
      const prepared = prepareEvidenceEvent({
        version: 1,
        sequence,
        predecessor: { kind: 'Previous', eventSaid: predecessor },
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
      predecessor = prepared.event.d;
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
    read,
    close: () => timeline.push('closed'),
  };
}

function confirmedDependencies(
  run: Run,
  timeline: string[],
  proofReading: ReturnType<PreparedCompatibilityProviderProofs['read']>,
) {
  const task = taskProjectionFixture();
  const harness = baselineHarnessCommandFixture().revision;
  const verifierReceipt = receipt();
  const verification: RetainedSubmittedVerification = {
    kind: 'Rejected',
    feedback: 'Public completion condition rejected; output artifacts retain the details.',
    receipts: [verifierReceipt],
    outputArtifactSaids: [said('o')],
  };
  const custody: SubmittedVerificationCustody = {
    transferSubmittedVerification: () => ({ kind: 'Transferred', verification }),
  };
  const category = {
    version: 1 as const,
    taskId: task.taskId,
    taskRevisionSaid: task.revisionSaid,
    harnessRevisionSaid: harness.d,
    currentCommandSaid: said('c'),
    tamperCommandSaid: said('t'),
    legacyCommandSaid: verifierReceipt.commandSaid,
    legacyObservedExitCode: 101 as const,
  };
  const compatibility: PreparedCompatibilityFailures = {
    classify: () => ({ kind: 'Confirmed', category, verifierReceiptSaids: [verifierReceipt.d] }),
  };
  const records = new MemoryCalibrationRecords(timeline);
  const calibration = new PreparedCompatibilityCalibration(records);
  const checkpointSaid = said('k');
  const checkpointing: RunCheckpointing = {
    materialize: vi.fn<RunCheckpointing['materialize']>((input) => {
      timeline.push('checkpoint');
      expect(input.disposition).toEqual({
        runState: {
          kind: 'Ended',
          outcome: { kind: 'CalibrationConfirmed', category },
          verification: { kind: 'Rejected' },
        },
        continuation: { kind: 'NoContinuation' },
      });
      return Promise.resolve({ kind: 'Materialized', checkpoint: { d: checkpointSaid } });
    }),
  };
  const sealing: RunEvidenceSealing = {
    settle: vi.fn<RunEvidenceSealing['settle']>(() => {
      timeline.push('sealed');
      return Promise.resolve({ kind: 'Sealed' });
    }),
  };
  return {
    task,
    harness,
    evidence: recorder(run, timeline, () => proofReading),
    custody,
    verification: { unresolvedReceipts: () => undefined },
    compatibility,
    calibration,
    checkpointing,
    sealing,
    now: () => '2026-09-24T20:00:05.000Z',
  };
}

describe('prepared compatibility calibration Run settlement', () => {
  it.each(['Sealed', 'SealObservationUnavailable'] as const)(
    'ends revoked calibration authority only after acknowledged sealing: %s',
    async (sealKind) => {
      const run = runningCalibrationRun();
      const timeline: string[] = [];
      const base = confirmedDependencies(run, timeline, { kind: 'NotFound' });
      const receipts = [unresolvedReceipt('RunBlocked')];
      const classify = vi.fn<PreparedCompatibilityFailures['classify']>();
      const assess = vi.fn<PreparedCompatibilityCalibrationSettlements['assess']>();
      const record = vi.fn<PreparedCompatibilityCalibrationSettlements['record']>();
      const materialize = vi.fn<RunCheckpointing['materialize']>(() => {
        timeline.push('checkpoint');
        return Promise.resolve({ kind: 'Materialized', checkpoint: { d: said('k') } });
      });
      const settlement = new PreparedCompatibilityCalibrationSettlement({
        ...base,
        custody: { transferSubmittedVerification: () => ({ kind: 'NoSubmission' }) },
        verification: { unresolvedReceipts: () => receipts },
        compatibility: { classify },
        calibration: { assess, record },
        checkpointing: { materialize },
        sealing: {
          settle: () => {
            timeline.push('seal');
            return Promise.resolve({ kind: sealKind });
          },
        },
      });
      await expect(
        settlement.settle({
          run,
          cause: { kind: 'ExecutorSettled', disposition: { kind: 'AuthorityRevoked' } },
          latestHostedRunVersion: run.version,
        }),
      ).resolves.toEqual(
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
      expect(classify).not.toHaveBeenCalled();
      expect(assess).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
      expect(timeline).toEqual(['checkpoint', 'seal', 'closed']);
    },
  );

  it.each(['CheckpointWithheld', 'SealUnavailable'] as const)(
    'does not claim a settled secret block when %s',
    async (failure) => {
      const run = runningCalibrationRun();
      const timeline: string[] = [];
      const base = confirmedDependencies(run, timeline, { kind: 'NotFound' });
      const assess = vi.fn<PreparedCompatibilityCalibrationSettlements['assess']>();
      const record = vi.fn<PreparedCompatibilityCalibrationSettlements['record']>();
      const settlement = new PreparedCompatibilityCalibrationSettlement({
        ...base,
        calibration: { assess, record },
        checkpointing: {
          materialize: () => {
            timeline.push('checkpoint');
            return Promise.resolve(
              failure === 'CheckpointWithheld'
                ? { kind: 'SecretDetected' }
                : { kind: 'Materialized', checkpoint: { d: said('k') } },
            );
          },
        },
        sealing: {
          settle: () => {
            timeline.push('seal');
            return Promise.resolve({ kind: 'SealObservationUnavailable' });
          },
        },
      });
      await expect(
        settlement.settle({
          run,
          cause: { kind: 'ExecutorSettled', disposition: { kind: 'SecretDetected' } },
          latestHostedRunVersion: run.version,
        }),
      ).resolves.toEqual(
        failure === 'CheckpointWithheld'
          ? { kind: 'Unavailable' }
          : {
              kind: 'EvidenceSealingFailed',
              failure: {
                kind: 'EvidenceSealingRejected',
                reason: 'SealObservationUnavailable',
              },
            },
      );
      expect(timeline).toEqual(
        failure === 'CheckpointWithheld'
          ? ['checkpoint', 'closed']
          : ['checkpoint', 'RunBlocked', 'seal', 'closed'],
      );
      expect(run.lifecycle).toEqual({ kind: 'Active', phase: { kind: 'Running' } });
      expect(assess).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    },
  );

  it('retains submitted verification evidence when classification detects a secret', async () => {
    const run = runningCalibrationRun();
    const timeline: string[] = [];
    const base = confirmedDependencies(run, timeline, { kind: 'NotFound' });
    const verification: RetainedSubmittedVerification = {
      kind: 'Blocked',
      reason: 'SecretDetected',
      receipts: [unresolvedReceipt('RunBlocked')],
      outputArtifactSaids: [said('o')],
    };
    const assess = vi.fn<PreparedCompatibilityCalibrationSettlements['assess']>();
    const record = vi.fn<PreparedCompatibilityCalibrationSettlements['record']>();
    const materialize = vi.fn<RunCheckpointing['materialize']>(() => {
      timeline.push('checkpoint');
      return Promise.resolve({ kind: 'Materialized', checkpoint: { d: said('k') } });
    });
    const settlement = new PreparedCompatibilityCalibrationSettlement({
      ...base,
      custody: { transferSubmittedVerification: () => ({ kind: 'Transferred', verification }) },
      compatibility: { classify: () => ({ kind: 'SecretDetected' }) },
      calibration: { assess, record },
      checkpointing: { materialize },
    });
    const outcome = await settlement.settle({
      run,
      cause: {
        kind: 'ExecutorSettled',
        disposition: { kind: 'Completed', sessionId: 'session-1' },
      },
      latestHostedRunVersion: run.version,
    });
    expect(outcome).toEqual({
      kind: 'Settled',
      run: {
        ...run,
        version: run.version + 1,
        lifecycle: {
          kind: 'Active',
          phase: { kind: 'Blocked', reason: 'SecretDetected', checkpointSaid: said('k') },
        },
      },
    });
    expect(materialize.mock.calls[0]?.[0].verifierReceipts).toEqual(verification.receipts);
    expect(materialize.mock.calls[0]?.[0].outputArtifactSaids).toEqual(
      verification.outputArtifactSaids,
    );
    expect(assess).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(timeline).toEqual(['checkpoint', 'RunBlocked', 'sealed', 'closed']);
  });

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
        'SecretDetected',
        'ApprovalRequired',
        'ContextLimitReached',
        'TaskMandateExpired',
        'LeaseLost',
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
    'seals $reason as a blocked calibration Run without advancing the campaign',
    async ({ cause, reason }) => {
      const run = runningCalibrationRun();
      const timeline: string[] = [];
      const receipts = [unresolvedReceipt('RunBlocked')];
      const base = confirmedDependencies(run, timeline, { kind: 'NotFound' });
      const assess = vi.fn<PreparedCompatibilityCalibrationSettlements['assess']>();
      const record = vi.fn<PreparedCompatibilityCalibrationSettlements['record']>();
      const classify = vi.fn<PreparedCompatibilityFailures['classify']>();
      const materialize = vi.fn<RunCheckpointing['materialize']>(() => {
        timeline.push('checkpoint');
        return Promise.resolve({ kind: 'Materialized', checkpoint: { d: said('k') } });
      });
      const settlement = new PreparedCompatibilityCalibrationSettlement({
        ...base,
        custody: { transferSubmittedVerification: () => ({ kind: 'NoSubmission' }) },
        verification: { unresolvedReceipts: () => receipts },
        calibration: { assess, record },
        compatibility: { classify },
        checkpointing: { materialize },
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
        verifierReceipts: receipts,
        outputArtifactSaids: [],
        disposition: {
          runState: {
            kind: 'Active',
            phase: { kind: 'Blocked', reason },
            verification: run.submissionVerification,
          },
          continuation:
            reason === 'UserInterrupted'
              ? { kind: 'LaterRuntimeRecoveryRequired' }
              : { kind: 'ExternalResolutionRequired', reason },
        },
      });
      expect(assess).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
      expect(classify).not.toHaveBeenCalled();
      expect(timeline).toEqual(['checkpoint', 'RunBlocked', 'sealed', 'closed']);
    },
  );

  it('seals the terminal confirmed checkpoint before committing the local campaign record', async () => {
    const run = runningCalibrationRun();
    const timeline: string[] = [];
    const dependencies = confirmedDependencies(run, timeline, {
      kind: 'Proved',
      proof: providerProof(run),
    });
    const settlement = new PreparedCompatibilityCalibrationSettlement(dependencies);

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
          kind: 'Ended',
          outcome: { kind: 'CalibrationConfirmed', checkpointSaid: said('k') },
        },
        submissionVerification: { kind: 'Rejected' },
      },
    });
    expect(timeline).toEqual([
      'FailureObserved',
      'checkpoint',
      'RunCalibrationRecorded',
      'sealed',
      'local-calibration-recorded',
      'closed',
    ]);
  });

  it('seals a passing H1 as a calibration rejection with accepted verification', async () => {
    const run = runningCalibrationRun();
    const timeline: string[] = [];
    const dependencies = confirmedDependencies(run, timeline, {
      kind: 'Proved',
      proof: providerProof(run),
    });
    const verification: RetainedSubmittedVerification = {
      kind: 'Accepted',
      receipts: acceptedReceipts(),
      outputArtifactSaids: [said('o')],
    };
    dependencies.custody.transferSubmittedVerification = () => ({
      kind: 'Transferred',
      verification,
    });
    dependencies.compatibility.classify = () => ({ kind: 'NotConfirmed', reason: 'H1Passed' });
    dependencies.checkpointing.materialize = vi.fn<RunCheckpointing['materialize']>((input) => {
      timeline.push('checkpoint');
      expect(input.verifierReceipts).toEqual(verification.receipts);
      expect(input.disposition).toEqual({
        runState: {
          kind: 'Ended',
          outcome: { kind: 'CalibrationRejected', reason: 'H1Passed' },
          verification: { kind: 'Accepted' },
        },
        continuation: { kind: 'NoContinuation' },
      });
      return Promise.resolve({ kind: 'Materialized', checkpoint: { d: said('k') } });
    });
    const settlement = new PreparedCompatibilityCalibrationSettlement(dependencies);

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
          kind: 'Ended',
          outcome: { kind: 'CalibrationRejected', reason: 'H1Passed', checkpointSaid: said('k') },
        },
        submissionVerification: { kind: 'Accepted' },
      },
    });
    expect(timeline).toEqual([
      'checkpoint',
      'RunCalibrationRecorded',
      'sealed',
      'local-calibration-recorded',
      'closed',
    ]);
  });

  it('refuses to count a clean classification without attributable provider proof', async () => {
    const run = runningCalibrationRun();
    const timeline: string[] = [];
    const dependencies = confirmedDependencies(run, timeline, { kind: 'NotFound' });
    const settlement = new PreparedCompatibilityCalibrationSettlement(dependencies);

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
    expect(timeline).toEqual(['closed']);
  });

  it.each(['ProviderUnavailable', 'ModelUsageUnavailable', 'BudgetExhausted'] as const)(
    'records a truthful %s exclusion with unattempted-condition receipts',
    async (reason) => {
      const run = runningCalibrationRun();
      const timeline: string[] = [];
      const task = taskProjectionFixture();
      const harness = baselineHarnessCommandFixture().revision;
      const records = new MemoryCalibrationRecords(timeline);
      const unresolved = unresolvedReceipt();
      const checkpointing: RunCheckpointing = {
        materialize: vi.fn<RunCheckpointing['materialize']>((input) => {
          timeline.push('checkpoint');
          expect(input.verifierReceipts).toEqual([unresolved]);
          expect(input.outputArtifactSaids).toEqual([]);
          expect(input.disposition).toEqual({
            runState: {
              kind: 'Ended',
              outcome: { kind: 'CalibrationExcluded', reason },
              verification: { kind: 'NotSubmitted' },
            },
            continuation: { kind: 'NoContinuation' },
          });
          return Promise.resolve({ kind: 'Materialized', checkpoint: { d: said('k') } });
        }),
      };
      const proof = vi.fn<PreparedCompatibilityProviderProofs['read']>();
      const settlement = new PreparedCompatibilityCalibrationSettlement({
        task,
        harness,
        evidence: recorder(run, timeline, proof),
        custody: { transferSubmittedVerification: () => ({ kind: 'NoSubmission' }) },
        verification: { unresolvedReceipts: () => [unresolved] },
        compatibility: { classify: () => ({ kind: 'NotConfirmed', reason: 'H1Passed' }) },
        calibration: new PreparedCompatibilityCalibration(records),
        checkpointing,
        sealing: {
          settle: () => {
            timeline.push('sealed');
            return Promise.resolve({ kind: 'Sealed' });
          },
        },
        now: () => '2026-09-24T20:00:05.000Z',
      });

      const outcome = await settlement.settle({
        run,
        cause: { kind: 'ExecutorSettled', disposition: { kind: reason } },
        latestHostedRunVersion: run.version,
      });

      expect(outcome).toMatchObject({
        kind: 'Settled',
        run: {
          lifecycle: {
            kind: 'Ended',
            outcome: { kind: 'CalibrationExcluded', reason },
          },
        },
      });
      expect(proof).not.toHaveBeenCalled();
      expect(timeline).toEqual([
        'checkpoint',
        'RunCalibrationRecorded',
        'sealed',
        'local-calibration-recorded',
        'closed',
      ]);
    },
  );

  it('retains the typed hosted batch rejection when an excluded Run cannot seal', async () => {
    const run = runningCalibrationRun();
    const timeline: string[] = [];
    const unresolved = unresolvedReceipt();
    const base = confirmedDependencies(run, timeline, { kind: 'NotFound' });
    const settlement = new PreparedCompatibilityCalibrationSettlement({
      ...base,
      verification: { unresolvedReceipts: () => [unresolved] },
      checkpointing: {
        materialize: () => Promise.resolve({ kind: 'Materialized', checkpoint: { d: said('k') } }),
      },
      sealing: {
        settle: () =>
          Promise.resolve({
            kind: 'EvidenceDeliveryRejected',
            outcome: {
              kind: 'BatchDeliveryRejected',
              outcome: {
                kind: 'RequestRejected',
                problem: {
                  type: 'https://devrandom.example/problems/evidence-conflict',
                  title: 'Evidence delivery conflicts with the accepted stream',
                  status: 409,
                  code: 'EvidenceConflict',
                  correlationId: 'ac68bb43-8a7b-4838-bcd6-98143fd372af',
                  reason: 'SequenceGap',
                  expectedStartingSequence: 2,
                  receivedStartingSequence: 0,
                },
              },
            },
          }),
      },
    });

    await expect(
      settlement.settle({
        run,
        cause: { kind: 'ExecutorSettled', disposition: { kind: 'ModelUsageUnavailable' } },
        latestHostedRunVersion: run.version,
      }),
    ).resolves.toEqual({
      kind: 'EvidenceSealingFailed',
      failure: {
        kind: 'EvidenceDeliveryRejected',
        delivery: {
          kind: 'BatchDeliveryRejected',
          failure: {
            kind: 'RequestRejected',
            code: 'EvidenceConflict',
            reason: 'SequenceGap',
            expectedStartingSequence: 2,
            receivedStartingSequence: 0,
          },
        },
      },
    });
    expect(timeline).toContain('RunCalibrationRecorded');
    expect(timeline).not.toContain('local-calibration-recorded');
  });

  it('retains the typed hosted batch rejection when an interrupted Run cannot seal', async () => {
    const run = runningCalibrationRun();
    const timeline: string[] = [];
    const base = confirmedDependencies(run, timeline, { kind: 'NotFound' });
    const settlement = new PreparedCompatibilityCalibrationSettlement({
      ...base,
      verification: { unresolvedReceipts: () => [unresolvedReceipt('RunBlocked')] },
      checkpointing: {
        materialize: () => Promise.resolve({ kind: 'Materialized', checkpoint: { d: said('k') } }),
      },
      sealing: {
        settle: () =>
          Promise.resolve({
            kind: 'EvidenceDeliveryRejected',
            outcome: {
              kind: 'BatchDeliveryRejected',
              outcome: {
                kind: 'RequestRejected',
                problem: {
                  type: 'https://devrandom.example/problems/evidence-conflict',
                  title: 'Evidence delivery conflicts with the accepted stream',
                  status: 409,
                  code: 'EvidenceConflict',
                  correlationId: 'ac68bb43-8a7b-4838-bcd6-98143fd372af',
                  reason: 'CursorConcurrentUpdate',
                },
              },
            },
          }),
      },
    });

    await expect(
      settlement.settle({
        run,
        cause: { kind: 'UserInterrupted' },
        latestHostedRunVersion: run.version,
      }),
    ).resolves.toEqual({
      kind: 'EvidenceSealingFailed',
      failure: {
        kind: 'EvidenceDeliveryRejected',
        delivery: {
          kind: 'BatchDeliveryRejected',
          failure: {
            kind: 'RequestRejected',
            code: 'EvidenceConflict',
            reason: 'CursorConcurrentUpdate',
          },
        },
      },
    });
    expect(timeline).toContain('RunBlocked');
    expect(timeline).not.toContain('local-calibration-recorded');
  });

  it('does not seal or count a budget-exhausted Run whose complete worktree cannot be checkpointed', async () => {
    const run = runningCalibrationRun();
    const timeline: string[] = [];
    const base = confirmedDependencies(run, timeline, { kind: 'NotFound' });
    const dependencies = {
      ...base,
      verification: { unresolvedReceipts: () => [unresolvedReceipt()] },
      checkpointing: {
        materialize: () => {
          timeline.push('checkpoint-rejected');
          return Promise.resolve({
            kind: 'RepositoryRejected' as const,
            reason: 'ChangedFileLimitExceeded' as const,
          });
        },
      },
    };
    const seal = vi.spyOn(dependencies.sealing, 'settle');

    await expect(
      new PreparedCompatibilityCalibrationSettlement(dependencies).settle({
        run,
        cause: { kind: 'ExecutorSettled', disposition: { kind: 'BudgetExhausted' } },
        latestHostedRunVersion: run.version,
      }),
    ).resolves.toEqual({ kind: 'Unavailable' });
    expect(seal).not.toHaveBeenCalled();
    expect(timeline).toEqual(['checkpoint-rejected', 'closed']);
  });

  it('does not commit the local campaign record when the seal is rejected', async () => {
    const run = runningCalibrationRun();
    const timeline: string[] = [];
    const dependencies = confirmedDependencies(run, timeline, {
      kind: 'Proved',
      proof: providerProof(run),
    });
    dependencies.sealing.settle = () => {
      timeline.push('seal-rejected');
      return Promise.resolve({
        kind: 'SealReconciliationRejected',
        outcome: { kind: 'ResponseInvalid' },
      });
    };
    const settlement = new PreparedCompatibilityCalibrationSettlement(dependencies);

    await expect(
      settlement.settle({
        run,
        cause: {
          kind: 'ExecutorSettled',
          disposition: { kind: 'Completed', sessionId: 'session-1' },
        },
        latestHostedRunVersion: run.version,
      }),
    ).resolves.toEqual({
      kind: 'EvidenceSealingFailed',
      failure: { kind: 'EvidenceSealingRejected', reason: 'SealReconciliationRejected' },
    });
    expect(timeline).toEqual([
      'FailureObserved',
      'checkpoint',
      'RunCalibrationRecorded',
      'seal-rejected',
      'closed',
    ]);
  });
});
