import { describe, expect, it } from 'vitest';

import { taskBudgetCeilings } from '../task/authority.js';
import { startRunExecution } from './execution.js';
import { acquireFirstRunLease } from './lease.js';
import { createRun, type Run, type RunPurpose } from './run.js';
import {
  acceptRunSubmission,
  cancelRun,
  applySealedRunCheckpoint,
  beginRunSubmission,
  blockRun,
  failRun,
  planRunCalibration,
  rejectRunSubmission,
  recordRunCalibration,
  revokeRunAuthority,
} from './settlement.js';

function said(character: string): string {
  return `E${character.repeat(43)}`;
}

function preparingRun(purpose: RunPurpose = { kind: 'Retained' }): Run {
  const runId = '1cc482f1-98e9-4454-8e4c-5566cb47ce3d';
  const acceptedAt = '2026-09-24T20:00:00.000Z';
  const created = createRun({
    runId,
    ownerAid: said('a'),
    taskId: '4df838a8-5109-49fd-bdad-805880a3ecee',
    taskRevisionSaid: said('b'),
    harnessLineageId: 'd9cb18e4-f4f8-4378-a852-353eef083d91',
    personalAgentAid: said('c'),
    taskMandateSaid: said('d'),
    governorAid: said('e'),
    promotionMandateSaid: said('f'),
    initialHarnessRevisionSaid: said('g'),
    purpose,
    initialSpecialization: {
      kind: 'InitialSpecializationAccepted',
      harnessLineageId: 'd9cb18e4-f4f8-4378-a852-353eef083d91',
      harnessRevisionSaid: said('g'),
      runId:
        purpose.kind === 'PreparedCompatibilityCalibration' && purpose.ordinal === 1
          ? runId
          : 'b055027e-d1dc-47ce-9fca-cb91414ca556',
      acceptedAt:
        purpose.kind === 'PreparedCompatibilityCalibration' && purpose.ordinal === 1
          ? acceptedAt
          : '2026-09-24T19:00:00.000Z',
    },
    repository: { objectFormat: 'sha1', commit: '1'.repeat(40), tree: '2'.repeat(40) },
    commandId: 'd2c9160a-58f8-4d43-ae67-22124c6e9112',
    admissionExchangeSaid: said('h'),
    evidenceStreamId: 'a1975db1-6130-41c2-b9dd-c8ec8bc12c94',
    budget: taskBudgetCeilings,
    acceptedAt,
  });
  if (created.kind !== 'Created') {
    throw new Error('fixture Run must be created');
  }
  return created.run;
}

function runningRun(purpose: RunPurpose = { kind: 'Retained' }): Run {
  const leased = acquireFirstRunLease(preparingRun(purpose), {
    incarnationId: 'ee87e11d-fb5f-46b4-841f-8a7a5faad97c',
    expectedRunVersion: 0,
    serverTime: '2026-09-24T20:00:01.000Z',
  });
  if (leased.kind !== 'Acquired') {
    throw new Error('fixture lease must be acquired');
  }
  const started = startRunExecution(leased.run, {
    incarnationId: leased.run.lease.kind === 'Held' ? leased.run.lease.incarnationId : '',
    leaseObservedAt: '2026-09-24T20:00:02.000Z',
    worktree: { repository: leased.run.binding.repository },
    evidence: { kind: 'Genesis', streamId: leased.run.binding.evidenceStreamId },
  });
  if (started.kind !== 'Started') {
    throw new Error('fixture Run must start');
  }
  return started.run;
}

