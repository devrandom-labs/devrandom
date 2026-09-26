import { runWorkAccessFixture } from '../../../test/run-work-access-fixture.js';
import { acquireFirstRunLease, ProtectedCredentials, type RunPurpose } from '@devrandom/domain';
import { governorAid, personalAgentAid } from '@devrandom/identity';
import { decodeRunProjection, taskBudgetCeilings } from '@devrandom/protocol';
import type { RunSupervision } from '@devrandom/runtime';
import { describe, expect, it, vi } from 'vitest';

import { baselineHarnessCommandFixture } from '../../../test/baseline-harness-fixture.js';
import { runIncarnationId, runProjectionFixture } from '../../../test/run-fixture.js';
import { taskProjectionFixture } from '../../../test/task-source-fixture.js';
import type { TaskRunPreparationOutcome } from './task-run-preparation.js';
import {
  TaskRunExecution,
  type AdmittedRunSupervision,
  type AdmittedRunSupervisionProvision,
  type AdmittedTaskRunPreparation,
} from './task-run-execution.js';

const promotionMandateSaid = 'EGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG';

function admittedPreparation(
  purpose: RunPurpose = { kind: 'Retained' },
): AdmittedTaskRunPreparation {
  const task = taskProjectionFixture();
  const command = baselineHarnessCommandFixture();
  const fixture = runProjectionFixture();
  const run = {
    ...fixture,
    purpose,
    activation:
      purpose.kind === 'PreparedCompatibilityCalibration' && purpose.ordinal === 1
        ? { ...fixture.activation, runId: fixture.runId, acceptedAt: fixture.acceptedAt }
        : fixture.activation,
  };
  return {
    kind: 'RunLeaseAcquired',
    protectedCredentials: new ProtectedCredentials(),
    task,
    mandates: {
      personalAgent: {
        aid: command.revision.authority.personalAgentAid,
        origin: 'existing-principal-verified',
      },
      governor: {
        aid: run.governorAid,
        origin: 'existing-principal-verified',
      },
      mandateRegistryId: 'EBdHrbtS_iH9Oe9IH-3UDsHYNuWpwrtnkDzO5fKrITyK',
      taskMandate: {
        credentialSaid: command.revision.authority.taskMandateSaid,
        holderGrantSaid: 'EBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        holderAdmissionSaid: 'ECCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
        serverGrantSaid: 'EDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD',
        expiresAt: '2026-09-24T22:00:00.000Z',
        admittedAt: '2026-09-24T18:16:00.000Z',
        allowedCapabilities: ['ReadRepository', 'RunTests', 'SubmitResult'],
        budgets: { ...taskBudgetCeilings },
        allowedEvolutionClasses: ['C1'],
      },
      promotionMandate: {
        credentialSaid: promotionMandateSaid,
        holderGrantSaid: 'EHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH',
        holderAdmissionSaid: 'EIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII',
        serverGrantSaid: 'EJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ',
        expiresAt: '2026-09-24T22:00:00.000Z',
        admittedAt: '2026-09-24T18:17:00.000Z',
        capabilityCeiling: ['ReadRepository', 'RunTests', 'SubmitResult'],
        budgetCeiling: { ...taskBudgetCeilings },
        evolutionClassCeiling: ['C1'],
        requiredEvidenceClasses: [
          'Diagnosis',
          'FalsifiableHypothesis',
          'ImmutableCandidate',
          'RepeatedPairedEvaluation',
          'LockedHoldout',
          'SafetyAndAuthorityFloors',
          'TamperAudit',
          'WinnerSelection',
        ],
      },
    },
    harness: {
      kind: 'HarnessAdmitted',
      admission: 'Created',
      projection: {
        version: 1,
        ownerAid: task.ownerAid,
        commandId: command.commandId,
        acceptedAt: '2026-09-24T19:00:00.000Z',
        revision: command.revision,
      },
    },
    run: {
      kind: 'RunLeaseAcquired',
      leaseRequestStartedAt: 0,
      admission: 'Created',
      run,
      lease: {
        version: 1,
        disposition: 'Acquired',
        runId: run.runId,
        incarnationId: runIncarnationId,
        runVersion: run.runVersion + 1,
        serverTime: '2026-09-24T20:00:00.000Z',
        expiresAt: '2026-09-24T20:00:45.000Z',
      },
    },
    workAccessRenewal: runWorkAccessFixture(),
    executionAuthority: {
      personalAgentAid: personalAgentAid(task.ownerAid),
      taskMandateCustody: {
        inspectCredential: () => Promise.reject(new Error('not used')),
      },
      evidenceSealExchange: {
        prepare: () => Promise.reject(new Error('not used')),
        deliver: () => Promise.reject(new Error('not used')),
      },
    },
  };
}

