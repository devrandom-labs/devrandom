import { describe, expect, it, vi } from 'vitest';

import { effectiveRunBudget } from '@devrandom/domain';
import type { RunAdmissionPayload } from '@devrandom/protocol';

import {
  baselineHarnessCommandFixture,
  harnessTask,
} from '../../harness/test/harness-command-fixture.js';
import { taskOwnerAid } from '../../task/test/task-command-fixture.js';
import { admitRun, type AdmitRunDependencies } from './admit-run.js';
import type { RunAdmissionReservations } from './run-admissions.js';

const value = (character: string) => `E${character.repeat(43)}`;
const commandId = 'd2c9160a-58f8-4d43-ae67-22124c6e9112';
const admissionExchangeSaid = value('z');
const governorAid = value('y');
const promotionMandateSaid = value('x');
const harnessCommand = baselineHarnessCommandFixture();
const revision = harnessCommand.revision;
const acceptedAt = '2026-09-24T20:00:00.000Z';
const requestedBudget = effectiveRunBudget({
  requested: revision.budgetCeilings.task,
  task: revision.budgetCeilings.task,
  server: revision.budgetCeilings.server,
  mandate: revision.budgetCeilings.mandate,
});

const payload: RunAdmissionPayload = {
  version: 1,
  kind: 'RunAdmission',
  commandId,
  taskId: revision.task.taskId,
  taskRevisionSaid: revision.task.revisionSaid,
  harnessLineageId: revision.task.harnessLineageId,
  harnessRevisionSaid: revision.d,
  taskMandateSaid: revision.authority.taskMandateSaid,
  governorAid,
  promotionMandateSaid,
  purpose: {
    kind: 'PreparedCompatibilityCalibration',
    campaignId: '4dd443a3-d93c-4857-8ede-b08aa3f979c5',
    ordinal: 1,
  },
  repository: {
    objectFormat: revision.repository.objectFormat,
    commit: revision.repository.commit,
    tree: revision.repository.tree,
  },
  requestedBudget,
};

const command = { version: 1 as const, commandId, admissionExchangeSaid };
const owner = { ownerAid: taskOwnerAid, credentialSaid: value('w') };

function reservations(): RunAdmissionReservations {
  return {
    reserve: () => Promise.resolve({ kind: 'RunAdmissionReserved' }),
  };
}

function dependencies(overrides: Partial<AdmitRunDependencies> = {}): AdmitRunDependencies {
  return {
    currentUserCredential: {
      verify: () => Promise.resolve({ kind: 'UserCredentialCurrent' }),
    },
    reservations: reservations(),
    exchange: {
      inspect: () =>
        Promise.resolve({
          kind: 'Verified',
          sourceAid: revision.authority.personalAgentAid,
          payload,
        }),
    },
    harnesses: {
      findAccepted: () =>
        Promise.resolve({
          kind: 'AcceptedHarnessFound',
          projection: {
            version: 1,
            ownerAid: taskOwnerAid,
            commandId: harnessCommand.commandId,
            acceptedAt,
            revision,
          },
          activation: {
            kind: 'AwaitingRunAdmission',
            harnessLineageId: revision.task.harnessLineageId,
            harnessRevisionSaid: revision.d,
          },
        }),
    },
    currentMandates: {
      authorize: () =>
        Promise.resolve({
          kind: 'CurrentRunMandatesAuthorized',
          task: harnessTask,
          personalAgentAid: revision.authority.personalAgentAid,
          taskMandateSaid: revision.authority.taskMandateSaid,
          taskMandateBudget: revision.budgetCeilings.mandate,
          governorAid,
          promotionMandateSaid,
        }),
    },
    commitments: {
      accept: ({ run }) => Promise.resolve({ kind: 'RunCommitted', run }),
    },
    now: () => acceptedAt,
    newRunId: () => '1cc482f1-98e9-4454-8e4c-5566cb47ce3d',
    newEvidenceStreamId: () => 'a1975db1-6130-41c2-b9dd-c8ec8bc12c94',
    ...overrides,
  };
}

