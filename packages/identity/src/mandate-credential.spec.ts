import {
  promotionEvidenceClasses,
  promotionRequiredChecks,
  promotionRequiredMetrics,
  promotionRiskLimit,
  taskBudgetCeilings,
  taskEvaluationBudgetCeilings,
  type TaskBudgets,
} from '@devrandom/domain';
import {
  promotionMandateSchema,
  promotionMandateV3Schema,
  promotionMandateV2Schema,
  promotionMandateV4Schema,
  promotionMandateV5Schema,
  taskMandateSchema,
  taskMandateSchemaSaid,
  taskMandateV2Schema,
  taskMandateV3Schema,
} from '@devrandom/protocol';
import { Saider } from 'signify-ts';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  inspectPromotionMandateCredentialEvidence,
  inspectExactPromotionMandateCredentialEvidence,
  inspectMandateCredentialEvidence,
  inspectTaskMandateCredentialEvidence,
} from './mandate-credential.js';

const ownerAid = `E${'o'.repeat(43)}`;
const holderAid = `E${'a'.repeat(43)}`;
const registryId = `E${'r'.repeat(43)}`;
const taskRevisionSaid = `E${'t'.repeat(43)}`;
const taskId = '4df838a8-5109-49fd-bdad-805880a3ecee';
const harnessLineageId = '5ebf49b9-df26-4a49-9194-da868f97cf9d';

beforeAll(async () => {
  const { ready } = await import('signify-ts');
  await ready();
});

function saidify<Value extends object & { readonly d: string }>(value: Value): Value {
  const untrusted: unknown = Saider.saidify(value)[1];
  if (
    typeof untrusted !== 'object' ||
    untrusted === null ||
    !('d' in untrusted) ||
    typeof untrusted.d !== 'string'
  ) {
    throw new Error('SAID was not produced');
  }
  if ('v' in value) {
    if (!('v' in untrusted) || typeof untrusted.v !== 'string') {
      throw new Error('versioned SAID did not preserve a version string');
    }
    return { ...value, d: untrusted.d, v: untrusted.v };
  }
  return { ...value, d: untrusted.d };
}

function taskEvidence(
  credentialState?: unknown,
  schema:
    | typeof taskMandateSchema
    | typeof taskMandateV2Schema
    | typeof taskMandateV3Schema = taskMandateSchema,
  budgets: TaskBudgets = { ...taskBudgetCeilings, runsPerAdmittedUser: 6 },
) {
  const attributes = saidify({
    d: '',
    i: holderAid,
    dt: '2026-09-24T14:00:00.000000+00:00',
    authority: 'ExecutePrivateTask',
    taskId,
    taskRevisionSaid,
    harnessLineageId,
    repository: {
      objectFormat: 'sha1',
      commit: '1'.repeat(40),
      tree: '2'.repeat(40),
    },
    allowedCapabilities: ['ReadRepository', 'RunTests', 'SubmitResult'],
    budgets,
    allowedEvolutionClasses: ['C1', 'C2'],
    ...(schema === taskMandateSchema
      ? {}
      : {
          experience: {
            corpusSaid: `E${'q'.repeat(43)}`,
            repositoryResourceSaid: `E${'s'.repeat(43)}`,
            disclosure: 'AuthorizedAnalogy',
          },
        }),
    notBefore: '2026-09-24T14:00:00.000Z',
    expiresAt: '2026-09-24T18:00:00.000Z',
  });
  const credential = saidify({
    v: 'ACDC10JSON000000_',
    d: '',
    i: ownerAid,
    ri: registryId,
    s: schema.$id,
    a: attributes,
  });
  const issuance = saidify({
    v: 'KERI10JSON000000_',
    t: 'iss',
    d: '',
    i: credential.d,
    ri: registryId,
    s: '0',
    dt: attributes.dt,
  });
  const anchor = saidify({
    v: 'KERI10JSON000000_',
    t: 'ixn',
    d: '',
    i: ownerAid,
    s: '1',
    p: ownerAid,
    a: [{ i: credential.d, s: issuance.s, d: issuance.d }],
  });
  return {
    expectedCredentialSaid: credential.d,
    credential: { sad: credential, iss: issuance, anc: anchor },
    credentialState: credentialState ?? { i: credential.d, ri: registryId, s: '0', et: 'iss' },
    issuerKeyEvents: [{ ked: anchor }],
    resolvedSchema: schema,
  };
}

