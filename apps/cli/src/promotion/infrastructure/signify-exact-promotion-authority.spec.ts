import {
  promotionEvidenceClasses,
  promotionRequiredChecks,
  promotionRequiredMetrics,
  promotionRiskLimit,
  taskEvaluationBudgetCeilings,
  type MandateCredentialEvidence,
  type TaskMandateInspection,
  type ExactPromotionMandateInspection,
} from '@devrandom/domain';
import {
  credentialRegistryId,
  governorAid,
  issuerAid,
  personalAgentAid,
  userAid,
  type MandateInspection,
} from '@devrandom/identity';
import {
  prepareTaskCommandV2,
  taskMandateV2SchemaSaid,
  taskMandateV3SchemaSaid,
  taskMandateV4SchemaSaid,
  promotionMandateV3SchemaSaid,
  promotionMandateV5SchemaSaid,
  promotionMandateV7SchemaSaid,
} from '@devrandom/protocol';
import { expect, it, vi } from 'vitest';
import {
  taskProjectionFixture,
  taskSourceFixture,
  preparedRepositoryFixture,
} from '../../../test/task-source-fixture.js';
import type {
  ReadyTaskAuthorization,
  AdmittedMandate,
} from '../../mandate/domain/task-authorization.js';
import { SignifyExactPromotionAuthority } from './signify-exact-promotion-authority.js';
const said = (letter: string) => `E${letter.repeat(43)}`;
const manifestSaid = said('M');
const closureSaid = said('C');
function fixture(quota = 6) {
  const source = taskSourceFixture();
  const prepared = prepareTaskCommandV2(
    {
      ...source,
      version: 2,
      constraints: {
        ...source.constraints,
        dataPolicy: 'RepositoryAndAuthorizedTaskExperience',
        experience: {
          corpusSaid: said('A'),
          repositoryResourceSaid: said('B'),
          disclosure: 'AuthorizedAnalogy',
        },
      },
      requestedCapabilities: [...source.requestedCapabilities, 'ReadTaskMemory'],
      budgets: { ...taskEvaluationBudgetCeilings, runsPerAdmittedUser: quota },
    },
    '97e16745-4b76-4de3-9ae5-a183496e73e8',
    preparedRepositoryFixture,
  );
  if (prepared.kind !== 'Prepared') throw new Error('task');
  const task = {
    ...taskProjectionFixture(),
    revision: prepared.command.revision,
    revisionSaid: prepared.command.revision.d,
  };
  const owner = userAid(task.ownerAid);
  const agent = personalAgentAid('EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz');
  const governor = governorAid('EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk');
  const registry = credentialRegistryId('EBdHrbtS_iH9Oe9IH-3UDsHYNuWpwrtnkDzO5fKrITyK');
  const recorded = {
    preparedAt: 1,
    grantSaid: said('A'),
    submission: { kind: 'RecoveredWithoutOperation' as const },
  };
  const admitted = (kind: AdmittedMandate['kind'], credentialSaid: string): AdmittedMandate => ({
    kind,
    credential: { issuedAt: 1, credentialSaid, issuance: { kind: 'RecoveredWithoutOperation' } },
    holderGrant: recorded,
    holderAdmission: {
      preparedAt: 1,
      admitSaid: said('A'),
      submission: { kind: 'RecoveredWithoutOperation' },
    },
    serverGrant: recorded,
    presentationExpiresAt: '2026-09-24T22:00:00.000Z',
    admittedAt: '2026-09-24T18:00:00.000Z',
    admission: { kind: 'RecoveredWithoutOperation' },
  });
  const authorization: ReadyTaskAuthorization = {
    version: 1,
    revision: 1,
    binding: {
      ownerAid: owner,
      taskId: task.taskId,
      taskRevisionSaid: task.revisionSaid,
      harnessLineageId: task.harnessLineageId,
      personalAgentAid: agent,
      governorAid: governor,
      issuerAid: issuerAid('EHcQUn2xY9KN1yv6FP0c6-pxej14Z8JDD3IYLddg0wOh'),
      mandateRegistryId: registry,
    },
    exactPromotionManifestSaid: manifestSaid,
    stage: {
      kind: 'Ready',
      taskMandate: { ...admitted('TaskMandate', said('A')), kind: 'TaskMandate' },
      promotionMandate: { ...admitted('PromotionMandate', said('B')), kind: 'PromotionMandate' },
    },
  };
  const credential = (
    issueeAid: string,
    credentialSaid: string,
    schemaSaid: string,
  ): MandateCredentialEvidence => ({
    credentialSaid,
    attributeSaid: said('A'),
    issuerAid: owner,
    issueeAid,
    registryId: registry,
    schemaSaid,
    issuedAt: '2026-09-24T18:00:00.000Z',
    credentialSaidBinding: { kind: 'Verified' },
    attributeSaidBinding: { kind: 'Verified' },
    schemaDocument: { kind: 'Resolved', schemaSaid },
    telState: { kind: 'Issued' },
    issuerAnchor: { kind: 'Anchored', eventSaid: said('A') },
  });
  const taskInspection: TaskMandateInspection = {
    credential: credential(
      agent,
      said('A'),
      quota > 8
        ? taskMandateV4SchemaSaid
        : quota > 6
          ? taskMandateV3SchemaSaid
          : taskMandateV2SchemaSaid,
    ),
    authority: 'ExecutePrivateTask',
    taskId: task.taskId,
    taskRevisionSaid: task.revisionSaid,
    harnessLineageId: task.harnessLineageId,
    repository: task.revision.repository,
    allowedCapabilities: task.revision.requestedCapabilities,
    budgets: task.revision.budgets,
    allowedEvolutionClasses: task.revision.evolutionClasses,
    experience: task.revision.constraints.experience,
    notBefore: '2026-09-24T18:00:00.000Z',
    expiresAt: task.revision.expiresAt,
  };
  const promotionInspection: ExactPromotionMandateInspection = {
    credential: credential(
      governor,
      said('B'),
      quota > 8
        ? promotionMandateV7SchemaSaid
        : quota > 6
          ? promotionMandateV5SchemaSaid
          : promotionMandateV3SchemaSaid,
    ),
    authority: 'ActivateEvaluatedSuccessor',
    taskId: task.taskId,
    taskRevisionSaid: task.revisionSaid,
    harnessLineageId: task.harnessLineageId,
    capabilityCeiling: task.revision.requestedCapabilities,
    budgetCeiling: task.revision.budgets,
    evolutionClassCeiling: task.revision.evolutionClasses,
    requiredEvidenceClasses: promotionEvidenceClasses,
    experience: task.revision.constraints.experience,
    notBefore: taskInspection.notBefore,
    expiresAt: task.revision.expiresAt,
    evaluationManifestSaid: manifestSaid,
    requiredMetrics: promotionRequiredMetrics,
    requiredChecks: promotionRequiredChecks,
    riskLimit: promotionRiskLimit,
  };
  const inspectCredential = vi.fn(
    ({ credentialSaid }: { credentialSaid: string }): Promise<MandateInspection> =>
      Promise.resolve(
        credentialSaid === said('A')
          ? { kind: 'TaskMandate', value: taskInspection }
          : { kind: 'PromotionMandate', value: promotionInspection },
      ),
  );
  const input = {
    taskId: task.taskId,
    taskRevisionSaid: task.revisionSaid,
    harnessLineageId: task.harnessLineageId,
    ownerAid: task.ownerAid,
    governorAid: governor,
    evaluationManifestSaid: manifestSaid,
    evaluationClosureSaid: closureSaid,
  };
  const options = {
    task,
    authorization,
    custody: { inspectCredential },
    confirmation: { manifestSaid, closureSaid },
    now: () => '2026-09-24T19:00:00.000Z',
  };
  return { input, options, inspectCredential, promotionInspection };
}
it('verifies current exact user-issued v3 authority and rechecks native TEL on every call', async () => {
  const f = fixture();
  const authority = new SignifyExactPromotionAuthority(f.options);
  expect(await authority.verify(f.input)).toMatchObject({
    kind: 'Current',
    mandate: { evaluationManifestSaid: manifestSaid },
  });
  const original = f.inspectCredential.getMockImplementation();
  if (original === undefined) throw new Error('mock');
  f.inspectCredential.mockImplementation(async (request) => {
    const reply = await original(request);
    return reply.kind === 'PromotionMandate'
      ? {
          kind: 'PromotionMandate',
          value: {
            ...reply.value,
            credential: {
              ...reply.value.credential,
              telState: { kind: 'Revoked', revokedAt: '2026-09-24T18:30:00.000Z' },
            },
          },
        }
      : reply;
  });
  expect(await authority.verify(f.input)).toEqual({ kind: 'Invalid' });
  expect(f.inspectCredential).toHaveBeenCalledTimes(4);
});
it('requires explicit exact M and closure confirmation before accessing custody', async () => {
  const f = fixture();
  const unconfirmed = {
    task: f.options.task,
    authorization: f.options.authorization,
    custody: f.options.custody,
    now: f.options.now,
  };
  expect(await new SignifyExactPromotionAuthority(unconfirmed).verify(f.input)).toEqual({
    kind: 'PendingUserConfirmation',
  });
  expect(
    await new SignifyExactPromotionAuthority(f.options).verify({
      ...f.input,
      evaluationClosureSaid: said('D'),
    }),
  ).toEqual({ kind: 'PendingUserConfirmation' });
  expect(f.inspectCredential).not.toHaveBeenCalled();
});