function stoppedSupervision(preparation: AdmittedTaskRunPreparation): RunSupervision {
  const decoded = decodeRunProjection(preparation.run.run);
  if (decoded.kind !== 'Accepted') {
    throw new Error('fixture Run projection must decode');
  }
  const lease = preparation.run.lease;
  const acquired = acquireFirstRunLease(decoded.run, {
    incarnationId: lease.incarnationId,
    expectedRunVersion: decoded.run.version,
    serverTime: lease.serverTime,
  });
  if (acquired.kind !== 'Acquired') {
    throw new Error('fixture lease must acquire');
  }
  return {
    kind: 'Stopped',
    run: {
      ...acquired.run,
      version: acquired.run.version + 2,
      lifecycle: {
        kind: 'Active',
        phase: {
          kind: 'Blocked',
          reason: 'HarnessCompatibilityFailure',
          checkpointSaid: `E${'q'.repeat(43)}`,
        },
      },
      submissionVerification: { kind: 'Rejected' },
    },
    cause: {
      kind: 'ExecutorSettled',
      disposition: { kind: 'Completed', sessionId: crypto.randomUUID() },
    },
    latestHostedRunVersion: lease.runVersion,
  };
}

function calibratedSupervision(preparation: AdmittedTaskRunPreparation): RunSupervision {
  const stopped = stoppedSupervision(preparation);
  if (stopped.kind !== 'Stopped') throw new Error('fixture supervision must stop');
  return {
    ...stopped,
    run: {
      ...stopped.run,
      lifecycle: {
        kind: 'Ended',
        outcome: {
          kind: 'CalibrationConfirmed',
          checkpointSaid: `E${'q'.repeat(43)}`,
          category: {
            version: 1,
            taskId: preparation.task.taskId,
            taskRevisionSaid: preparation.task.revisionSaid,
            harnessRevisionSaid: preparation.harness.projection.revision.d,
            currentCommandSaid: `E${'r'.repeat(43)}`,
            tamperCommandSaid: `E${'s'.repeat(43)}`,
            legacyCommandSaid: `E${'t'.repeat(43)}`,
            legacyObservedExitCode: 101,
          },
        },
      },
    },
  };
}

