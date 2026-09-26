import { promotionEvidenceClasses, type MandateCredentialEvidence } from '@devrandom/domain';
import {
  GOVERNOR_ALIAS,
  PERSONAL_AGENT_ALIAS,
  agentAid,
  controllerAid,
  credentialRegistryId,
  credentialSaid,
  governorAid,
  ipexGrantSaid,
  issuerAid,
  personalAgentAid,
  userAid,
  type LocalMandateCustody,
  type MandateInspection,
  type MandateGrantReconciliation,
  type MandateGrantSubmission,
  type StableMandateGrant,
  type StableMandateIssuance,
} from '@devrandom/identity';
import {
  prepareTaskCommandV2,
  promotionMandateSchemaSaid,
  promotionMandateV2SchemaSaid,
  promotionMandateV3SchemaSaid,
  taskMandateSchemaSaid,
  taskMandateV2SchemaSaid,
} from '@devrandom/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
  preparedRepositoryFixture,
  taskProjectionFixture,
  taskSourceFixture,
} from '../../../test/task-source-fixture.js';
import type { LocalGovernanceProfile } from '../domain/local-governance.js';
import type { TaskAuthorization } from '../domain/task-authorization.js';
import type { HostedMandatePresentations } from './hosted-mandate-presentations.js';
import {
  TaskMandateAuthorization,
  type TaskAuthorizationRecords,
} from './task-mandate-authorization.js';