it('rejects expired authority and a revoked Task Mandate even when exact-M promotion authority remains current', async () => {
  const f = fixture();
  expect(
    await new SignifyExactPromotionAuthority({
      ...f.options,
      now: () => f.options.task.revision.expiresAt,
    }).verify(f.input),
  ).toEqual({ kind: 'Invalid' });
  const inspect = f.inspectCredential.getMockImplementation();
  if (inspect === undefined) throw new Error('credential fixture missing');
  f.inspectCredential.mockImplementation(async (request) => {
    const reply = await inspect(request);
    return reply.kind === 'TaskMandate'
      ? {
          kind: 'TaskMandate',
          value: {
            ...reply.value,
            credential: {
              ...reply.value.credential,
              telState: { kind: 'Revoked', revokedAt: '2026-09-24T18:30:00.000Z' },
            },
          },
        }
      : reply;
  });
  expect(await new SignifyExactPromotionAuthority(f.options).verify(f.input)).toEqual({
    kind: 'Invalid',
  });
  expect(f.inspectCredential).toHaveBeenCalledTimes(4);
});

it.each([6, 8, 9])(
  'accepts exact schema for %s Runs and rejects substituted schema',
  async (quota) => {
    const f = fixture(quota);
    const authority = new SignifyExactPromotionAuthority(f.options);
    expect(await authority.verify(f.input)).toMatchObject({ kind: 'Current' });
    const original = f.inspectCredential.getMockImplementation();
    if (original === undefined) throw new Error('fixture');
    for (const target of ['TaskMandate', 'PromotionMandate']) {
      f.inspectCredential.mockImplementation(async (request) => {
        const reply = await original(request);
        if (reply.kind !== target) return reply;
        const schemaSaid =
          target === 'TaskMandate'
            ? quota > 8
              ? taskMandateV3SchemaSaid
              : quota > 6
                ? taskMandateV2SchemaSaid
                : taskMandateV3SchemaSaid
            : quota > 8
              ? promotionMandateV5SchemaSaid
              : quota > 6
                ? promotionMandateV3SchemaSaid
                : promotionMandateV5SchemaSaid;
        const credential = {
          ...reply.value.credential,
          schemaSaid,
          schemaDocument: { kind: 'Resolved' as const, schemaSaid },
        };
        return reply.kind === 'TaskMandate'
          ? { kind: 'TaskMandate', value: { ...reply.value, credential } }
          : { kind: 'PromotionMandate', value: { ...reply.value, credential } };
      });
      expect(await authority.verify(f.input)).toEqual({ kind: 'Invalid' });
    }
  },
);
