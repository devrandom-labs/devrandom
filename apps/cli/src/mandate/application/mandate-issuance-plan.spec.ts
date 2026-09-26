import { promotionEvidenceClasses } from '@devrandom/domain';
import {
  agentAid,
  controllerAid,
  credentialRegistryId,
  governorAid,
  personalAgentAid,
  userAid,
} from '@devrandom/identity';
import { describe, expect, it } from 'vitest';

import { taskProjectionFixture } from '../../../test/task-source-fixture.js';
import type { LocalGovernanceProfile } from '../domain/local-governance.js';
import {
  preparePromotionMandateIssuance,
  prepareTaskMandateIssuance,
} from './mandate-issuance-plan.js';

const owner = userAid('EMstL6Th90iB6MpQkPjKN2ii7a5XcvA_PCHWHrAAD-l4');
const personalAgent = personalAgentAid('EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz');
const governor = governorAid('EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk');
const registry = credentialRegistryId('EBdHrbtS_iH9Oe9IH-3UDsHYNuWpwrtnkDzO5fKrITyK');

const governance = {
  version: 1,
  revision: 0,
  userAid: owner,
  controllerAid: controllerAid('EOb-FtVoyOOKTAf9GVdIlmfiSL53StlAY8vobkPRdmt4'),
  keriaAgentAid: agentAid('EJlw5Fw9LKH1CYFEkGiDUlx0cHozvXb7hfqhSoMsH6bs'),
  personalAgentAid: personalAgent,
  governorAid: governor,
  mandateRegistryId: registry,
} satisfies LocalGovernanceProfile;

describe('mandate issuance planning', () => {
  it('binds the exact authoritative Task and excludes unavailable capabilities', () => {
    const task = taskProjectionFixture();
    const issuedAt = Date.parse('2026-09-24T18:15:00.000Z');

    expect(
      prepareTaskMandateIssuance({
        userAlias: 'devrandom-user',
        governance,
        task,
        issuedAt,
      }),
    ).toEqual({
      kind: 'Prepared',
      issuance: {
        kind: 'TaskMandate',
        userAlias: 'devrandom-user',
        userAid: owner,
        holderAid: personalAgent,
        registryId: registry,
        issuedAt,
        claims: {
          authority: 'ExecutePrivateTask',
          taskId: task.taskId,
          taskRevisionSaid: task.revisionSaid,
          harnessLineageId: task.harnessLineageId,
          repository: task.revision.repository,
          allowedCapabilities: ['ReadRepository', 'RunTests', 'SubmitResult'],
          budgets: task.revision.budgets,
          allowedEvolutionClasses: ['C1'],
          notBefore: '2026-09-24T18:15:00.000Z',
          expiresAt: '2026-09-24T22:00:00.000Z',
        },
      },
    });
  });

  it('caps each mandate at four hours and makes the Promotion ceiling exact', () => {
    const task = taskProjectionFixture();
    const issuedAt = Date.parse('2026-09-24T17:00:00.000Z');

    const promotion = preparePromotionMandateIssuance({
      userAlias: 'devrandom-user',
      governance,
      task,
      issuedAt,
    });

    expect(promotion).toEqual({
      kind: 'Prepared',
      issuance: {
        kind: 'PromotionMandate',
        userAlias: 'devrandom-user',
        userAid: owner,
        holderAid: governor,
        registryId: registry,
        issuedAt,
        claims: {
          authority: 'ActivateEvaluatedSuccessor',
          taskId: task.taskId,
          taskRevisionSaid: task.revisionSaid,
          harnessLineageId: task.harnessLineageId,
          capabilityCeiling: ['ReadRepository', 'RunTests', 'SubmitResult'],
          budgetCeiling: task.revision.budgets,
          evolutionClassCeiling: ['C1'],
          requiredEvidenceClasses: promotionEvidenceClasses,
          notBefore: '2026-09-24T17:00:00.000Z',
          expiresAt: '2026-09-24T21:00:00.000Z',
        },
      },
    });
  });

  it('rejects changed ownership, invalid issuance time, and elapsed deadlines', () => {
    const task = taskProjectionFixture();
    const issuedAt = Date.parse('2026-09-24T18:15:00.000Z');

    expect(
      prepareTaskMandateIssuance({
        userAlias: 'devrandom-user',
        governance,
        task: { ...task, ownerAid: governor },
        issuedAt,
      }),
    ).toEqual({ kind: 'Rejected', reason: 'OwnerMismatch' });
    expect(
      prepareTaskMandateIssuance({
        userAlias: 'devrandom-user',
        governance,
        task,
        issuedAt: Number.NaN,
      }),
    ).toEqual({ kind: 'Rejected', reason: 'IssuanceTimeInvalid' });
    expect(
      prepareTaskMandateIssuance({
        userAlias: 'devrandom-user',
        governance,
        task,
        issuedAt: Date.parse(task.revision.expiresAt),
      }),
    ).toEqual({ kind: 'Rejected', reason: 'TaskDeadlineElapsed' });
  });
});
