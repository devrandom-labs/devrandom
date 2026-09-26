import { runWorkAccessFixture } from '../../../test/run-work-access-fixture.js';
import {
  confirmCurrentUserCustody,
  ProtectedCredentials,
  decideUserAdmission,
  promotionEvidenceClasses,
  verifyDevrandomUserCredential,
  type AdmittedUser,
} from '@devrandom/domain';
import { taskBudgetCeilings } from '@devrandom/protocol';
import { governorAid, personalAgentAid } from '@devrandom/identity';
import { describe, expect, it, vi } from 'vitest';

import { taskProjectionFixture } from '../../../test/task-source-fixture.js';
import { baselineHarnessCommandFixture } from '../../../test/baseline-harness-fixture.js';
import { runIncarnationId, runProjectionFixture } from '../../../test/run-fixture.js';
import type { HostedMandatePresentations } from '../../mandate/application/hosted-mandate-presentations.js';
import type { HostedEvidence } from '../../run/application/evidence-delivery.js';
import type { HostedEvidenceSeals } from '../../run/application/evidence-seal-delivery.js';
import type { HostedTasks } from './user-tasks.js';
import {
  TaskRunPreparation,
  type LocalTaskMandates,
  type TaskRunWorkAuthority,
} from './task-run-preparation.js';

const userAid = 'EMstL6Th90iB6MpQkPjKN2ii7a5XcvA_PCHWHrAAD-l4';
const issuerAid = 'EHcQUn2xY9KN1yv6FP0c6-pxej14Z8JDD3IYLddg0wOh';

