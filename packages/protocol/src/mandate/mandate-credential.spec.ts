import { promotionEvidenceClasses, taskBudgetCeilings } from '@devrandom/domain';
import { Saider } from 'signify-ts';
import { describe, expect, it } from 'vitest';

import {
  decodePromotionMandateCredential,
  decodeTaskMandateCredential,
  promotionMandateSchema,
  promotionMandateSchemaSaid,
  taskMandateSchema,
  taskMandateSchemaSaid,
  verifyMandateSchemaCatalog,
} from './mandate-credential.js';

const ownerAid = `E${'o'.repeat(43)}`;
const agentAid = `E${'a'.repeat(43)}`;
const governorAid = `E${'g'.repeat(43)}`;
const registryId = `E${'r'.repeat(43)}`;
const taskRevisionSaid = `E${'t'.repeat(43)}`;
const taskId = '4df838a8-5109-49fd-bdad-805880a3ecee';
const harnessLineageId = '5ebf49b9-df26-4a49-9194-da868f97cf9d';

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

  it('pins both schema SAIDs to their exact TypeBox document bytes', () => {
    expect(taskMandateSchemaSaid).toBe('EA1IvABDQ7L9XtBkLtJmw4ouzR3ie3a_C6oAKpVPqKyk');
    expect(promotionMandateSchemaSaid).toBe('EHL1THTMidi0ibU-Yuw9mOzUyxg0G5eBwmqJsnbFDp-s');
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