describe('Run admission application', () => {
  it('persists one pending command and creates no Run while the exact exchange is unavailable', async () => {
    const reserve = vi.fn<RunAdmissionReservations['reserve']>(() =>
      Promise.resolve({ kind: 'RunAdmissionReserved' }),
    );
    const accept = vi.fn<AdmitRunDependencies['commitments']['accept']>();

    const outcome = await admitRun(
      { owner, command },
      dependencies({
        reservations: { reserve },
        exchange: { inspect: () => Promise.resolve({ kind: 'Pending' }) },
        commitments: { accept },
      }),
    );

    expect(outcome).toEqual({
      kind: 'RunAdmissionExchangePending',
      projection: {
        version: 1,
        disposition: 'RunAdmissionExchangePending',
        commandId,
        admissionExchangeSaid,
      },
    });
    expect(reserve).toHaveBeenCalledOnce();
    expect(accept).not.toHaveBeenCalled();
  });

  it('binds both mandate holders and requests one atomic H1 inception plus Run commit', async () => {
    const accept = vi.fn<AdmitRunDependencies['commitments']['accept']>(({ run }) =>
      Promise.resolve({ kind: 'RunCommitted', run }),
    );

    const outcome = await admitRun({ owner, command }, dependencies({ commitments: { accept } }));

    expect(outcome).toMatchObject({
      kind: 'RunCreated',
      projection: {
        runVersion: 0,
        ownerAid: taskOwnerAid,
        taskId: revision.task.taskId,
        harnessRevisionSaid: revision.d,
        personalAgentAid: revision.authority.personalAgentAid,
        governorAid,
        lifecycle: { kind: 'Active', phase: { kind: 'Preparing' } },
        submissionVerification: { kind: 'NotSubmitted' },
        lease: { kind: 'Unassigned' },
        activation: { kind: 'InitialSpecializationAccepted' },
      },
    });
    expect(accept).toHaveBeenCalledOnce();
    const acceptedInput = accept.mock.calls.at(0)?.at(0);
    if (acceptedInput === undefined) {
      throw new Error('expected a Run commitment');
    }
    expect(acceptedInput.run.lifecycle).toEqual({
      kind: 'Active',
      phase: { kind: 'Preparing' },
    });
    expect(acceptedInput.activation).toMatchObject({
      kind: 'InitialSpecializationAccepted',
      harnessRevisionSaid: revision.d,
    });
  });

  it('binds the exact signed calibration purpose into the durable Run', async () => {
    const purpose = {
      kind: 'PreparedCompatibilityCalibration' as const,
      campaignId: '4dd443a3-d93c-4857-8ede-b08aa3f979c5',
      ordinal: 1 as const,
    };
    const accept = vi.fn<AdmitRunDependencies['commitments']['accept']>(({ run }) =>
      Promise.resolve({ kind: 'RunCommitted', run }),
    );

    const outcome = await admitRun(
      { owner, command },
      dependencies({
        exchange: {
          inspect: () =>
            Promise.resolve({
              kind: 'Verified',
              sourceAid: revision.authority.personalAgentAid,
              payload: { ...payload, purpose },
            }),
        },
        commitments: { accept },
      }),
    );

    expect(outcome).toMatchObject({
      kind: 'RunCreated',
      projection: { purpose },
    });
    expect(accept).toHaveBeenCalledOnce();
    const acceptedInput = accept.mock.calls.at(0)?.at(0);
    if (acceptedInput === undefined) {
      throw new Error('expected a Run commitment');
    }
    expect(acceptedInput.run.binding).toMatchObject({ purpose });
  });

  it('admits a later calibration against the exact incumbent H1 without re-inception', async () => {
    const purpose = {
      kind: 'PreparedCompatibilityCalibration' as const,
      campaignId: '4dd443a3-d93c-4857-8ede-b08aa3f979c5',
      ordinal: 2 as const,
    };
    const incumbent = {
      kind: 'InitialSpecializationAccepted' as const,
      harnessLineageId: revision.task.harnessLineageId,
      harnessRevisionSaid: revision.d,
      runId: '8ea175de-54c0-48f7-a7e2-42aaac748764',
      acceptedAt: '2026-09-24T19:55:00.000Z',
    };
    const accept = vi.fn<AdmitRunDependencies['commitments']['accept']>(({ run }) =>
      Promise.resolve({ kind: 'RunCommitted', run }),
    );

    const outcome = await admitRun(
      { owner, command },
      dependencies({
        exchange: {
          inspect: () =>
            Promise.resolve({
              kind: 'Verified',
              sourceAid: revision.authority.personalAgentAid,
              payload: { ...payload, purpose },
            }),
        },
        harnesses: {
          findAccepted: () =>
            Promise.resolve({
              kind: 'AcceptedHarnessFound',
              projection: {
                version: 1,
                ownerAid: taskOwnerAid,
                commandId: harnessCommand.commandId,
                acceptedAt,
                revision,
              },
              activation: incumbent,
            }),
        },
        commitments: { accept },
      }),
    );

    expect(outcome).toMatchObject({ kind: 'RunCreated', projection: { purpose } });
    const acceptedInput = accept.mock.calls.at(0)?.at(0);
    if (acceptedInput === undefined) {
      throw new Error('expected a Run commitment');
    }
    expect(acceptedInput.activation).toEqual(incumbent);
  });

  it('checks mandate currentness at a fresh server instant after exchange retrieval', async () => {
    const authorize = vi.fn<AdmitRunDependencies['currentMandates']['authorize']>(() =>
      dependencies().currentMandates.authorize({
        ownerAid: owner.ownerAid,
        taskId: payload.taskId,
        taskRevisionSaid: payload.taskRevisionSaid,
        harnessLineageId: payload.harnessLineageId,
        personalAgentAid: revision.authority.personalAgentAid,
        taskMandateSaid: payload.taskMandateSaid,
        governorAid,
        promotionMandateSaid,
        observedAt: '2026-09-24T20:01:00.000Z',
      }),
    );
    const now = vi
      .fn<AdmitRunDependencies['now']>()
      .mockReturnValueOnce('2026-09-24T20:00:00.000Z')
      .mockReturnValueOnce('2026-09-24T20:01:00.000Z');

    const outcome = await admitRun(
      { owner, command },
      dependencies({ currentMandates: { authorize }, now }),
    );

    expect(outcome).toMatchObject({
      kind: 'RunCreated',
      projection: { acceptedAt: '2026-09-24T20:01:00.000Z' },
    });
    expect(authorize).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ observedAt: '2026-09-24T20:01:00.000Z' }),
    );
    expect(now).toHaveBeenCalledTimes(2);
  });

  it('intersects a lawful lower signed request with every authority ceiling', async () => {
    const accept = vi.fn<AdmitRunDependencies['commitments']['accept']>(({ run }) =>
      Promise.resolve({ kind: 'RunCommitted', run }),
    );
    const lowerRequestedBudget = {
      ...payload.requestedBudget,
      providerRequests: payload.requestedBudget.providerRequests - 1,
    };
    const outcome = await admitRun(
      { owner, command },
      dependencies({
        exchange: {
          inspect: () =>
            Promise.resolve({
              kind: 'Verified',
              sourceAid: revision.authority.personalAgentAid,
              payload: {
                ...payload,
                requestedBudget: lowerRequestedBudget,
              },
            }),
        },
        commitments: { accept },
      }),
    );

    expect(outcome).toMatchObject({
      kind: 'RunCreated',
      projection: {
        budget: { ceiling: { providerRequests: lowerRequestedBudget.providerRequests } },
      },
    });
    expect(accept).toHaveBeenCalledOnce();
    const acceptedInput = accept.mock.calls.at(0)?.at(0);
    if (acceptedInput === undefined) {
      throw new Error('expected a Run commitment');
    }
    expect(acceptedInput.run.binding.budget.providerRequests).toBe(
      lowerRequestedBudget.providerRequests,
    );
  });
});