describe('Run settlement law', () => {
  it('cancels an interrupted calibration without qualifying it or changing accounting', () => {
    const run = runningRun({
      kind: 'PreparedCompatibilityCalibration',
      campaignId: '57ed9f1a-b444-44b2-95c9-fd780c90a7dd',
      ordinal: 1,
    });
    const cancelled = cancelRun(run, { checkpointSaid: said('x') });
    expect(cancelled.kind).toBe('Cancelled');
    if (cancelled.kind !== 'Cancelled') throw new Error(cancelled.kind);
    expect(cancelled.run.lifecycle).toEqual({
      kind: 'Ended',
      outcome: { kind: 'Cancelled', checkpointSaid: said('x') },
    });
    expect(cancelled.run.consumedBudget).toEqual(run.consumedBudget);
    expect(cancelled.run.lease).toEqual(run.lease);
    expect(cancelled.run.submissionVerification).toEqual({ kind: 'NotSubmitted' });
    expect(
      cancelRun(
        { ...run, submissionVerification: { kind: 'Pending' } },
        { checkpointSaid: said('x') },
      ),
    ).toEqual({ kind: 'SubmissionAlreadyStarted' });
    expect(
      cancelRun(
        { ...run, submissionVerification: { kind: 'Accepted' } },
        { checkpointSaid: said('x') },
      ),
    ).toEqual({ kind: 'SubmissionAlreadyAccepted' });
  });

  function heldPreparingRun(): Run {
    const leased = acquireFirstRunLease(preparingRun(), {
      incarnationId: 'ee87e11d-fb5f-46b4-841f-8a7a5faad97c',
      expectedRunVersion: 0,
      serverTime: '2026-09-24T20:00:01.000Z',
    });
    if (leased.kind !== 'Acquired') {
      throw new Error('fixture Run lease must be acquired');
    }
    return leased.run;
  }

  function sealedCheckpointInput(run: Run) {
    if (run.lease.kind !== 'Held') {
      throw new Error('fixture Run must hold an incarnation');
    }
    const checkpointSaid = said('i');
    return {
      expectedRunVersion: run.version,
      consumedBudget: { ...run.consumedBudget, providerRequests: 1, providerInputTokens: 127 },
      checkpoint: {
        checkpointSaid,
        taskId: run.binding.taskId,
        taskRevisionSaid: run.binding.taskRevisionSaid,
        runId: run.binding.runId,
        incarnationId: run.lease.incarnationId,
        harnessRevisionSaid: run.binding.initialHarnessRevisionSaid,
        lifecycle: {
          kind: 'Active' as const,
          phase: {
            kind: 'Blocked' as const,
            reason: 'HarnessCompatibilityFailure' as const,
            checkpointSaid,
          },
        },
        submissionVerification: { kind: 'NotSubmitted' as const },
      },
      runStarted: {
        eventSaid: said('j'),
        fromRunVersion: run.version,
        taskId: run.binding.taskId,
        taskRevisionSaid: run.binding.taskRevisionSaid,
        runId: run.binding.runId,
        incarnationId: run.lease.incarnationId,
        harnessRevisionSaid: run.binding.initialHarnessRevisionSaid,
        personalAgentAid: run.binding.personalAgentAid,
        taskMandateSaid: run.binding.taskMandateSaid,
      },
    };
  }

  it('applies a coherent sealed compatibility checkpoint to only the held authoritative incarnation', () => {
    const current = heldPreparingRun();
    const input = sealedCheckpointInput(current);
    const settlement = applySealedRunCheckpoint(current, input);

    expect(settlement).toEqual({
      kind: 'Applied',
      run: {
        ...current,
        version: current.version + 1,
        lifecycle: input.checkpoint.lifecycle,
        submissionVerification: input.checkpoint.submissionVerification,
        consumedBudget: input.consumedBudget,
      },
    });
    if (settlement.kind === 'Applied') {
      expect(settlement.run.binding.budget).toEqual(current.binding.budget);
      expect(settlement.run.consumedBudget).toEqual(input.consumedBudget);
      expect(settlement.run.lease).toEqual(current.lease);
    }
  });

  it('rejects invalid, regressing, or over-ceiling consumed budget at the seal boundary', () => {
    const held = heldPreparingRun();
    const current = {
      ...held,
      consumedBudget: { ...held.consumedBudget, providerRequests: 1 },
    };
    const input = sealedCheckpointInput(current);

    expect(
      applySealedRunCheckpoint(current, {
        ...input,
        consumedBudget: { ...input.consumedBudget, providerRequests: 0 },
      }),
    ).toEqual({ kind: 'RunBudgetRegression', budget: 'providerRequests' });
    expect(
      applySealedRunCheckpoint(current, {
        ...input,
        consumedBudget: { ...input.consumedBudget, providerRequests: 0.5 },
      }),
    ).toEqual({ kind: 'RunBudgetInvalid', budget: 'providerRequests' });
    expect(
      applySealedRunCheckpoint(current, {
        ...input,
        consumedBudget: {
          ...input.consumedBudget,
          providerRequests: Number.MAX_SAFE_INTEGER + 1,
        },
      }),
    ).toEqual({ kind: 'RunBudgetInvalid', budget: 'providerRequests' });
    expect(
      applySealedRunCheckpoint(current, {
        ...input,
        consumedBudget: {
          ...input.consumedBudget,
          providerRequests: current.binding.budget.providerRequests + 1,
        },
      }),
    ).toEqual({ kind: 'RunBudgetCeilingExceeded', budget: 'providerRequests' });
    expect(
      applySealedRunCheckpoint(current, {
        ...input,
        consumedBudget: {
          ...input.consumedBudget,
          providerOutputTokens: current.binding.budget.providerOutputTokens + 1,
        },
        checkpoint: {
          ...input.checkpoint,
          lifecycle: {
            kind: 'Ended',
            outcome: { kind: 'Submitted', checkpointSaid: input.checkpoint.checkpointSaid },
          },
          submissionVerification: { kind: 'Accepted' },
        },
      }),
    ).toEqual({ kind: 'RunBudgetCeilingExceeded', budget: 'providerOutputTokens' });
  });

  it.each(['BudgetExhausted', 'SecretDetected'] as const)(
    'retains over-ceiling consumption for a %s block without changing authority',
    (reason) => {
      const run = heldPreparingRun();
      const base = sealedCheckpointInput(run);
      const consumedBudget = {
        ...base.consumedBudget,
        providerOutputTokens: run.binding.budget.providerOutputTokens + 1,
      };
      const input = {
        ...base,
        consumedBudget,
        checkpoint: {
          ...base.checkpoint,
          lifecycle: {
            kind: 'Active' as const,
            phase: {
              kind: 'Blocked' as const,
              reason,
              checkpointSaid: base.checkpoint.checkpointSaid,
            },
          },
        },
      };
      expect(applySealedRunCheckpoint(run, input)).toEqual({
        kind: 'Applied',
        run: {
          ...run,
          version: run.version + 1,
          lifecycle: input.checkpoint.lifecycle,
          submissionVerification: input.checkpoint.submissionVerification,
          consumedBudget,
        },
      });
    },
  );

  it('rejects wrong incarnation, server version, or accepted RunStarted provenance', () => {
    const current = heldPreparingRun();
    const input = sealedCheckpointInput(current);

    expect(
      applySealedRunCheckpoint(current, {
        ...input,
        checkpoint: {
          ...input.checkpoint,
          incarnationId: '3cb2c957-ccf9-48e7-9e00-2717b704122c',
        },
      }),
    ).toEqual({ kind: 'IncarnationConflict' });
    expect(
      applySealedRunCheckpoint(current, { ...input, expectedRunVersion: current.version + 1 }),
    ).toEqual({ kind: 'VersionConflict', currentVersion: current.version });
    expect(
      applySealedRunCheckpoint(current, {
        ...input,
        runStarted: { ...input.runStarted, runId: '8ad73b81-9eaa-4a76-b838-bc8e30690475' },
      }),
    ).toEqual({ kind: 'RunStartedProvenanceConflict' });
  });

  it('rejects uncheckpointed or incoherent dispositions and a false checkpoint binding', () => {
    const current = heldPreparingRun();
    const input = sealedCheckpointInput(current);

    expect(
      applySealedRunCheckpoint(current, {
        ...input,
        checkpoint: {
          ...input.checkpoint,
          lifecycle: { kind: 'Active', phase: { kind: 'Running' } },
        },
      }),
    ).toEqual({ kind: 'CheckpointDispositionInvalid' });
    expect(
      applySealedRunCheckpoint(current, {
        ...input,
        checkpoint: {
          ...input.checkpoint,
          lifecycle: {
            kind: 'Ended',
            outcome: { kind: 'Submitted', checkpointSaid: input.checkpoint.checkpointSaid },
          },
          submissionVerification: { kind: 'Rejected' },
        },
      }),
    ).toEqual({ kind: 'CheckpointDispositionInvalid' });
    expect(
      applySealedRunCheckpoint(current, {
        ...input,
        checkpoint: { ...input.checkpoint, taskRevisionSaid: said('x') },
      }),
    ).toEqual({ kind: 'CheckpointBindingConflict' });
  });

  it('accepts calibration terminal checkpoints only for calibration Runs', () => {
    const purpose = {
      kind: 'PreparedCompatibilityCalibration' as const,
      campaignId: 'e1df87a8-bbc1-40ee-9f19-719418eb16bd',
      ordinal: 1 as const,
    };
    const created = preparingRun(purpose);
    const lease = acquireFirstRunLease(created, {
      incarnationId: 'ee87e11d-fb5f-46b4-841f-8a7a5faad97c',
      expectedRunVersion: 0,
      serverTime: '2026-09-24T20:00:01.000Z',
    });
    if (lease.kind !== 'Acquired') {
      throw new Error('fixture calibration lease must be acquired');
    }
    const input = sealedCheckpointInput(lease.run);
    const calibrationCheckpoint = {
      ...input,
      checkpoint: {
        ...input.checkpoint,
        lifecycle: {
          kind: 'Ended' as const,
          outcome: {
            kind: 'CalibrationExcluded' as const,
            checkpointSaid: input.checkpoint.checkpointSaid,
            reason: 'ProviderUnavailable' as const,
          },
        },
      },
    };

    expect(applySealedRunCheckpoint(lease.run, calibrationCheckpoint)).toMatchObject({
      kind: 'Applied',
      run: { lifecycle: { kind: 'Ended', outcome: { kind: 'CalibrationExcluded' } } },
    });
    expect(
      applySealedRunCheckpoint(
        { ...lease.run, binding: { ...lease.run.binding, purpose: { kind: 'Retained' } } },
        calibrationCheckpoint,
      ),
    ).toEqual({ kind: 'CheckpointDispositionInvalid' });
  });

  it('reconciles the exact sealed checkpoint but rejects a second disposition', () => {
    const current = heldPreparingRun();
    const input = sealedCheckpointInput(current);
    const applied = applySealedRunCheckpoint(current, input);
    if (applied.kind !== 'Applied') {
      throw new Error('fixture checkpoint must apply');
    }

    expect(applySealedRunCheckpoint(applied.run, input)).toEqual({
      kind: 'Equivalent',
      run: applied.run,
    });
    expect(
      applySealedRunCheckpoint(applied.run, {
        ...input,
        checkpoint: {
          ...input.checkpoint,
          lifecycle: {
            kind: 'Active',
            phase: {
              kind: 'Blocked',
              reason: 'DependencyUnavailable',
              checkpointSaid: input.checkpoint.checkpointSaid,
            },
          },
        },
      }),
    ).toEqual({ kind: 'RunSettlementConflict' });
  });

  it('retains the required compatibility failure as a checkpointed nonterminal block', () => {
    const running = runningRun();

    expect(
      blockRun(running, {
        reason: 'HarnessCompatibilityFailure',
        checkpointSaid: said('i'),
      }),
    ).toEqual({
      kind: 'Blocked',
      run: {
        ...running,
        version: running.version + 1,
        lifecycle: {
          kind: 'Active',
          phase: {
            kind: 'Blocked',
            reason: 'HarnessCompatibilityFailure',
            checkpointSaid: said('i'),
          },
        },
      },
    });

    expect(
      blockRun(preparingRun(), {
        reason: 'HarnessCompatibilityFailure',
        checkpointSaid: said('i'),
      }),
    ).toEqual({ kind: 'CompatibilityFailureRequiresRunning' });
  });

  it('keeps rejected verification active and accepts only a pending submission', () => {
    const running = runningRun();
    const begun = beginRunSubmission(running);
    if (begun.kind !== 'Pending') {
      throw new Error('fixture submission must become pending');
    }
    const rejected = rejectRunSubmission(begun.run);
    expect(rejected).toMatchObject({
      kind: 'Rejected',
      run: {
        lifecycle: { kind: 'Active', phase: { kind: 'Running' } },
        submissionVerification: { kind: 'Rejected' },
      },
    });
    expect(acceptRunSubmission(running, { checkpointSaid: said('i') })).toEqual({
      kind: 'SubmissionNotPending',
    });
    expect(acceptRunSubmission(begun.run, { checkpointSaid: said('i') })).toMatchObject({
      kind: 'Accepted',
      run: {
        lifecycle: { kind: 'Ended', outcome: { kind: 'Submitted' } },
        submissionVerification: { kind: 'Accepted' },
      },
    });
  });

  it('records calibration terminal outcomes only from a running calibration Run', () => {
    const purpose = {
      kind: 'PreparedCompatibilityCalibration' as const,
      campaignId: 'e1df87a8-bbc1-40ee-9f19-719418eb16bd',
      ordinal: 1 as const,
    };
    const current = runningRun(purpose);
    const category = {
      version: 1 as const,
      taskId: current.binding.taskId,
      taskRevisionSaid: current.binding.taskRevisionSaid,
      harnessRevisionSaid: current.binding.initialHarnessRevisionSaid,
      currentCommandSaid: said('k'),
      tamperCommandSaid: said('l'),
      legacyCommandSaid: said('m'),
      legacyObservedExitCode: 101 as const,
    };

    expect(planRunCalibration(current, { kind: 'Confirmed', category })).toEqual({
      kind: 'Planned',
      state: {
        outcome: { kind: 'CalibrationConfirmed', category },
        submissionVerification: { kind: 'Rejected' },
      },
    });
    expect(
      planRunCalibration(current, { kind: 'Excluded', reason: 'ProviderUnavailable' }),
    ).toEqual({
      kind: 'Planned',
      state: {
        outcome: { kind: 'CalibrationExcluded', reason: 'ProviderUnavailable' },
        submissionVerification: { kind: 'NotSubmitted' },
      },
    });
    expect(planRunCalibration(current, { kind: 'Rejected', reason: 'H1Passed' })).toEqual({
      kind: 'Planned',
      state: {
        outcome: { kind: 'CalibrationRejected', reason: 'H1Passed' },
        submissionVerification: { kind: 'Accepted' },
      },
    });

    expect(
      recordRunCalibration(current, {
        checkpointSaid: said('i'),
        disposition: { kind: 'Confirmed', category },
      }),
    ).toMatchObject({
      kind: 'Recorded',
      run: {
        lifecycle: {
          kind: 'Ended',
          outcome: { kind: 'CalibrationConfirmed', checkpointSaid: said('i'), category },
        },
        submissionVerification: { kind: 'Rejected' },
      },
    });
    expect(
      recordRunCalibration(current, {
        checkpointSaid: said('i'),
        disposition: { kind: 'Rejected', reason: 'H1Passed' },
      }),
    ).toMatchObject({
      kind: 'Recorded',
      run: {
        lifecycle: { kind: 'Ended', outcome: { kind: 'CalibrationRejected' } },
        submissionVerification: { kind: 'Accepted' },
      },
    });
    expect(
      recordRunCalibration(current, {
        checkpointSaid: said('i'),
        disposition: { kind: 'Excluded', reason: 'ProviderUnavailable' },
      }),
    ).toMatchObject({
      kind: 'Recorded',
      run: {
        lifecycle: { kind: 'Ended', outcome: { kind: 'CalibrationExcluded' } },
        submissionVerification: { kind: 'NotSubmitted' },
      },
    });
    expect(
      recordRunCalibration(runningRun(), {
        checkpointSaid: said('i'),
        disposition: { kind: 'Excluded', reason: 'ProviderUnavailable' },
      }),
    ).toEqual({ kind: 'CalibrationPurposeRequired' });
    expect(
      planRunCalibration(runningRun(), {
        kind: 'Excluded',
        reason: 'ProviderUnavailable',
      }),
    ).toEqual({ kind: 'CalibrationPurposeRequired' });
    expect(
      recordRunCalibration(preparingRun(purpose), {
        checkpointSaid: said('i'),
        disposition: { kind: 'Excluded', reason: 'ProviderUnavailable' },
      }),
    ).toEqual({ kind: 'RunNotRunning' });
    expect(
      planRunCalibration(preparingRun(purpose), {
        kind: 'Excluded',
        reason: 'ProviderUnavailable',
      }),
    ).toEqual({ kind: 'RunNotRunning' });
    expect(
      planRunCalibration(preparingRun(purpose), {
        kind: 'Rejected',
        reason: 'ReceiptPatternMismatch',
      }),
    ).toEqual({ kind: 'RunNotRunning' });
    expect(
      recordRunCalibration(current, {
        checkpointSaid: said('i'),
        disposition: {
          kind: 'Confirmed',
          category: { ...category, taskRevisionSaid: said('x') },
        },
      }),
    ).toEqual({ kind: 'CalibrationCategoryBindingConflict' });
  });

  it('ends active Runs only for unrecoverable failure or current authority revocation', () => {
    const running = runningRun();
    expect(
      failRun(running, {
        failure: 'EvidenceIntegrityFailure',
        checkpointSaid: said('i'),
      }),
    ).toMatchObject({
      kind: 'Failed',
      run: { lifecycle: { kind: 'Ended', outcome: { kind: 'Failed' } } },
    });
    expect(
      revokeRunAuthority(running, {
        mandateSaid: running.binding.taskMandateSaid,
        checkpointSaid: said('i'),
      }),
    ).toMatchObject({
      kind: 'AuthorityRevoked',
      run: { lifecycle: { kind: 'Ended', outcome: { kind: 'AuthorityRevoked' } } },
    });
  });
});