describe('Task Mandate cryptographic inspection', () => {
  it.each([
    [taskMandateSchema, 6],
    [taskMandateV2Schema, 6],
    [taskMandateV3Schema, 8],
  ] as const)('accepts immutable schema with $1 runs (case %#)', (schema, runs) => {
    const budgets = { ...taskEvaluationBudgetCeilings, runsPerAdmittedUser: runs };
    // V1 predates evaluation budgets as well as experience claims.
    const acceptedBudgets =
      schema === taskMandateSchema ? { ...taskBudgetCeilings, runsPerAdmittedUser: runs } : budgets;
    const evidence = taskEvidence(undefined, schema, acceptedBudgets);
    expect(inspectMandateCredentialEvidence(evidence)).toMatchObject({
      kind: 'TaskMandate',
      value: { budgets: acceptedBudgets, credential: { schemaSaid: schema.$id } },
    });
    expect(() =>
      inspectTaskMandateCredentialEvidence({
        ...evidence,
        resolvedSchema: promotionMandateV5Schema,
      }),
    ).toThrow('resolved mandate schema differs');
  });

  it.each([
    [taskMandateV2Schema, { ...taskEvaluationBudgetCeilings, runsPerAdmittedUser: 8 }],
    [taskMandateV3Schema, { ...taskEvaluationBudgetCeilings, runsPerAdmittedUser: 9 }],
    [
      taskMandateV3Schema,
      {
        ...taskEvaluationBudgetCeilings,
        runsPerAdmittedUser: 8,
        providerSpendMicroUsd: taskEvaluationBudgetCeilings.providerSpendMicroUsd + 1,
      },
    ],
    [
      taskMandateV3Schema,
      {
        ...taskEvaluationBudgetCeilings,
        runsPerAdmittedUser: 8,
        providerInputTokens: taskEvaluationBudgetCeilings.providerInputTokens + 1,
      },
    ],
  ] as const)('rejects claims exceeding the exact schema budget', (schema, budgets) => {
    expect(() =>
      inspectTaskMandateCredentialEvidence(taskEvidence(undefined, schema, budgets)),
    ).toThrow('Task Mandate decoding failed');
  });

  it('returns exact decoded claims and independently verified credential facts', () => {
    const evidence = taskEvidence();

    expect(inspectTaskMandateCredentialEvidence(evidence)).toEqual({
      credential: {
        credentialSaid: evidence.expectedCredentialSaid,
        attributeSaid: evidence.credential.sad.a.d,
        issuerAid: ownerAid,
        issueeAid: holderAid,
        registryId,
        schemaSaid: taskMandateSchemaSaid,
        issuedAt: '2026-09-24T14:00:00.000000+00:00',
        credentialSaidBinding: { kind: 'Verified' },
        attributeSaidBinding: { kind: 'Verified' },
        schemaDocument: { kind: 'Resolved', schemaSaid: taskMandateSchemaSaid },
        telState: { kind: 'Issued' },
        issuerAnchor: { kind: 'Anchored', eventSaid: evidence.credential.anc.d },
      },
      authority: 'ExecutePrivateTask',
      taskId,
      taskRevisionSaid,
      harnessLineageId,
      repository: {
        objectFormat: 'sha1',
        commit: '1'.repeat(40),
        tree: '2'.repeat(40),
      },
      allowedCapabilities: ['ReadRepository', 'RunTests', 'SubmitResult'],
      budgets: { ...taskBudgetCeilings, runsPerAdmittedUser: 6 },
      allowedEvolutionClasses: ['C1', 'C2'],
      notBefore: '2026-09-24T14:00:00.000Z',
      expiresAt: '2026-09-24T18:00:00.000Z',
    });
  });

  it('represents revocation as a closed TEL fact', () => {
    const evidence = taskEvidence();
    expect(
      inspectTaskMandateCredentialEvidence({
        ...evidence,
        credentialState: {
          i: evidence.expectedCredentialSaid,
          ri: registryId,
          s: '1',
          et: 'rev',
          dt: '2026-09-24T16:30:00.000000+00:00',
        },
      }).credential.telState,
    ).toEqual({ kind: 'Revoked', revokedAt: '2026-09-24T16:30:00.000000+00:00' });
  });

  it('fails an unknown TEL event closed as incompatible state', () => {
    const evidence = taskEvidence();
    expect(
      inspectTaskMandateCredentialEvidence({
        ...evidence,
        credentialState: {
          i: evidence.expectedCredentialSaid,
          ri: registryId,
          s: '2',
          et: 'future-event',
        },
      }).credential.telState,
    ).toEqual({ kind: 'IncompatibleCredentialState' });
  });

  it('reports an absent issuer KEL anchor as a closed cryptographic fact', () => {
    const evidence = taskEvidence();
    expect(
      inspectTaskMandateCredentialEvidence({
        ...evidence,
        issuerKeyEvents: [],
      }).credential.issuerAnchor,
    ).toEqual({ kind: 'Missing' });
  });

  it.each([
    [
      'resolved schema',
      (evidence: ReturnType<typeof taskEvidence>) => ({
        ...evidence,
        resolvedSchema: { ...taskMandateSchema, title: 'Substituted schema' },
      }),
    ],
    [
      'credential identity',
      (evidence: ReturnType<typeof taskEvidence>) => ({
        ...evidence,
        expectedCredentialSaid: `E${'x'.repeat(43)}`,
      }),
    ],
  ])('rejects invalid %s evidence', (_label, change) => {
    expect(() => inspectTaskMandateCredentialEvidence(change(taskEvidence()))).toThrow(
      'Mandate credential evidence is invalid',
    );
  });
});

