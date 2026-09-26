import {
  promotionEvidenceClasses,
  promotionRequiredChecks,
  promotionRequiredMetrics,
  promotionRiskLimit,
  taskEvaluationBudgetCeilings,
} from '@devrandom/domain';
import { prepareTaskCommandV2 } from '@devrandom/protocol';
import {
  agentAid,
  controllerAid,
  credentialRegistryId,
  governorAid,
  personalAgentAid,
  userAid,
} from '@devrandom/identity';
import { describe, expect, it } from 'vitest';

import {
  preparedRepositoryFixture,
  taskProjectionFixture,
  taskSourceFixture,
} from '../../../test/task-source-fixture.js';
import type { LocalGovernanceProfile } from '../domain/local-governance.js';
import {
  preparePromotionMandateIssuance,
  prepareExactPromotionMandateIssuance,
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
  it('binds a post-M exact promotion credential to v2 Task and all locked selection obligations', () => {
    const source = taskSourceFixture();
    const prepared = prepareTaskCommandV2(
      {
        ...source,
        version: 2,
        constraints: {
          ...source.constraints,
          dataPolicy: 'RepositoryAndAuthorizedTaskExperience',
          experience: {
            corpusSaid: 'EAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            repositoryResourceSaid: 'EBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
            disclosure: 'AuthorizedAnalogy',
          },
        },
        requestedCapabilities: [...source.requestedCapabilities, 'ReadTaskMemory'],
        budgets: { ...taskEvaluationBudgetCeilings },
      },
      '97e16745-4b76-4de3-9ae5-a183496e73e8',
      preparedRepositoryFixture,
    );
    if (prepared.kind !== 'Prepared') throw new Error('v2 Task fixture rejected');
    const task = {
      ...taskProjectionFixture(),
      revision: prepared.command.revision,
      revisionSaid: prepared.command.revision.d,
    };
    const evaluationManifestSaid = 'ECCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
    const result = prepareExactPromotionMandateIssuance({
      userAlias: 'devrandom-user',
      governance,
      task,
      issuedAt: Date.parse('2026-09-24T18:15:00.000Z'),
      evaluationManifestSaid,
    });
    expect(result.kind).toBe('Prepared');
    if (result.kind !== 'Prepared') return;
    expect(result.issuance.claims).toMatchObject({
      evaluationManifestSaid,
      requiredMetrics: promotionRequiredMetrics,
      requiredChecks: promotionRequiredChecks,
      riskLimit: promotionRiskLimit,
      experience: task.revision.constraints.experience,
    });
    expect(
      prepareExactPromotionMandateIssuance({
        userAlias: 'devrandom-user',
        governance,
        task: taskProjectionFixture(),
        issuedAt: Date.parse('2026-09-24T18:15:00.000Z'),
        evaluationManifestSaid,
      }),
    ).toEqual({ kind: 'Rejected', reason: 'TaskVersionUnsupported' });
  });
  it('binds PRD03 task memory to the exact corpus and repository in a versioned Task Mandate', () => {
    const source = taskSourceFixture();
    const experience = {
      corpusSaid: 'EAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      repositoryResourceSaid: 'EBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      disclosure: 'AuthorizedAnalogy' as const,
    };
    const prepared = prepareTaskCommandV2(
      {
        ...source,
        version: 2,
        constraints: {
          ...source.constraints,
          dataPolicy: 'RepositoryAndAuthorizedTaskExperience',
          experience,
        },
        requestedCapabilities: [...source.requestedCapabilities, 'ReadTaskMemory'],
        budgets: { ...taskEvaluationBudgetCeilings },
      },
      '97e16745-4b76-4de3-9ae5-a183496e73e8',
      preparedRepositoryFixture,
    );
    expect(prepared.kind).toBe('Prepared');
    if (prepared.kind !== 'Prepared') return;
    const task = {
      ...taskProjectionFixture(),
      revision: prepared.command.revision,
      revisionSaid: prepared.command.revision.d,
    };
    const issuance = prepareTaskMandateIssuance({
      userAlias: 'devrandom-user',
      governance,
      task,
      issuedAt: Date.parse('2026-09-24T18:15:00.000Z'),
    });
    expect(issuance.kind).toBe('Prepared');
    if (issuance.kind !== 'Prepared') return;
    expect(issuance.issuance.claims).toMatchObject({
      taskRevisionSaid: task.revisionSaid,
      allowedCapabilities: ['ReadRepository', 'ReadTaskMemory', 'RunTests', 'SubmitResult'],
      experience,
      budgets: taskEvaluationBudgetCeilings,
    });
    const promotion = preparePromotionMandateIssuance({
      userAlias: 'devrandom-user',
      governance,
      task,
      issuedAt: Date.parse('2026-09-24T18:15:00.000Z'),
    });
    expect(promotion.kind).toBe('Prepared');
    if (promotion.kind !== 'Prepared') return;
    expect(promotion.issuance.claims).toMatchObject({
      taskRevisionSaid: task.revisionSaid,
      capabilityCeiling: ['ReadRepository', 'ReadTaskMemory', 'RunTests', 'SubmitResult'],
      budgetCeiling: taskEvaluationBudgetCeilings,
    });
  });
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
