import { readFileSync } from 'node:fs';
import {
  promotionEvidenceClasses,
  promotionRequiredChecks,
  promotionRequiredMetrics,
  promotionRiskLimit,
  taskBudgetCeilings,
  taskEvaluationBudgetCeilings,
  taskRecoveryBudgetCeilings,
} from '@devrandom/domain';
import { Saider } from 'signify-ts';
import { describe, expect, it } from 'vitest';

import {
  decodePromotionMandateCredential,
  decodePromotionMandateCredentialV2,
  decodePromotionMandateCredentialV3,
  decodeTaskMandateCredential,
  decodeTaskMandateCredentialV2,
  promotionMandateSchema,
  promotionMandateSchemaSaid,
  promotionMandateV2Schema,
  promotionMandateV2SchemaSaid,
  promotionMandateV3Schema,
  promotionMandateV3SchemaSaid,
  taskMandateSchema,
  taskMandateSchemaSaid,
  taskMandateV2Schema,
  taskMandateV2SchemaSaid,
  taskMandateV3Schema,
  taskMandateV3SchemaSaid,
  promotionMandateV4Schema,
  promotionMandateV4SchemaSaid,
  promotionMandateV5Schema,
  promotionMandateV5SchemaSaid,
  verifyMandateSchemaCatalog,
  taskMandateV4Schema,
  taskMandateV4SchemaSaid,
  promotionMandateV6Schema,
  promotionMandateV6SchemaSaid,
  promotionMandateV7Schema,
  promotionMandateV7SchemaSaid,
  taskMandateV5Schema,
  taskMandateV5SchemaSaid,
  promotionMandateV8Schema,
  promotionMandateV8SchemaSaid,
  promotionMandateV9Schema,
  promotionMandateV9SchemaSaid,
  promotionMandateV10Schema,
  promotionMandateV10SchemaSaid,
  promotionMandateV11Schema,
  promotionMandateV11SchemaSaid,
  taskMandateV6Schema,
  taskMandateV6SchemaSaid,
} from './mandate-credential.js';

const ownerAid = `E${'o'.repeat(43)}`;
const agentAid = `E${'a'.repeat(43)}`;
const governorAid = `E${'g'.repeat(43)}`;
const registryId = `E${'r'.repeat(43)}`;
const taskRevisionSaid = `E${'t'.repeat(43)}`;
const taskId = '4df838a8-5109-49fd-bdad-805880a3ecee';
const harnessLineageId = '5ebf49b9-df26-4a49-9194-da868f97cf9d';
const budgetsForRuns = (runs: number) => ({
  ...(runs === 16 ? taskRecoveryBudgetCeilings : taskEvaluationBudgetCeilings),
  ...(runs === 10 ? { tasksPerAdmittedUser: 5 } : {}),
  runsPerAdmittedUser: runs,
});

function saidify(value: object): unknown {
  return Saider.saidify(value)[1];
}

function taskCredential(): unknown {
  const attributes = saidify({
    d: '',
    i: agentAid,
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
    budgets: taskBudgetCeilings,
    allowedEvolutionClasses: ['C1', 'C2'],
    notBefore: '2026-09-24T14:00:00.000Z',
    expiresAt: '2026-09-24T18:00:00.000Z',
  });
  return saidify({
    v: 'ACDC10JSON000000_',
    d: '',
    i: ownerAid,
    ri: registryId,
    s: taskMandateSchemaSaid,
    a: attributes,
  });
}

function promotionCredential(): unknown {
  const attributes = saidify({
    d: '',
    i: governorAid,
    dt: '2026-09-24T14:00:00.000000+00:00',
    authority: 'ActivateEvaluatedSuccessor',
    taskId,
    taskRevisionSaid,
    harnessLineageId,
    capabilityCeiling: ['ReadRepository', 'RunTests', 'SubmitResult'],
    budgetCeiling: taskBudgetCeilings,
    evolutionClassCeiling: ['C1', 'C2'],
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
    notBefore: '2026-09-24T14:00:00.000Z',
    expiresAt: '2026-09-24T18:00:00.000Z',
  });
  return saidify({
    v: 'ACDC10JSON000000_',
    d: '',
    i: ownerAid,
    ri: registryId,
    s: promotionMandateSchemaSaid,
    a: attributes,
  });
}