const owner = userAid('EMstL6Th90iB6MpQkPjKN2ii7a5XcvA_PCHWHrAAD-l4');
const server = issuerAid('EHcQUn2xY9KN1yv6FP0c6-pxej14Z8JDD3IYLddg0wOh');
const personalAgent = personalAgentAid('EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz');
const governor = governorAid('EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk');
const registry = credentialRegistryId('EBdHrbtS_iH9Oe9IH-3UDsHYNuWpwrtnkDzO5fKrITyK');
const taskCredential = credentialSaid('EAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
const promotionCredential = credentialSaid('EBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB');
const exactPromotionCredential = credentialSaid(`E${'A'.repeat(42)}H`);
const grantSaids = [
  ipexGrantSaid('ECCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC'),
  ipexGrantSaid('EDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD'),
  ipexGrantSaid('EFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF'),
  ipexGrantSaid('EGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG'),
  ipexGrantSaid(`E${'A'.repeat(42)}I`),
  ipexGrantSaid(`E${'A'.repeat(42)}J`),
] as const;
const issuedAt = Date.parse('2026-09-24T18:15:00.000Z');
const grantExpiresAt = '2026-09-24T21:00:00.000Z';

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

function evidence(
  issuance: StableMandateIssuance,
  said: string,
  schemaSaid: string,
): MandateCredentialEvidence {
  return {
    credentialSaid: said,
    attributeSaid: said,
    issuerAid: issuance.userAid,
    issueeAid: issuance.holderAid,
    registryId: issuance.registryId,
    schemaSaid,
    issuedAt: new Date(issuance.issuedAt).toISOString().replace('Z', '000+00:00'),
    credentialSaidBinding: { kind: 'Verified' },
    attributeSaidBinding: { kind: 'Verified' },
    schemaDocument: { kind: 'Resolved', schemaSaid },
    telState: { kind: 'Issued' },
    issuerAnchor: { kind: 'Anchored', eventSaid: said },
  };
}

function inspection(issuance: StableMandateIssuance, said: string): MandateInspection {
  switch (issuance.kind) {
    case 'TaskMandate':
      return {
        kind: 'TaskMandate',
        value: {
          credential: evidence(
            issuance,
            said,
            'experience' in issuance.claims ? taskMandateV2SchemaSaid : taskMandateSchemaSaid,
          ),
          ...issuance.claims,
        },
      };
    case 'PromotionMandate':
      return {
        kind: 'PromotionMandate',
        value: {
          credential: evidence(
            issuance,
            said,
            'evaluationManifestSaid' in issuance.claims
              ? promotionMandateV3SchemaSaid
              : 'experience' in issuance.claims
                ? promotionMandateV2SchemaSaid
                : promotionMandateSchemaSaid,
          ),
          ...issuance.claims,
        },
      };
  }
}

class MemoryTaskAuthorizationRecords implements TaskAuthorizationRecords {
  current: TaskAuthorization | undefined;
  readonly committedStages: string[] = [];

  read(): Promise<TaskAuthorization | undefined> {
    return Promise.resolve(this.current);
  }

  commit(previousRevision: number | undefined, authorization: TaskAuthorization): Promise<void> {
    if (this.current?.revision !== previousRevision) {
      return Promise.reject(new Error('test CAS conflict'));
    }
    this.current = authorization;
    this.committedStages.push(
      authorization.stage.kind === 'Ready'
        ? 'Ready'
        : `${authorization.stage.kind}.${authorization.stage.progress.kind}`,
    );
    return Promise.resolve();
  }
}

function custodyFixture() {
  const issuances = new Map<string, StableMandateIssuance>();
  const submittedIssuances: StableMandateIssuance[] = [];
  const submittedGrants: StableMandateGrant[] = [];
  let grantIndex = 0;
  let holdFirstObservation = true;

  function saidFor(issuance: StableMandateIssuance) {
    return issuance.kind === 'TaskMandate'
      ? taskCredential
      : 'evaluationManifestSaid' in issuance.claims
        ? exactPromotionCredential
        : promotionCredential;
  }

  function foundInspection(said: string): MandateInspection {
    const issuance = issuances.get(said);
    if (issuance === undefined) {
      throw new Error(`missing test issuance ${said}`);
    }
    return inspection(issuance, said);
  }

  const custody: LocalMandateCustody = {
    controllerAid: governance.controllerAid,
    agentAid: governance.keriaAgentAid,
    prepareSchemas: () => Promise.resolve(),
    provisionRegistry: () => Promise.reject(new Error('not used by this capability')),
    reconcileIssuance: () => Promise.resolve({ kind: 'NotFound' }),
    submitIssuance: vi.fn((issuance: StableMandateIssuance) => {
      const said = saidFor(issuance);
      issuances.set(said, issuance);
      submittedIssuances.push(issuance);
      return Promise.resolve({
        credentialSaid: said,
        operationName: `issue-${issuance.kind}`,
      });
    }),
    observeIssuance: (observation) => {
      if (observation.credentialSaid === taskCredential && holdFirstObservation) {
        return Promise.resolve({ kind: 'Pending' });
      }
      return Promise.resolve({
        kind: 'Completed',
        inspection: foundInspection(observation.credentialSaid),
      });
    },
    inspectCredential: ({ credentialSaid: said }) => Promise.resolve(foundInspection(said)),
    prepareGrant: vi.fn(() => {
      const said = grantSaids[grantIndex];
      grantIndex += 1;
      if (said === undefined) {
        return Promise.reject(new Error('unexpected additional grant'));
      }
      return Promise.resolve({ grantSaid: said });
    }),
    reconcileGrant: () => Promise.resolve({ kind: 'NotFound' }),
    submitGrant: vi.fn((grant: MandateGrantSubmission): Promise<MandateGrantReconciliation> => {
      submittedGrants.push(grant);
      return Promise.resolve({
        kind: 'Submitted',
        grantSaid: grant.grantSaid,
        operationName: `grant-${String(submittedGrants.length)}`,
      });
    }),
    observeGrant: (grant) => Promise.resolve({ kind: 'Completed', grantSaid: grant.grantSaid }),
    beginHolderAdmission: (admission) =>
      Promise.resolve({
        kind: 'Started',
        admitSaid:
          admission.mandateKind === 'TaskMandate'
            ? taskMandateSchemaSaid
            : promotionMandateSchemaSaid,
        operationName: `admit-${admission.mandateKind}`,
      }),
    observeHolderAdmission: (admission) =>
      Promise.resolve({
        kind: 'Verified',
        inspection: foundInspection(admission.credentialSaid),
      }),
  };

  return {
    custody,
    submittedIssuances,
    submittedGrants,
    releaseFirstObservation: () => {
      holdFirstObservation = false;
    },
  };
}

function presentationsFixture(): HostedMandatePresentations {
  const calls = new Map<'TaskMandate' | 'PromotionMandate', number>();
  return {
    present: (credential, command) => {
      const call = (calls.get(command.mandateKind) ?? 0) + 1;
      calls.set(command.mandateKind, call);
      const binding = {
        version: 1 as const,
        mandateKind: command.mandateKind,
        credentialSaid: credential,
        grantSaid: command.grantSaid,
        presentationExpiresAt: grantExpiresAt,
      };
      return call === 1
        ? Promise.resolve({
            kind: 'Pending',
            presentation: {
              ...binding,
              kind: 'Admitting',
              operationName: `server-admit-${command.mandateKind}`,
            },
          })
        : Promise.resolve({
            kind: 'Admitted',
            presentation: {
              ...binding,
              kind: 'Admitted',
              admittedAt: '2026-09-24T18:15:30.000Z',
            },
          });
    },
  };
}

describe('Task mandate authorization', () => {
  it('issues and confirms a separate exact-M v3 Promotion Mandate after the v2 Task authority', async () => {
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
    const fixture = custodyFixture();
    fixture.releaseFirstObservation();
    const initialRecords = new MemoryTaskAuthorizationRecords();
    const initialInput = {
      userAlias: 'devrandom-user',
      task,
      governance,
      issuerAid: server,
      workAccessExpiresAt: grantExpiresAt,
    };
    const initial = await new TaskMandateAuthorization({
      records: initialRecords,
      custody: fixture.custody,
      presentations: presentationsFixture(),
      now: () => issuedAt,
      wait: () => Promise.resolve(),
      maximumObservations: 20,
    }).authorize(initialInput);
    expect(initial.kind).toBe('Ready');
    if (initial.kind !== 'Ready') return;
    const exactRecords = new MemoryTaskAuthorizationRecords();
    const manifestSaid = 'ECCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
    const exactInput = {
      ...initialInput,
      exactPromotionManifestSaid: manifestSaid,
      initialReadyAuthorization: initial.authorization,
    };
    const exact = new TaskMandateAuthorization({
      records: exactRecords,
      custody: fixture.custody,
      presentations: presentationsFixture(),
      now: () => issuedAt,
      wait: () => Promise.resolve(),
      maximumObservations: 20,
    });
    const result = await exact.authorize(exactInput);
    expect(result.kind).toBe('Ready');
    if (result.kind !== 'Ready') return;
    expect(result.authorization.stage.promotionMandate.credential.credentialSaid).toBe(
      exactPromotionCredential,
    );
    expect(fixture.submittedIssuances).toHaveLength(3);
    expect(fixture.submittedIssuances[2]).toMatchObject({
      kind: 'PromotionMandate',
      claims: { evaluationManifestSaid: manifestSaid },
    });
    expect(fixture.submittedGrants).toHaveLength(6);
    await expect(exact.authorize(exactInput)).resolves.toMatchObject({ kind: 'Ready' });
    expect(fixture.submittedIssuances).toHaveLength(3);
    await expect(
      exact.authorize({
        ...exactInput,
        exactPromotionManifestSaid: 'EDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD',
      }),
    ).resolves.toMatchObject({ kind: 'MandateInvalid' });
  });
  it('checkpoints every stable protocol identity and resumes without duplicate authority', async () => {
    const records = new MemoryTaskAuthorizationRecords();
    const fixture = custodyFixture();
    const presentations = presentationsFixture();
    const authorize = new TaskMandateAuthorization({
      records,
      custody: fixture.custody,
      presentations,
      now: () => issuedAt,
      wait: () => Promise.resolve(),
      maximumObservations: 1,
    });
    const input = {
      userAlias: 'devrandom-user',
      task: taskProjectionFixture(),
      governance,
      issuerAid: server,
      workAccessExpiresAt: grantExpiresAt,
    };

    await expect(authorize.authorize(input)).resolves.toEqual({
      kind: 'PollingLimitReached',
      stage: 'TaskMandate.IssuanceSubmitted',
    });
    expect(records.current?.stage).toMatchObject({
      kind: 'TaskMandate',
      progress: {
        kind: 'IssuanceSubmitted',
        credentialSaid: taskCredential,
        operationName: 'issue-TaskMandate',
      },
    });

    fixture.releaseFirstObservation();
    const resumed = await new TaskMandateAuthorization({
      records,
      custody: fixture.custody,
      presentations,
      now: () => issuedAt,
      wait: () => Promise.resolve(),
      maximumObservations: 20,
    }).authorize(input);

    expect(resumed).toEqual({ kind: 'Ready', authorization: records.current });
    expect(records.current?.stage.kind).toBe('Ready');
    expect(fixture.submittedIssuances.map(({ kind }) => kind)).toEqual([
      'TaskMandate',
      'PromotionMandate',
    ]);
    expect(fixture.submittedGrants).toHaveLength(4);
    expect(fixture.submittedGrants.map(({ senderAlias }) => senderAlias)).toEqual([
      'devrandom-user',
      PERSONAL_AGENT_ALIAS,
      'devrandom-user',
      GOVERNOR_ALIAS,
    ]);
    expect(records.committedStages).toContain('TaskMandate.ServerAdmitted');
    expect(records.committedStages.at(-1)).toBe('Ready');
    expect(records.current?.stage).toMatchObject({
      kind: 'Ready',
      promotionMandate: {
        admittedAt: '2026-09-24T18:15:30.000Z',
        admission: {
          kind: 'OperationRecorded',
          operationName: 'server-admit-PromotionMandate',
        },
      },
    });
    expect(promotionEvidenceClasses).toEqual([
      'Diagnosis',
      'FalsifiableHypothesis',
      'ImmutableCandidate',
      'RepeatedPairedEvaluation',
      'LockedHoldout',
      'SafetyAndAuthorityFloors',
      'TamperAudit',
      'WinnerSelection',
    ]);
  });
});