describe('Promotion Mandate cryptographic inspection', () => {
  it.each([
    [promotionMandateV3Schema, 6],
    [promotionMandateV5Schema, 8],
  ] as const)(
    'reads exact-M claims from immutable schema with $1 runs (case %#)',
    (schema, runs) => {
      const attributes = saidify({
        d: '',
        i: holderAid,
        dt: '2026-09-24T14:05:00.000000+00:00',
        authority: 'ActivateEvaluatedSuccessor',
        taskId,
        taskRevisionSaid,
        harnessLineageId,
        capabilityCeiling: ['ReadRepository', 'ReadTaskMemory', 'RunTests', 'SubmitResult'],
        budgetCeiling: { ...taskEvaluationBudgetCeilings, runsPerAdmittedUser: runs },
        evolutionClassCeiling: ['C1', 'C2'],
        requiredEvidenceClasses: [...promotionEvidenceClasses],
        experience: {
          corpusSaid: `E${'q'.repeat(43)}`,
          repositoryResourceSaid: `E${'s'.repeat(43)}`,
          disclosure: 'AuthorizedAnalogy',
        },
        evaluationManifestSaid: `E${'m'.repeat(43)}`,
        requiredMetrics: [...promotionRequiredMetrics],
        requiredChecks: [...promotionRequiredChecks],
        riskLimit: { ...promotionRiskLimit },
        notBefore: '2026-09-24T14:00:00.000Z',
        expiresAt: '2026-09-24T18:00:00.000Z',
      });
      const credential = saidify({
        v: 'ACDC10JSON000000_',
        d: '',
        i: ownerAid,
        ri: registryId,
        s: schema.$id,
        a: attributes,
      });
      const issuance = saidify({
        v: 'KERI10JSON000000_',
        t: 'iss',
        d: '',
        i: credential.d,
        ri: registryId,
        s: '0',
        dt: attributes.dt,
      });
      const anchor = saidify({
        v: 'KERI10JSON000000_',
        t: 'ixn',
        d: '',
        i: ownerAid,
        s: '2',
        p: ownerAid,
        a: [{ i: credential.d, s: issuance.s, d: issuance.d }],
      });
      const sources = {
        expectedCredentialSaid: credential.d,
        credential: { sad: credential, iss: issuance, anc: anchor },
        credentialState: { i: credential.d, ri: registryId, s: '0', et: 'iss' },
        issuerKeyEvents: [{ ked: anchor }],
        resolvedSchema: schema,
      };
      expect(inspectExactPromotionMandateCredentialEvidence(sources)).toMatchObject({
        evaluationManifestSaid: attributes.evaluationManifestSaid,
        requiredMetrics: promotionRequiredMetrics,
        requiredChecks: promotionRequiredChecks,
        riskLimit: promotionRiskLimit,
        credential: {
          schemaSaid: schema.$id,
          telState: { kind: 'Issued' },
          issuerAnchor: { kind: 'Anchored' },
        },
      });
      expect(inspectMandateCredentialEvidence(sources).kind).toBe('PromotionMandate');
      expect(() =>
        inspectExactPromotionMandateCredentialEvidence({
          ...sources,
          credential: {
            ...sources.credential,
            sad: {
              ...credential,
              a: { ...attributes, evaluationManifestSaid: `E${'x'.repeat(43)}` },
            },
          },
        }),
      ).toThrow('exact Promotion Mandate v3 decoding failed');
      expect(() =>
        inspectExactPromotionMandateCredentialEvidence({
          ...sources,
          resolvedSchema: { ...schema, title: 'Substituted' },
        }),
      ).toThrow('resolved mandate schema');
    },
  );
  it.each([
    [promotionMandateSchema, 6],
    [promotionMandateV2Schema, 6],
    [promotionMandateV4Schema, 8],
  ] as const)(
    'decodes the pre-M authority ceiling for immutable schema with $1 runs (case %#)',
    (schema, runs) => {
      const attributes = saidify({
        d: '',
        i: holderAid,
        dt: '2026-09-24T14:05:00.000000+00:00',
        authority: 'ActivateEvaluatedSuccessor',
        taskId,
        taskRevisionSaid,
        harnessLineageId,
        capabilityCeiling: ['ReadRepository', 'RunTests', 'SubmitResult'],
        budgetCeiling: {
          ...(schema === promotionMandateSchema
            ? taskBudgetCeilings
            : taskEvaluationBudgetCeilings),
          runsPerAdmittedUser: runs,
        },
        evolutionClassCeiling: ['C1', 'C2'],
        requiredEvidenceClasses: [...promotionEvidenceClasses],
        ...(schema === promotionMandateSchema
          ? {}
          : {
              experience: {
                corpusSaid: `E${'q'.repeat(43)}`,
                repositoryResourceSaid: `E${'s'.repeat(43)}`,
                disclosure: 'AuthorizedAnalogy',
              },
            }),
        notBefore: '2026-09-24T14:00:00.000Z',
        expiresAt: '2026-09-24T18:00:00.000Z',
      });
      const credential = saidify({
        v: 'ACDC10JSON000000_',
        d: '',
        i: ownerAid,
        ri: registryId,
        s: schema.$id,
        a: attributes,
      });
      const issuance = saidify({
        v: 'KERI10JSON000000_',
        t: 'iss',
        d: '',
        i: credential.d,
        ri: registryId,
        s: '0',
        dt: attributes.dt,
      });
      const anchor = saidify({
        v: 'KERI10JSON000000_',
        t: 'ixn',
        d: '',
        i: ownerAid,
        s: '2',
        p: ownerAid,
        a: [{ i: credential.d, s: issuance.s, d: issuance.d }],
      });

      const inspection = inspectPromotionMandateCredentialEvidence({
        expectedCredentialSaid: credential.d,
        credential: { sad: credential, iss: issuance, anc: anchor },
        credentialState: { i: credential.d, ri: registryId, s: '0', et: 'iss' },
        issuerKeyEvents: [{ ked: anchor }],
        resolvedSchema: schema,
      });

      expect(inspection).toMatchObject({
        authority: 'ActivateEvaluatedSuccessor',
        taskId,
        taskRevisionSaid,
        harnessLineageId,
        capabilityCeiling: ['ReadRepository', 'RunTests', 'SubmitResult'],
        budgetCeiling: attributes.budgetCeiling,
        evolutionClassCeiling: ['C1', 'C2'],
        requiredEvidenceClasses: promotionEvidenceClasses,
        credential: {
          issuerAid: ownerAid,
          issueeAid: holderAid,
          schemaSaid: schema.$id,
          telState: { kind: 'Issued' },
          issuerAnchor: { kind: 'Anchored', eventSaid: anchor.d },
        },
      });
    },
  );
});