describe('Task Run execution', () => {
  it.each([
    [
      {
        kind: 'Rejected',
        runId: '11111111-1111-4111-8111-111111111111',
        ordinal: 1,
        reason: 'H1Passed',
      },
      'CalibrationCampaignClosed',
    ],
    [
      { kind: 'RetainedRunExists', runId: '11111111-1111-4111-8111-111111111111' },
      'RetainedRunAlreadyAdmitted',
    ],
    [{ kind: 'Unavailable' }, 'CalibrationCampaignUnavailable'],
  ] as const)('never prepares another Run after $1', async (progress, expected) => {
    const prepare = vi.fn();
    const provision = vi.fn();
    const execution = new TaskRunExecution({
      campaigns: {
        acquire: () => Promise.resolve({ kind: 'Acquired', campaignId: crypto.randomUUID() }),
      },
      history: { inspect: () => Promise.resolve(progress) },
      preparation: { prepare },
      supervision: { provision },
    });
    expect(await execution.run('receipt', new AbortController().signal)).toMatchObject({
      kind: expected,
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
  });

  it('prepares only the retained slot after five sealed attempts', async () => {
    const prepare = vi.fn((_label: string, purpose: RunPurpose) =>
      Promise.resolve(admittedPreparation(purpose)),
    );
    const execution = new TaskRunExecution({
      campaigns: {
        acquire: () => Promise.resolve({ kind: 'Acquired', campaignId: crypto.randomUUID() }),
      },
      history: {
        inspect: () =>
          Promise.resolve({ kind: 'Ready', nextOrdinal: 6, confirmed: 4, excluded: 1 }),
      },
      preparation: { prepare },
      supervision: {
        provision: () => ({
          supervise: () => Promise.resolve({ kind: 'SupervisorIntegrityFailure' }),
        }),
      },
    });
    expect(await execution.run('receipt', new AbortController().signal)).toMatchObject({
      kind: 'RunSupervised',
      calibrations: { confirmed: 4, excluded: 1 },
    });
    expect(prepare).toHaveBeenCalledExactlyOnceWith('receipt', { kind: 'Retained' });
  });

  it('preserves an insufficient completed campaign without another attempt', async () => {
    const prepare = vi.fn();
    const execution = new TaskRunExecution({
      campaigns: {
        acquire: () => Promise.resolve({ kind: 'Acquired', campaignId: crypto.randomUUID() }),
      },
      history: {
        inspect: () =>
          Promise.resolve({ kind: 'Ready', nextOrdinal: 6, confirmed: 3, excluded: 2 }),
      },
      preparation: { prepare },
      supervision: { provision: vi.fn() },
    });
    expect(await execution.run('receipt', new AbortController().signal)).toEqual({
      kind: 'CalibrationInsufficient',
      confirmed: 3,
      excluded: 2,
    });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('resumes at ordinal two after a verified sealed first calibration without replaying its lease', async () => {
    const prepare = vi.fn((_label: string, purpose: RunPurpose) =>
      Promise.resolve(admittedPreparation(purpose)),
    );
    const supervise = vi.fn<AdmittedRunSupervision['supervise']>((run, lease) =>
      Promise.resolve({
        kind: 'Stopped',
        run,
        cause: { kind: 'UserInterrupted' },
        latestHostedRunVersion: lease.runVersion,
      }),
    );
    const execution = new TaskRunExecution({
      campaigns: {
        acquire: () =>
          Promise.resolve({ kind: 'Acquired', campaignId: '2ae44718-f146-47fc-8507-14b75fd7fa98' }),
      },
      history: {
        inspect: () =>
          Promise.resolve({ kind: 'Ready', nextOrdinal: 2, confirmed: 1, excluded: 0 }),
      },
      preparation: { prepare },
      supervision: { provision: () => ({ supervise }) },
    });
    await expect(execution.run('receipt', new AbortController().signal)).resolves.toMatchObject({
      kind: 'CalibrationRunUnsettled',
      ordinal: 2,
    });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0]?.[1]).toMatchObject({
      kind: 'PreparedCompatibilityCalibration',
      ordinal: 2,
    });
  });

  it('returns the original unresolved Run ID without requesting another ordinal or lease', async () => {
    const prepare = vi.fn();
    const execution = new TaskRunExecution({
      campaigns: {
        acquire: () =>
          Promise.resolve({ kind: 'Acquired', campaignId: '2ae44718-f146-47fc-8507-14b75fd7fa98' }),
      },
      history: {
        inspect: () =>
          Promise.resolve({
            kind: 'RecoveryRequired',
            runId: '81d7f67f-d2f9-4fae-87cc-ac827de6f0d1',
            ordinal: 1,
          }),
      },
      preparation: { prepare },
      supervision: { provision: vi.fn() },
    });
    await expect(execution.run('receipt', new AbortController().signal)).resolves.toEqual({
      kind: 'CalibrationRecoveryRequired',
      runId: '81d7f67f-d2f9-4fae-87cc-ac827de6f0d1',
      ordinal: 1,
    });
    expect(prepare).not.toHaveBeenCalled();
  });
  it('reconstructs a reconciled first lease with its remaining interval and preserves request timing', async () => {
    const supervise = vi.fn<AdmittedRunSupervision['supervise']>((run) =>
      Promise.resolve({
        kind: 'Stopped',
        run,
        cause: { kind: 'UserInterrupted' },
        latestHostedRunVersion: run.version,
      }),
    );
    const execution = new TaskRunExecution({
      history: {
        inspect: () =>
          Promise.resolve({ kind: 'Ready', nextOrdinal: 1, confirmed: 0, excluded: 0 }),
      },
      campaigns: {
        acquire: () =>
          Promise.resolve({ kind: 'Acquired', campaignId: '2ae44718-f146-47fc-8507-14b75fd7fa98' }),
      },
      preparation: {
        prepare: (_label, purpose) => {
          const prepared = admittedPreparation(purpose);
          return Promise.resolve({
            ...prepared,
            run: {
              ...prepared.run,
              leaseRequestStartedAt: 123,
              lease: {
                ...prepared.run.lease,
                disposition: 'Reconciled',
                serverTime: '2026-09-24T20:00:20.000Z',
              },
            },
          });
        },
      },
      supervision: { provision: () => ({ supervise }) },
    });
    const signal = new AbortController().signal;
    await expect(execution.run('receipt', signal)).resolves.toMatchObject({
      kind: 'CalibrationRunUnsettled',
      ordinal: 1,
    });
    expect(supervise).toHaveBeenCalledOnce();
    expect(supervise.mock.calls[0]?.[0].lease).toMatchObject({
      kind: 'Held',
      acquiredAt: '2026-09-24T20:00:00.000Z',
      expiresAt: '2026-09-24T20:00:45.000Z',
    });
    expect(supervise.mock.calls[0]?.[1].serverTime).toBe('2026-09-24T20:00:20.000Z');
    expect(supervise.mock.calls[0]?.[2]).toBe(signal);
    expect(supervise.mock.calls[0]?.[3]).toBe(123);
  });

  it('starts supervision only after reconstructing the exact admitted Run and first lease', async () => {
    const retained = admittedPreparation();
    const signal = new AbortController().signal;
    const supervised = stoppedSupervision(retained);
    const supervise = vi.fn<AdmittedRunSupervision['supervise']>((run) => {
      const preparation = admittedPreparation(run.binding.purpose);
      return Promise.resolve(
        run.binding.purpose.kind === 'Retained' ? supervised : calibratedSupervision(preparation),
      );
    });
    const provision = vi
      .fn<AdmittedRunSupervisionProvision['provision']>()
      .mockReturnValue({ supervise });
    const execution = new TaskRunExecution({
      history: {
        inspect: () =>
          Promise.resolve({ kind: 'Ready', nextOrdinal: 1, confirmed: 0, excluded: 0 }),
      },
      campaigns: {
        acquire: () =>
          Promise.resolve({ kind: 'Acquired', campaignId: '2ae44718-f146-47fc-8507-14b75fd7fa98' }),
      },
      preparation: { prepare: (_label, purpose) => Promise.resolve(admittedPreparation(purpose)) },
      supervision: { provision },
    });

    await expect(execution.run(retained.task.label, signal)).resolves.toMatchObject({
      kind: 'RunSupervised',
      preparation: {
        task: { taskId: retained.task.taskId },
        run: { run: { purpose: { kind: 'Retained' } } },
      },
      supervision: supervised,
      calibrations: { confirmed: 5, excluded: 0 },
    });
    expect(provision).toHaveBeenCalledTimes(6);
    expect(supervise).toHaveBeenCalledTimes(6);
    const invocation = supervise.mock.calls[5];
    expect(invocation?.[0]).toMatchObject({
      version: retained.run.lease.runVersion,
      binding: { runId: retained.run.run.runId, purpose: { kind: 'Retained' } },
      lease: {
        kind: 'Held',
        incarnationId: retained.run.lease.incarnationId,
        acquiredAt: retained.run.lease.serverTime,
        expiresAt: retained.run.lease.expiresAt,
      },
    });
    expect(invocation?.[1]).toEqual({
      runId: retained.run.lease.runId,
      incarnationId: retained.run.lease.incarnationId,
      runVersion: retained.run.lease.runVersion,
      serverTime: retained.run.lease.serverTime,
      expiresAt: retained.run.lease.expiresAt,
    });
    expect(invocation?.[2]).toBe(signal);
    expect(invocation?.[3]).toBe(retained.run.leaseRequestStartedAt);
  });

  it.each(['ManagedWorktreeConflict', 'EvidenceUnavailable'] as const)(
    'does not count or duplicate an admitted calibration after %s',
    async (failure) => {
      const prepare = vi.fn((_label: string, purpose: RunPurpose = { kind: 'Retained' }) =>
        Promise.resolve(admittedPreparation(purpose)),
      );
      const supervise = vi.fn<AdmittedRunSupervision['supervise']>((run, lease) =>
        Promise.resolve({
          kind: 'Stopped',
          run,
          cause: { kind: 'PreparationRejected', failure: { kind: failure } },
          latestHostedRunVersion: lease.runVersion,
        }),
      );
      const execution = new TaskRunExecution({
        history: {
          inspect: () =>
            Promise.resolve({ kind: 'Ready', nextOrdinal: 1, confirmed: 0, excluded: 0 }),
        },
        campaigns: {
          acquire: () => Promise.resolve({ kind: 'Acquired', campaignId: crypto.randomUUID() }),
        },
        preparation: { prepare },
        supervision: { provision: () => ({ supervise }) },
      });

      await expect(
        execution.run('repair-parser', new AbortController().signal),
      ).resolves.toMatchObject({
        kind: 'CalibrationRunUnsettled',
        ordinal: 1,
        supervision: {
          kind: 'Stopped',
          run: {
            lifecycle: { kind: 'Active', phase: { kind: 'Preparing' } },
            submissionVerification: { kind: 'NotSubmitted' },
          },
          cause: { kind: 'PreparationRejected', failure: { kind: failure } },
        },
      });
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(supervise).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['CustodyUnavailable', 'RunResumeRequired'] as const)(
    'returns %s without provisioning any runtime',
    async (kind) => {
      const outcome: TaskRunPreparationOutcome = { kind };
      const provision = vi.fn<AdmittedRunSupervisionProvision['provision']>().mockReturnValue({
        supervise: vi
          .fn<AdmittedRunSupervision['supervise']>()
          .mockResolvedValue({ kind: 'SupervisorIntegrityFailure' }),
      });
      const execution = new TaskRunExecution({
        history: {
          inspect: () =>
            Promise.resolve({ kind: 'Ready', nextOrdinal: 1, confirmed: 0, excluded: 0 }),
        },
        campaigns: {
          acquire: () => Promise.resolve({ kind: 'Acquired', campaignId: crypto.randomUUID() }),
        },
        preparation: { prepare: () => Promise.resolve(outcome) },
        supervision: { provision },
      });

      await expect(execution.run('repair-parser', new AbortController().signal)).resolves.toEqual(
        outcome,
      );
      expect(provision).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: 'Run identity',
      mutate: (prepared: AdmittedTaskRunPreparation): AdmittedTaskRunPreparation => ({
        ...prepared,
        run: {
          ...prepared.run,
          lease: { ...prepared.run.lease, runId: crypto.randomUUID() },
        },
      }),
      rejection: 'LeaseRunMismatch',
    },
    {
      name: 'Run version',
      mutate: (prepared: AdmittedTaskRunPreparation): AdmittedTaskRunPreparation => ({
        ...prepared,
        run: {
          ...prepared.run,
          lease: { ...prepared.run.lease, runVersion: prepared.run.lease.runVersion + 1 },
        },
      }),
      rejection: 'LeaseVersionMismatch',
    },
    {
      name: 'lease time',
      mutate: (prepared: AdmittedTaskRunPreparation): AdmittedTaskRunPreparation => ({
        ...prepared,
        run: {
          ...prepared.run,
          lease: {
            ...prepared.run.lease,
            expiresAt: '2026-09-24T20:00:44.000Z',
          },
        },
      }),
      rejection: 'LeaseTimeMismatch',
    },
  ])('rejects a mismatched $name before provisioning', async ({ mutate, rejection }) => {
    const provision = vi.fn<AdmittedRunSupervisionProvision['provision']>().mockReturnValue({
      supervise: vi
        .fn<AdmittedRunSupervision['supervise']>()
        .mockResolvedValue({ kind: 'SupervisorIntegrityFailure' }),
    });
    const execution = new TaskRunExecution({
      history: {
        inspect: () =>
          Promise.resolve({ kind: 'Ready', nextOrdinal: 1, confirmed: 0, excluded: 0 }),
      },
      campaigns: {
        acquire: () => Promise.resolve({ kind: 'Acquired', campaignId: crypto.randomUUID() }),
      },
      preparation: {
        prepare: (_label, purpose) => Promise.resolve(mutate(admittedPreparation(purpose))),
      },
      supervision: { provision },
    });

    await expect(execution.run('repair-parser', new AbortController().signal)).resolves.toEqual({
      kind: 'AdmittedRunBindingRejected',
      reason: rejection,
    });
    expect(provision).not.toHaveBeenCalled();
  });

  it('rejects a Run whose authoritative bindings differ from the complete preparation', async () => {
    const prepared = admittedPreparation();
    const provision = vi.fn<AdmittedRunSupervisionProvision['provision']>().mockReturnValue({
      supervise: vi
        .fn<AdmittedRunSupervision['supervise']>()
        .mockResolvedValue({ kind: 'SupervisorIntegrityFailure' }),
    });
    const execution = new TaskRunExecution({
      history: {
        inspect: () =>
          Promise.resolve({ kind: 'Ready', nextOrdinal: 1, confirmed: 0, excluded: 0 }),
      },
      campaigns: {
        acquire: () => Promise.resolve({ kind: 'Acquired', campaignId: crypto.randomUUID() }),
      },
      preparation: {
        prepare: (_label, purpose) =>
          Promise.resolve({
            ...admittedPreparation(purpose),
            mandates: {
              ...admittedPreparation(purpose).mandates,
              personalAgent: {
                ...prepared.mandates.personalAgent,
                aid: personalAgentAid(prepared.task.ownerAid),
              },
              governor: {
                ...prepared.mandates.governor,
                aid: governorAid(prepared.mandates.governor.aid),
              },
            },
          }),
      },
      supervision: { provision },
    });

    await expect(execution.run('repair-parser', new AbortController().signal)).resolves.toEqual({
      kind: 'AdmittedRunBindingRejected',
      reason: 'PreparationBindingMismatch',
    });
    expect(provision).not.toHaveBeenCalled();
  });
});