function admittedUser(): AdmittedUser {
  const custody = confirmCurrentUserCustody({
    user: { aid: userAid },
    controllerAid: 'EOb-FtVoyOOKTAf9GVdIlmfiSL53StlAY8vobkPRdmt4',
    keriaAgentAid: 'EJlw5Fw9LKH1CYFEkGiDUlx0cHozvXb7hfqhSoMsH6bs',
    kelSequence: 0,
    witnessAids: ['BBilc4-L3tFUnfM_wJr4S4OJanAv_VmF_dJNN6vkf2Ha'],
    witnessThreshold: 1,
    witnessReceiptIndexes: [0],
    verifiedAt: '2026-09-24T18:00:00.000Z',
  });
  if (custody.kind !== 'Current') {
    throw new Error('test custody must be current');
  }
  const credential = verifyDevrandomUserCredential(
    {
      issuerAid,
      issueeAid: userAid,
      registryId: 'EBdHrbtS_iH9Oe9IH-3UDsHYNuWpwrtnkDzO5fKrITyK',
      schemaSaid: 'EOb-FtVoyOOKTAf9GVdIlmfiSL53StlAY8vobkPRdmt4',
    },
    {
      credentialSaid: 'EOiOyOhb0YSm2r84POPLVrHAwb1B81LZZH80gQGKjjho',
      attributeSaid: 'EAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      issuerAid,
      issueeAid: userAid,
      registryId: 'EBdHrbtS_iH9Oe9IH-3UDsHYNuWpwrtnkDzO5fKrITyK',
      schemaSaid: 'EOb-FtVoyOOKTAf9GVdIlmfiSL53StlAY8vobkPRdmt4',
      issuedAt: '2026-09-24T17:00:00.000Z',
      verifiedAt: '2026-09-24T18:00:00.000Z',
      credentialSaidBinding: { kind: 'Verified' },
      attributeSaidBinding: { kind: 'Verified' },
      schemaDocument: {
        kind: 'Resolved',
        schemaSaid: 'EOb-FtVoyOOKTAf9GVdIlmfiSL53StlAY8vobkPRdmt4',
      },
      telState: { kind: 'Issued' },
      issuerAnchor: {
        kind: 'Anchored',
        eventSaid: 'EBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      },
      eligibilityClaims: [
        'CreateAgent',
        'CreateTask',
        'RunPrivateTask',
        'PublishHarness',
        'ReceiveTaskResults',
      ],
    },
  );
  if (credential.kind !== 'Current') {
    throw new Error('test credential must be current');
  }
  const admission = decideUserAdmission({
    kind: 'CurrentCustody',
    custody: custody.custody,
    credential: { kind: 'Current', credential: credential.credential },
  });
  if (admission.kind !== 'Ready') {
    throw new Error('test user must be admitted');
  }
  return admission.user;
}

const summary = {
  personalAgent: {
    aid: 'EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz',
    origin: 'existing-principal-verified',
  },
  governor: {
    aid: 'EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk',
    origin: 'existing-principal-verified',
  },
  mandateRegistryId: 'EBdHrbtS_iH9Oe9IH-3UDsHYNuWpwrtnkDzO5fKrITyK',
  taskMandate: {
    credentialSaid: 'EAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    holderGrantSaid: 'ECCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
    holderAdmissionSaid: 'EDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD',
    serverGrantSaid: 'EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF',
    expiresAt: '2026-09-24T22:00:00.000Z',
    admittedAt: '2026-09-24T18:16:00.000Z',
    allowedCapabilities: ['ReadRepository', 'RunTests', 'SubmitResult'],
    budgets: { ...taskBudgetCeilings },
    allowedEvolutionClasses: ['C1'],
  },
  promotionMandate: {
    credentialSaid: 'EGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG',
    holderGrantSaid: 'EHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH',
    holderAdmissionSaid: 'EIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII',
    serverGrantSaid: 'EJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ',
    expiresAt: '2026-09-24T22:00:00.000Z',
    admittedAt: '2026-09-24T18:17:00.000Z',
    capabilityCeiling: ['ReadRepository', 'RunTests', 'SubmitResult'],
    budgetCeiling: { ...taskBudgetCeilings },
    evolutionClassCeiling: ['C1'],
    requiredEvidenceClasses: promotionEvidenceClasses,
  },
} as const;

describe('Task Run mandate preparation', () => {
  it('uses one authenticated work authority for Task inspection and both mandate presentations', async () => {
    const task = taskProjectionFixture();
    const inspect = vi.fn(() => Promise.resolve({ kind: 'Inspected', task } as const));
    const tasks: HostedTasks = {
      create: () => Promise.reject(new Error('not used')),
      list: () => Promise.reject(new Error('not used')),
      inspect,
    };
    const presentations: HostedMandatePresentations = {
      present: () => Promise.reject(new Error('owned by local mandate preparation')),
    };
    const user = admittedUser();
    const harnesses = { admit: () => Promise.reject(new Error('owned by H1 preparation')) };
    const runs = {
      admit: () => Promise.reject(new Error('owned by local Run admission')),
      acquireLease: () => Promise.reject(new Error('owned by local Run admission')),
      renewLease: () => Promise.reject(new Error('owned by the Run Supervisor')),
    };
    const evidence: HostedEvidence & HostedEvidenceSeals = {
      storeArtifact: () => Promise.reject(new Error('owned by evidence delivery')),
      appendBatch: () => Promise.reject(new Error('owned by evidence delivery')),
      reconcileSeal: () => Promise.reject(new Error('owned by evidence sealing')),
    };
    const protectedCredentials = new ProtectedCredentials();
    const workAccessRenewal = runWorkAccessFixture({ runs, evidence });
    const authority: TaskRunWorkAuthority = {
      acquireHostedWork: () =>
        Promise.resolve({
          kind: 'Authorized',
          protectedCredentials,
          user,
          tasks,
          presentations,
          harnesses,
          runs,
          evidence,
          workAccessRenewal,
          grantExpiresAt: '2026-09-24T18:30:00.000Z',
        }),
    };
    const harnessAuthority = {
      personalAgentAid: summary.personalAgent.aid,
      taskMandateSaid: summary.taskMandate.credentialSaid,
      allowedCapabilities: summary.taskMandate.allowedCapabilities,
      mandateBudgets: summary.taskMandate.budgets,
    } as const;
    const runAuthority = {
      personalAgentAid: personalAgentAid(summary.personalAgent.aid),
      governorAid: governorAid(summary.governor.aid),
      exchange: {
        prepare: () => Promise.reject(new Error('owned by local Run admission')),
        deliver: () => Promise.reject(new Error('owned by local Run admission')),
      },
    };
    const executionAuthority = {
      personalAgentAid: runAuthority.personalAgentAid,
      taskMandateCustody: {
        inspectCredential: () => Promise.reject(new Error('owned by the Tool Gateway')),
      },
      evidenceSealExchange: {
        prepare: () => Promise.reject(new Error('owned by evidence sealing')),
        deliver: () => Promise.reject(new Error('owned by evidence sealing')),
      },
    };
    const prepare = vi.fn(() =>
      Promise.resolve({
        kind: 'Prepared',
        summary,
        harnessAuthority,
        runAuthority,
        executionAuthority,
      } as const),
    );
    const localMandates: LocalTaskMandates = { prepare };
    const command = baselineHarnessCommandFixture();
    const harness = {
      kind: 'HarnessAdmitted' as const,
      admission: 'Created' as const,
      projection: {
        version: 1 as const,
        ownerAid: task.ownerAid,
        commandId: command.commandId,
        acceptedAt: '2026-09-24T19:00:00.000Z',
        revision: command.revision,
      },
    };
    const prepareHarness = vi.fn(() => Promise.resolve(harness));
    const run = runProjectionFixture();
    const runOutcome = {
      kind: 'RunLeaseAcquired' as const,
      leaseRequestStartedAt: 0,
      admission: 'Created' as const,
      run,
      lease: {
        version: 1 as const,
        disposition: 'Acquired' as const,
        runId: run.runId,
        incarnationId: runIncarnationId,
        runVersion: 1,
        serverTime: '2026-09-24T20:00:00.000Z',
        expiresAt: '2026-09-24T20:00:45.000Z',
      },
    };
    const admitRun = vi.fn(() => Promise.resolve(runOutcome));

    await expect(
      new TaskRunPreparation({
        authority,
        localMandates,
        localHarness: { prepare: prepareHarness },
        localRun: { admit: admitRun },
      }).prepare('repair-parser', { kind: 'Retained' }),
    ).resolves.toEqual({
      kind: 'RunLeaseAcquired',
      protectedCredentials,
      task,
      mandates: summary,
      harness,
      run: runOutcome,
      workAccessRenewal,
      executionAuthority,
    });
    expect(inspect).toHaveBeenCalledExactlyOnceWith('repair-parser');
    expect(prepare).toHaveBeenCalledExactlyOnceWith({
      user,
      task,
      presentations,
      grantExpiresAt: '2026-09-24T18:30:00.000Z',
    });
    expect(prepareHarness).toHaveBeenCalledExactlyOnceWith({
      protectedCredentials,
      task,
      authority: harnessAuthority,
      hosted: harnesses,
    });
    expect(admitRun).toHaveBeenCalledExactlyOnceWith({
      task,
      harness: harness.projection,
      personalAgentAid: runAuthority.personalAgentAid,
      governorAid: runAuthority.governorAid,
      promotionMandateSaid: summary.promotionMandate.credentialSaid,
      requestedBudget: harness.projection.revision.budgetCeilings.task,
      purpose: { kind: 'Retained' },
      exchange: runAuthority.exchange,
      hosted: runs,
    });
  });

  it('does not touch local custody when authoritative Task inspection is rejected', async () => {
    const prepare = vi.fn();
    const localMandates: LocalTaskMandates = { prepare };
    const authority: TaskRunWorkAuthority = {
      acquireHostedWork: () =>
        Promise.resolve({
          kind: 'Authorized',
          protectedCredentials: new ProtectedCredentials(),
          user: admittedUser(),
          tasks: {
            create: () => Promise.reject(new Error('not used')),
            list: () => Promise.reject(new Error('not used')),
            inspect: () => Promise.resolve({ kind: 'InputInvalid' }),
          },
          presentations: { present: () => Promise.reject(new Error('not used')) },
          harnesses: { admit: () => Promise.reject(new Error('not used')) },
          runs: {
            admit: () => Promise.reject(new Error('not used')),
            acquireLease: () => Promise.reject(new Error('not used')),
            renewLease: () => Promise.reject(new Error('not used')),
          },
          evidence: {
            storeArtifact: () => Promise.reject(new Error('not used')),
            appendBatch: () => Promise.reject(new Error('not used')),
            reconcileSeal: () => Promise.reject(new Error('not used')),
          },
          workAccessRenewal: runWorkAccessFixture(),
          grantExpiresAt: '2026-09-24T18:30:00.000Z',
        }),
    };

    await expect(
      new TaskRunPreparation({
        authority,
        localMandates,
        localHarness: { prepare: () => Promise.reject(new Error('not used')) },
        localRun: { admit: () => Promise.reject(new Error('not used')) },
      }).prepare('INVALID', { kind: 'Retained' }),
    ).resolves.toEqual({
      kind: 'TaskInspectionRejected',
      failure: { kind: 'InputInvalid' },
    });
    expect(prepare).not.toHaveBeenCalled();
  });
});