describe('Mandate credential schemas', () => {
  it.each([
    ['task-mandate-v3', taskMandateV3Schema],
    ['promotion-mandate-v4', promotionMandateV4Schema],
    ['promotion-mandate-v5', promotionMandateV5Schema],
    ['task-mandate-v5', taskMandateV5Schema],
    ['promotion-mandate-v8', promotionMandateV8Schema],
    ['promotion-mandate-v9', promotionMandateV9Schema],
  ] as const)('preserves historical eight-Run schema bytes: %s', (name, schema) => {
    const stored: unknown = JSON.parse(
      readFileSync(new URL(`../../../../schemas/devrandom-${name}.json`, import.meta.url), 'utf8'),
    );
    expect(JSON.stringify(schema)).toBe(JSON.stringify(stored));
  });

  it.each([
    [promotionMandateV3Schema, promotionMandateV3SchemaSaid, 6],
    [promotionMandateV5Schema, promotionMandateV5SchemaSaid, 8],
    [promotionMandateV7Schema, promotionMandateV7SchemaSaid, 9],
    [promotionMandateV9Schema, promotionMandateV9SchemaSaid, 10],
    [promotionMandateV11Schema, promotionMandateV11SchemaSaid, 16],
  ] as const)(
    'accepts exact-M credentials with ordered E4 claims quota%s',
    (schema, schemaSaid, runs) => {
      const legacy = decodePromotionMandateCredential(promotionCredential());
      if (legacy.kind !== 'Accepted') throw new Error('legacy fixture rejected');
      const { notBefore, expiresAt, ...base } = legacy.credential.a;
      const exact = {
        evaluationManifestSaid: `E${'m'.repeat(43)}`,
        requiredMetrics: [...promotionRequiredMetrics],
        requiredChecks: [...promotionRequiredChecks],
        riskLimit: { ...promotionRiskLimit },
      };
      const attributes = saidify({
        ...base,
        d: '',
        capabilityCeiling: ['ReadRepository', 'ReadTaskMemory', 'RunTests', 'SubmitResult'],
        budgetCeiling: budgetsForRuns(runs),
        experience: {
          corpusSaid: `E${'q'.repeat(43)}`,
          repositoryResourceSaid: `E${'s'.repeat(43)}`,
          disclosure: 'AuthorizedAnalogy',
        },
        ...exact,
        notBefore,
        expiresAt,
      });
      const credential = saidify({
        ...legacy.credential,
        d: '',
        s: schemaSaid,
        a: attributes,
      });
      if (runs === 8)
        expect(
          decodePromotionMandateCredentialV3(
            saidify({ ...(credential as object), d: '', s: promotionMandateV3SchemaSaid }),
          ).kind,
        ).toBe('Rejected');
      if (runs === 9) {
        expect(
          decodePromotionMandateCredentialV3(
            saidify({ ...(credential as object), d: '', s: promotionMandateV5SchemaSaid }),
          ).kind,
        ).toBe('Rejected');
        const excessive = saidify({
          ...(attributes as object),
          d: '',
          budgetCeiling: { ...taskEvaluationBudgetCeilings, runsPerAdmittedUser: 10 },
        });
        expect(
          decodePromotionMandateCredentialV3(
            saidify({ ...(credential as object), d: '', a: excessive }),
          ).kind,
        ).toBe('Rejected');
      }
      expect(decodePromotionMandateCredentialV3(credential)).toEqual({
        kind: 'Accepted',
        credential,
      });
      if (runs === 8)
        expect(
          decodePromotionMandateCredentialV2(
            saidify({ ...(credential as object), d: '', s: promotionMandateV2SchemaSaid }),
          ).kind,
        ).toBe('Rejected');
      if (runs === 9) {
        expect(
          decodePromotionMandateCredentialV2(
            saidify({ ...(credential as object), d: '', s: promotionMandateV4SchemaSaid }),
          ).kind,
        ).toBe('Rejected');
        const excessive = saidify({
          ...(attributes as object),
          d: '',
          budgetCeiling: { ...taskEvaluationBudgetCeilings, runsPerAdmittedUser: 10 },
        });
        expect(
          decodePromotionMandateCredentialV2(
            saidify({ ...(credential as object), d: '', a: excessive }),
          ).kind,
        ).toBe('Rejected');
      }
      expect(decodePromotionMandateCredentialV2(credential).kind).toBe('Rejected');
      expect(schema.$id).toBe(schemaSaid);
      expect(new Saider({ qb64: schemaSaid }).verify(schema, true, false, undefined, '$id')).toBe(
        true,
      );
      const swapped = saidify({
        ...(attributes as object),
        d: '',
        requiredMetrics: [...promotionRequiredMetrics].reverse(),
      });
      const changed = saidify({ ...(credential as object), d: '', a: swapped });
      expect(decodePromotionMandateCredentialV3(changed).kind).toBe('Rejected');
    },
  );
  it.each([
    [promotionMandateV2Schema, promotionMandateV2SchemaSaid, 6],
    [promotionMandateV4Schema, promotionMandateV4SchemaSaid, 8],
    [promotionMandateV6Schema, promotionMandateV6SchemaSaid, 9],
    [promotionMandateV8Schema, promotionMandateV8SchemaSaid, 10],
    [promotionMandateV10Schema, promotionMandateV10SchemaSaid, 16],
  ] as const)(
    'accepts versioned Promotion Mandate experience and budget attributes quota%s',
    (schema, schemaSaid, runs) => {
      const decoded = decodePromotionMandateCredential(promotionCredential());
      expect(decoded.kind).toBe('Accepted');
      if (decoded.kind !== 'Accepted') return;
      const legacy = decoded.credential;
      const experience = {
        corpusSaid: `E${'q'.repeat(43)}`,
        repositoryResourceSaid: `E${'s'.repeat(43)}`,
        disclosure: 'AuthorizedAnalogy',
      };
      const { notBefore, expiresAt, ...legacyAttributes } = legacy.a;
      const attributes = saidify({
        ...legacyAttributes,
        d: '',
        capabilityCeiling: ['ReadRepository', 'ReadTaskMemory', 'RunTests', 'SubmitResult'],
        budgetCeiling: budgetsForRuns(runs),
        experience,
        notBefore,
        expiresAt,
      });
      const credential = saidify({
        ...legacy,
        d: '',
        s: schemaSaid,
        a: attributes,
      });
      expect(decodePromotionMandateCredentialV2(credential).kind).toBe('Accepted');
      expect(decodePromotionMandateCredential(credential).kind).toBe('Rejected');
      expect(schema.$id).toBe(schemaSaid);
    },
  );
  it.each([
    [taskMandateV2Schema, taskMandateV2SchemaSaid, 6],
    [taskMandateV3Schema, taskMandateV3SchemaSaid, 8],
    [taskMandateV4Schema, taskMandateV4SchemaSaid, 9],
    [taskMandateV5Schema, taskMandateV5SchemaSaid, 10],
    [taskMandateV6Schema, taskMandateV6SchemaSaid, 16],
  ] as const)(
    'pins a versioned mandate to the exact Task experience corpus and finite budget quota%s',
    (schema, schemaSaid, runs) => {
      const experience = {
        corpusSaid: `E${'c'.repeat(43)}`,
        repositoryResourceSaid: `E${'s'.repeat(43)}`,
        disclosure: 'AuthorizedAnalogy',
      };
      const attributes = saidify({
        d: '',
        i: agentAid,
        dt: '2026-09-24T14:00:00.000000+00:00',
        authority: 'ExecutePrivateTask',
        taskId,
        taskRevisionSaid,
        harnessLineageId,
        repository: { objectFormat: 'sha1', commit: '1'.repeat(40), tree: '2'.repeat(40) },
        allowedCapabilities: ['ReadRepository', 'ReadTaskMemory', 'RunTests', 'SubmitResult'],
        budgets: budgetsForRuns(runs),
        allowedEvolutionClasses: ['C1', 'C2'],
        experience,
        notBefore: '2026-09-24T14:00:00.000Z',
        expiresAt: '2026-09-24T18:00:00.000Z',
      });
      const credential = saidify({
        v: 'ACDC10JSON000000_',
        d: '',
        i: ownerAid,
        ri: registryId,
        s: schemaSaid,
        a: attributes,
      });
      expect(schemaSaid).not.toBe(taskMandateSchemaSaid);
      expect(new Saider({ qb64: schemaSaid }).verify(schema, true, false, undefined, '$id')).toBe(
        true,
      );
      if (runs === 8)
        expect(
          decodeTaskMandateCredentialV2(
            saidify({ ...(credential as object), d: '', s: taskMandateV2SchemaSaid }),
          ).kind,
        ).toBe('Rejected');
      if (runs === 9) {
        expect(
          decodeTaskMandateCredentialV2(
            saidify({ ...(credential as object), d: '', s: taskMandateV3SchemaSaid }),
          ).kind,
        ).toBe('Rejected');
        const excessive = saidify({
          ...(attributes as object),
          d: '',
          budgets: { ...taskEvaluationBudgetCeilings, runsPerAdmittedUser: 10 },
        });
        expect(
          decodeTaskMandateCredentialV2(saidify({ ...(credential as object), d: '', a: excessive }))
            .kind,
        ).toBe('Rejected');
      }
      expect(decodeTaskMandateCredentialV2(credential)).toEqual({ kind: 'Accepted', credential });
      expect(decodeTaskMandateCredential(credential)).toEqual({
        kind: 'Rejected',
        reason: 'SchemaInvalid',
      });
    },
  );
  it('verifies the compiled schema catalog without exposing Signify to its caller', () => {
    expect(verifyMandateSchemaCatalog()).toEqual({ kind: 'Verified' });
  });

  it('fails closed and identifies a compiled schema whose bytes drift', () => {
    Reflect.set(taskMandateSchema, 'description', 'drifted schema bytes');
    try {
      expect(verifyMandateSchemaCatalog()).toEqual({
        kind: 'Mismatch',
        schema: 'TaskMandate',
        expectedSaid: taskMandateSchemaSaid,
      });
    } finally {
      Reflect.set(
        taskMandateSchema,
        'description',
        'User-issued authority for one personal agent and exact Task Revision',
      );
    }
  });

  it('fails closed when the v3 exact-M schema bytes drift', () => {
    Reflect.set(promotionMandateV3Schema, 'description', 'drifted exact-M schema');
    try {
      expect(verifyMandateSchemaCatalog()).toEqual({
        kind: 'Mismatch',
        schema: 'PromotionMandateV3',
        expectedSaid: promotionMandateV3SchemaSaid,
      });
    } finally {
      Reflect.set(
        promotionMandateV3Schema,
        'description',
        'User-confirmed exact E4 authority for one Governor, Task Revision and evaluation manifest',
      );
    }
  });

  it('pins both schema SAIDs to their exact TypeBox document bytes', () => {
    expect(taskMandateSchemaSaid).toBe('EA1IvABDQ7L9XtBkLtJmw4ouzR3ie3a_C6oAKpVPqKyk');
    expect(taskMandateV2SchemaSaid).toBe('EOY8HBroEjfQNrCcePMlfVbP-nb1n4cEphePUB4X_KCZ');
    expect(promotionMandateSchemaSaid).toBe('EHL1THTMidi0ibU-Yuw9mOzUyxg0G5eBwmqJsnbFDp-s');
    expect(promotionMandateV2SchemaSaid).toBe('EKJIBacKPWlMuJFCmmcq4rHZWUnMEBc8PicQRFOCMvkD');
    expect(promotionMandateV3SchemaSaid).toBe('EAQCbiVS9-JfwXwYHEgNCOryzg9Aq1ft1m98u_5TP742');
    expect(
      new Saider({ qb64: taskMandateSchemaSaid }).verify(
        taskMandateSchema,
        true,
        false,
        undefined,
        '$id',
      ),
    ).toBe(true);
    expect(
      new Saider({ qb64: promotionMandateSchemaSaid }).verify(
        promotionMandateSchema,
        true,
        false,
        undefined,
        '$id',
      ),
    ).toBe(true);
  });

  it('retains the exact schema and Task Mandate attribute field order', () => {
    expect(Object.keys(taskMandateSchema)).toEqual([
      'type',
      'required',
      'properties',
      '$id',
      '$schema',
      'title',
      'description',
      'credentialType',
      'version',
      'additionalProperties',
    ]);
    expect(taskMandateSchema.required).toEqual(['v', 'd', 'i', 'ri', 's', 'a']);
    expect(Object.keys(taskMandateSchema.properties.a.properties)).toEqual([
      'd',
      'i',
      'dt',
      'authority',
      'taskId',
      'taskRevisionSaid',
      'harnessLineageId',
      'repository',
      'allowedCapabilities',
      'budgets',
      'allowedEvolutionClasses',
      'notBefore',
      'expiresAt',
    ]);
    expect(Reflect.get(taskMandateSchema, '$schema')).toBe(
      'https://json-schema.org/draft/2020-12/schema',
    );
    expect(taskMandateSchema.$id).toBe(taskMandateSchemaSaid);
  });

  it('retains the exact Promotion Mandate attribute field order', () => {
    expect(promotionMandateSchema.required).toEqual(['v', 'd', 'i', 'ri', 's', 'a']);
    expect(Object.keys(promotionMandateSchema.properties.a.properties)).toEqual([
      'd',
      'i',
      'dt',
      'authority',
      'taskId',
      'taskRevisionSaid',
      'harnessLineageId',
      'capabilityCeiling',
      'budgetCeiling',
      'evolutionClassCeiling',
      'requiredEvidenceClasses',
      'notBefore',
      'expiresAt',
    ]);
    expect(Reflect.get(promotionMandateSchema, '$schema')).toBe(
      'https://json-schema.org/draft/2020-12/schema',
    );
    expect(promotionMandateSchema.$id).toBe(promotionMandateSchemaSaid);
    const requiredEvidence = promotionMandateSchema.properties.a.properties.requiredEvidenceClasses;
    expect(Array.isArray(requiredEvidence.items)).toBe(false);
    expect(requiredEvidence).toMatchObject({
      type: 'array',
      minItems: promotionEvidenceClasses.length,
      maxItems: promotionEvidenceClasses.length,
      uniqueItems: true,
    });
  });

  it('accepts only self-addressed credentials for the exact mandate schema', () => {
    const task = taskCredential();
    const promotion = promotionCredential();

    expect(decodeTaskMandateCredential(task)).toEqual({ kind: 'Accepted', credential: task });
    expect(decodePromotionMandateCredential(promotion)).toEqual({
      kind: 'Accepted',
      credential: promotion,
    });
    expect(taskMandateSchema).toBeDefined();
    expect(promotionMandateSchema).toBeDefined();
  });

  it('distinguishes noncanonical claims, attribute tampering, and credential tampering', () => {
    const task = taskCredential();
    if (typeof task !== 'object' || task === null || !('a' in task)) {
      throw new Error('Task Mandate fixture is malformed');
    }
    const attributes = task.a;
    if (
      typeof attributes !== 'object' ||
      attributes === null ||
      !('allowedCapabilities' in attributes) ||
      !Array.isArray(attributes.allowedCapabilities)
    ) {
      throw new Error('Task Mandate attributes fixture is malformed');
    }

    expect(
      decodeTaskMandateCredential({
        ...task,
        a: {
          ...attributes,
          allowedCapabilities: attributes.allowedCapabilities
            .map((capability: unknown) => capability)
            .reverse(),
        },
      }),
    ).toEqual({ kind: 'Rejected', reason: 'NonCanonical' });
    expect(
      decodeTaskMandateCredential({
        ...task,
        a: { ...attributes, expiresAt: '2026-09-24T17:00:00.000Z' },
      }),
    ).toEqual({ kind: 'Rejected', reason: 'AttributeSaidMismatch' });
    expect(decodeTaskMandateCredential({ ...task, ri: `E${'x'.repeat(43)}` })).toEqual({
      kind: 'Rejected',
      reason: 'CredentialSaidMismatch',
    });
  });

  it('requires the canonical Promotion evidence-class order after schema validation', () => {
    const promotion = promotionCredential();
    if (typeof promotion !== 'object' || promotion === null || !('a' in promotion)) {
      throw new Error('Promotion Mandate fixture is malformed');
    }
    const attributes = promotion.a;
    if (
      typeof attributes !== 'object' ||
      attributes === null ||
      !('requiredEvidenceClasses' in attributes) ||
      !Array.isArray(attributes.requiredEvidenceClasses)
    ) {
      throw new Error('Promotion Mandate attributes fixture is malformed');
    }
    expect(
      decodePromotionMandateCredential({
        ...promotion,
        a: {
          ...attributes,
          requiredEvidenceClasses: attributes.requiredEvidenceClasses
            .map((evidenceClass: unknown) => evidenceClass)
            .reverse(),
        },
      }),
    ).toEqual({ kind: 'Rejected', reason: 'NonCanonical' });
  });
});
