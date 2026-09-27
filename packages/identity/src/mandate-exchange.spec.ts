import {
  promotionEvidenceClasses,
  promotionRequiredChecks,
  promotionRequiredMetrics,
  promotionRiskLimit,
  taskBudgetCeilings,
  taskEvaluationBudgetCeilings,
} from '@devrandom/domain';
import {
  promotionMandateSchemaSaid,
  promotionMandateV3SchemaSaid,
  promotionMandateV5SchemaSaid,
  promotionMandateV7SchemaSaid,
  taskMandateV3SchemaSaid,
  taskMandateV4SchemaSaid,
  taskMandateSchema,
  taskMandateV2Schema,
  taskMandateV3Schema,
  taskMandateV4Schema,
  promotionMandateSchema,
  promotionMandateV2Schema,
  promotionMandateV3Schema,
  promotionMandateV4Schema,
  promotionMandateV6Schema,
  promotionMandateV5Schema,
  promotionMandateV7Schema,
  taskMandateSchemaSaid,
} from '@devrandom/protocol';
import { Saider, SignifyClient, Tier, ready } from 'signify-ts';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import * as signifyController from './signify-controller.js';

import {
  connectLocalMandateCustody,
  type StableMandateIssuance,
  convergeHolderAdmissionEvidence,
  decodeMandateOperation,
  mandateProtocolDatetime,
  observeMandateOperation,
  observeMandateIssuanceOperation,
  promotionMandateSchemaOobi,
  reconcileHolderAdmissionEvidence,
  reconcileMandateIssuanceEvidence,
  reconcileMandateOperationEvidence,
  taskMandateSchemaOobi,
} from './mandate-exchange.js';
import {
  agentAid,
  controllerAid,
  credentialRegistryId,
  governorAid,
  personalAgentAid,
  userAid,
} from './keri-identifier.js';

beforeAll(ready);
afterEach(() => vi.restoreAllMocks());

describe('mandate operation evidence', () => {
  it('decodes the exact operation name and exchange identity', () => {
    expect(
      decodeMandateOperation(
        { name: 'exchange.EGrant', done: false, metadata: { said: 'EGrant' } },
        'EGrant',
      ),
    ).toEqual({ operationName: 'exchange.EGrant' });
  });

  it.each([
    { name: '', done: false, metadata: { said: 'EGrant' } },
    { name: 'exchange.EGrant', done: false },
    { name: 'exchange.EGrant', done: false, metadata: { said: 'EOther' } },
  ])('rejects an inconsistent operation response', (response) => {
    expect(() => decodeMandateOperation(response, 'EGrant')).toThrow(
      'mandate exchange operation response',
    );
  });

  it('keeps a not-done operation pending for request-driven retry', () => {
    expect(
      observeMandateOperation(
        { name: 'exchange.EGrant', done: false, metadata: { said: 'EGrant' } },
        'exchange.EGrant',
        'EGrant',
      ),
    ).toEqual({ kind: 'Pending' });
  });

  it('observes issuance by the exact persisted operation name and credential SAID', () => {
    expect(
      observeMandateIssuanceOperation(
        {
          name: 'credential.ECredential',
          done: false,
          metadata: { ced: { d: 'ECredential' } },
        },
        'credential.ECredential',
        'ECredential',
      ),
    ).toEqual({ kind: 'Pending' });
    expect(
      observeMandateIssuanceOperation(
        {
          name: 'credential.ECredential',
          done: true,
          metadata: { ced: { d: 'ECredential' } },
        },
        'credential.ECredential',
        'ECredential',
      ),
    ).toEqual({ kind: 'Completed' });
  });

  it.each([
    [
      'issuance',
      () =>
        observeMandateIssuanceOperation(
          {
            name: 'credential.ECredential',
            done: true,
            metadata: { ced: { d: 'ECredential' } },
            error: { code: 409, message: 'credential rejected' },
          },
          'credential.ECredential',
          'ECredential',
        ),
    ],
    [
      'grant',
      () =>
        observeMandateOperation(
          {
            name: 'exchange.EGrant',
            done: true,
            metadata: { said: 'EGrant' },
            error: { code: 403, message: 'grant rejected' },
          },
          'exchange.EGrant',
          'EGrant',
        ),
    ],
  ])('returns a closed Failed outcome for an errored %s operation', (_label, observe) => {
    expect(observe()).toEqual(
      _label === 'issuance'
        ? { kind: 'Failed', status: 409, reason: 'credential rejected' }
        : { kind: 'Failed', status: 403, reason: 'grant rejected' },
    );
  });

  it('rejects issuance operation identity mismatches instead of observing another operation', () => {
    expect(() =>
      observeMandateIssuanceOperation(
        {
          name: 'credential.EOther',
          done: true,
          metadata: { ced: { d: 'EOther' } },
        },
        'credential.ECredential',
        'ECredential',
      ),
    ).toThrow('mandate issuance operation observation');
  });

  it('accepts completion only for the exact durable operation and exchange', () => {
    expect(
      observeMandateOperation(
        { name: 'exchange.EGrant', done: true, metadata: { said: 'EGrant' } },
        'exchange.EGrant',
        'EGrant',
      ),
    ).toEqual({ kind: 'Completed' });
    expect(() =>
      observeMandateOperation(
        { name: 'exchange.EOther', done: true, metadata: { said: 'EOther' } },
        'exchange.EGrant',
        'EGrant',
      ),
    ).toThrow('mandate exchange operation observation');
  });

  it('derives the same protocol timestamp from a persisted preparation instant', () => {
    const preparedAt = Date.parse('2026-09-24T16:45:00.000Z');
    expect(mandateProtocolDatetime(preparedAt)).toBe('2026-09-24T16:45:00.000000+00:00');
    expect(mandateProtocolDatetime(preparedAt)).toBe(mandateProtocolDatetime(preparedAt));
  });

  it('reconciles a lost submission response to its exact operation without resubmitting', () => {
    expect(
      reconcileMandateOperationEvidence(
        [
          { name: 'exchange.decoy', metadata: { said: 'EDecoy' } },
          { name: 'exchange.admit', metadata: { said: 'EAdmit' } },
        ],
        'EAdmit',
      ),
    ).toEqual({ kind: 'Submitted', operationName: 'exchange.admit' });
  });

  it('keeps an existing admit observable when its operation is gone and materialization is pending', () => {
    expect(reconcileHolderAdmissionEvidence([], 'EAdmit', { kind: 'Pending' })).toEqual({
      kind: 'AwaitingMaterialization',
      admitSaid: 'EAdmit',
    });
  });
});

describe('local mandate schema OOBIs', () => {
  it('admits only explicit HTTP OOBIs for each exact mandate schema SAID', () => {
    expect(taskMandateSchemaOobi(`http://issuer.test/oobi/${taskMandateSchemaSaid}`)).toEqual({
      kind: 'TaskMandateSchemaOobi',
      url: `http://issuer.test/oobi/${taskMandateSchemaSaid}`,
    });
    expect(
      promotionMandateSchemaOobi(`https://issuer.test/oobi/${promotionMandateSchemaSaid}`),
    ).toEqual({
      kind: 'PromotionMandateSchemaOobi',
      url: `https://issuer.test/oobi/${promotionMandateSchemaSaid}`,
    });
  });

  it.each([
    ['cross-bound Task schema', `http://issuer.test/oobi/${promotionMandateSchemaSaid}`],
    ['cross-bound Promotion schema', `http://issuer.test/oobi/${taskMandateSchemaSaid}`],
    ['query-bearing schema URL', `http://issuer.test/oobi/${taskMandateSchemaSaid}?said=other`],
  ])('rejects a %s', (kind, value) => {
    const decode = kind.includes('Promotion') ? promotionMandateSchemaOobi : taskMandateSchemaOobi;
    expect(() => decode(value)).toThrow('mandate schema OOBI');
  });
});

describe('mandate issuance reconciliation', () => {
  const owner = userAid('EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz');
  const holder = personalAgentAid('EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk');
  const registry = credentialRegistryId('EBfdlu8R27Fbx-ehrqwImnK-8Cm79sqbAQ4MmvEAYqao');
  const input = {
    kind: 'TaskMandate' as const,
    userAlias: 'devrandom-user',
    userAid: owner,
    holderAid: holder,
    registryId: registry,
    issuedAt: Date.parse('2026-09-24T14:00:00.000Z'),
    claims: {
      authority: 'ExecutePrivateTask' as const,
      taskId: '4df838a8-5109-49fd-bdad-805880a3ecee',
      taskRevisionSaid: `E${'t'.repeat(43)}`,
      harnessLineageId: '5ebf49b9-df26-4a49-9194-da868f97cf9d',
      repository: {
        objectFormat: 'sha1' as const,
        commit: '1'.repeat(40),
        tree: '2'.repeat(40),
      },
      allowedCapabilities: ['ReadRepository', 'RunTests', 'SubmitResult'] as const,
      budgets: { ...taskBudgetCeilings, runsPerAdmittedUser: 6 },
      allowedEvolutionClasses: ['C1', 'C2'] as const,
      notBefore: '2026-09-24T14:00:00.000Z',
      expiresAt: '2026-09-24T18:00:00.000Z',
    },
  };
  const inspection = {
    kind: 'TaskMandate' as const,
    value: {
      credential: {
        credentialSaid: `E${'c'.repeat(43)}`,
        attributeSaid: `E${'a'.repeat(43)}`,
        issuerAid: owner,
        issueeAid: holder,
        registryId: registry,
        schemaSaid: taskMandateSchemaSaid,
        issuedAt: '2026-09-24T14:00:00.000000+00:00',
        credentialSaidBinding: { kind: 'Verified' as const },
        attributeSaidBinding: { kind: 'Verified' as const },
        schemaDocument: { kind: 'Resolved' as const, schemaSaid: taskMandateSchemaSaid },
        telState: { kind: 'Issued' as const },
        issuerAnchor: { kind: 'Anchored' as const, eventSaid: `E${'e'.repeat(43)}` },
      },
      authority: 'ExecutePrivateTask' as const,
      taskId: input.claims.taskId,
      taskRevisionSaid: input.claims.taskRevisionSaid,
      harnessLineageId: input.claims.harnessLineageId,
      repository: input.claims.repository,
      allowedCapabilities: input.claims.allowedCapabilities,
      budgets: input.claims.budgets,
      allowedEvolutionClasses: input.claims.allowedEvolutionClasses,
      notBefore: input.claims.notBefore,
      expiresAt: input.claims.expiresAt,
    },
  };

  it('retains an exact holder-admit operation until it completes', () => {
    expect(
      reconcileHolderAdmissionEvidence(
        [{ name: 'exchange.stale', metadata: { said: 'EAdmit' } }],
        'EAdmit',
        { kind: 'Verified', inspection },
      ),
    ).toEqual({
      kind: 'Started',
      admitSaid: 'EAdmit',
      operationName: 'exchange.stale',
    });
  });

  it('does not infer holder admission from shared-agent credential visibility', () => {
    expect(
      convergeHolderAdmissionEvidence(
        { kind: 'Completed' },
        { kind: 'Pending' },
        { kind: 'Verified', inspection },
      ),
    ).toEqual({ kind: 'Pending' });
    expect(
      convergeHolderAdmissionEvidence(
        { kind: 'Pending' },
        { kind: 'Verified' },
        { kind: 'Verified', inspection },
      ),
    ).toEqual({ kind: 'Pending' });
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

  function credential() {
    const attributes = saidify({
      d: '',
      i: holder,
      dt: '2026-09-24T14:00:00.000000+00:00',
      ...input.claims,
    });
    return saidify({
      v: 'ACDC10JSON000000_',
      d: '',
      i: owner,
      ri: registry,
      s: taskMandateSchemaSaid,
      a: attributes,
    });
  }

  it.each([
    [promotionMandateV3SchemaSaid, 6],
    [promotionMandateV5SchemaSaid, 8],
    [promotionMandateV7SchemaSaid, 9],
  ] as const)('reconciles only exact M under schema %s with %i runs', (schemaSaid, runs) => {
    const governor = governorAid(holder);
    const exact = {
      kind: 'PromotionMandate' as const,
      userAlias: input.userAlias,
      userAid: owner,
      holderAid: governor,
      registryId: registry,
      issuedAt: input.issuedAt,
      claims: {
        authority: 'ActivateEvaluatedSuccessor' as const,
        taskId: input.claims.taskId,
        taskRevisionSaid: input.claims.taskRevisionSaid,
        harnessLineageId: input.claims.harnessLineageId,
        capabilityCeiling: [
          'ReadRepository',
          'ReadTaskMemory',
          'RunTests',
          'SubmitResult',
        ] as const,
        budgetCeiling: { ...taskEvaluationBudgetCeilings, runsPerAdmittedUser: runs },
        evolutionClassCeiling: ['C1', 'C2'] as const,
        requiredEvidenceClasses: promotionEvidenceClasses,
        experience: {
          corpusSaid: `E${'q'.repeat(43)}`,
          repositoryResourceSaid: `E${'s'.repeat(43)}`,
          disclosure: 'AuthorizedAnalogy' as const,
        },
        evaluationManifestSaid: `E${'m'.repeat(43)}`,
        requiredMetrics: promotionRequiredMetrics,
        requiredChecks: promotionRequiredChecks,
        riskLimit: promotionRiskLimit,
        notBefore: input.claims.notBefore,
        expiresAt: input.claims.expiresAt,
      },
    };
    const attributes = saidify({
      d: '',
      i: governor,
      dt: mandateProtocolDatetime(exact.issuedAt),
      authority: exact.claims.authority,
      taskId: exact.claims.taskId,
      taskRevisionSaid: exact.claims.taskRevisionSaid,
      harnessLineageId: exact.claims.harnessLineageId,
      capabilityCeiling: [...exact.claims.capabilityCeiling],
      budgetCeiling: exact.claims.budgetCeiling,
      evolutionClassCeiling: [...exact.claims.evolutionClassCeiling],
      requiredEvidenceClasses: [...exact.claims.requiredEvidenceClasses],
      experience: exact.claims.experience,
      evaluationManifestSaid: exact.claims.evaluationManifestSaid,
      requiredMetrics: [...exact.claims.requiredMetrics],
      requiredChecks: [...exact.claims.requiredChecks],
      riskLimit: { ...exact.claims.riskLimit },
      notBefore: exact.claims.notBefore,
      expiresAt: exact.claims.expiresAt,
    });
    const mandate = saidify({
      v: 'ACDC10JSON000000_',
      d: '',
      i: owner,
      ri: registry,
      s: schemaSaid,
      a: attributes,
    });
    const record = { sad: mandate, iss: { d: 'issuance' }, anc: { d: 'anchor' }, ancatc: [] };
    expect(reconcileMandateIssuanceEvidence([record], [], exact)).toEqual({
      kind: 'Materialized',
      credentialSaid: mandate.d,
    });
    expect(
      reconcileMandateIssuanceEvidence([record], [], {
        ...exact,
        claims: { ...exact.claims, evaluationManifestSaid: `E${'x'.repeat(43)}` },
      }),
    ).toEqual({ kind: 'NotFound' });
    const partial = structuredClone(exact);
    Reflect.deleteProperty(partial.claims, 'requiredChecks');
    expect(() => reconcileMandateIssuanceEvidence([record], [], partial)).toThrow(
      'exact Promotion Mandate claims',
    );
  });

  it('reconciles a fresh eight-run Task credential only against its exact new schema and claims', () => {
    const fresh = {
      ...input,
      claims: {
        ...input.claims,
        budgets: { ...taskEvaluationBudgetCeilings, runsPerAdmittedUser: 8 },
        experience: {
          corpusSaid: `E${'q'.repeat(43)}`,
          repositoryResourceSaid: `E${'s'.repeat(43)}`,
          disclosure: 'AuthorizedAnalogy' as const,
        },
      },
    };
    const { notBefore, expiresAt, ...claims } = fresh.claims;
    const attributes = saidify({
      d: '',
      i: holder,
      dt: mandateProtocolDatetime(input.issuedAt),
      ...claims,
      notBefore,
      expiresAt,
    });
    const mandate = saidify({ ...credential(), d: '', s: taskMandateV3SchemaSaid, a: attributes });
    const record = { sad: mandate, iss: { d: 'issuance' }, anc: { d: 'anchor' }, ancatc: [] };
    expect(reconcileMandateIssuanceEvidence([record], [], fresh)).toEqual({
      kind: 'Materialized',
      credentialSaid: mandate.d,
    });
    expect(reconcileMandateIssuanceEvidence([record], [], input)).toEqual({ kind: 'NotFound' });
    expect(
      reconcileMandateIssuanceEvidence([record], [], {
        ...fresh,
        claims: {
          ...fresh.claims,
          budgets: { ...fresh.claims.budgets, runsPerAdmittedUser: 6 },
        },
      }),
    ).toEqual({ kind: 'NotFound' });
    expect(
      reconcileMandateIssuanceEvidence(
        [{ ...record, sad: saidify({ ...mandate, d: '', s: taskMandateSchemaSaid }) }],
        [],
        fresh,
      ),
    ).toEqual({ kind: 'NotFound' });
  });

  it('reconciles a fresh nine-run Task credential only against its exact new schema and claims', () => {
    const fresh = {
      ...input,
      claims: {
        ...input.claims,
        budgets: { ...taskEvaluationBudgetCeilings, runsPerAdmittedUser: 9 },
        experience: {
          corpusSaid: `E${'q'.repeat(43)}`,
          repositoryResourceSaid: `E${'s'.repeat(43)}`,
          disclosure: 'AuthorizedAnalogy' as const,
        },
      },
    };
    const { notBefore, expiresAt, ...claims } = fresh.claims;
    const attributes = saidify({
      d: '',
      i: holder,
      dt: mandateProtocolDatetime(input.issuedAt),
      ...claims,
      notBefore,
      expiresAt,
    });
    const mandate = saidify({ ...credential(), d: '', s: taskMandateV4SchemaSaid, a: attributes });
    const record = { sad: mandate, iss: { d: 'issuance' }, anc: { d: 'anchor' }, ancatc: [] };
    expect(reconcileMandateIssuanceEvidence([record], [], fresh)).toEqual({
      kind: 'Materialized',
      credentialSaid: mandate.d,
    });
    expect(reconcileMandateIssuanceEvidence([record], [], input)).toEqual({ kind: 'NotFound' });
    expect(
      reconcileMandateIssuanceEvidence([record], [], {
        ...fresh,
        claims: {
          ...fresh.claims,
          budgets: { ...fresh.claims.budgets, runsPerAdmittedUser: 6 },
        },
      }),
    ).toEqual({ kind: 'NotFound' });
    expect(
      reconcileMandateIssuanceEvidence(
        [{ ...record, sad: saidify({ ...mandate, d: '', s: taskMandateSchemaSaid }) }],
        [],
        fresh,
      ),
    ).toEqual({ kind: 'NotFound' });
  });

  it.each([
    ['TaskMandate', 6, false, false, taskMandateSchema],
    ['TaskMandate', 6, true, false, taskMandateV2Schema],
    ['TaskMandate', 8, true, false, taskMandateV3Schema],
    ['TaskMandate', 9, true, false, taskMandateV4Schema],
    ['PromotionMandate', 6, false, false, promotionMandateSchema],
    ['PromotionMandate', 6, true, false, promotionMandateV2Schema],
    ['PromotionMandate', 8, true, false, promotionMandateV4Schema],
    ['PromotionMandate', 9, true, false, promotionMandateV6Schema],
    ['PromotionMandate', 6, true, true, promotionMandateV3Schema],
    ['PromotionMandate', 8, true, true, promotionMandateV5Schema],
    ['PromotionMandate', 9, true, true, promotionMandateV7Schema],
  ] as const)(
    'resolves and submits %s with %i runs (experience %s, exact M %s)',
    async (kind, runs, experience, exact, expectedSchema) => {
      const client = new SignifyClient('http://keria.invalid', '0123456789abcdefghijk', Tier.low);
      const controller = controllerAid(owner);
      const agent = agentAid(holder);
      vi.spyOn(signifyController, 'connectSignifyController').mockResolvedValue({
        client,
        controllerAid: controller,
        agentAid: agent,
        connection: 'existing-controller-connected',
      });
      const available = new Set<string>();
      const documents = [
        taskMandateSchema,
        taskMandateV2Schema,
        taskMandateV3Schema,
        taskMandateV4Schema,
        promotionMandateSchema,
        promotionMandateV2Schema,
        promotionMandateV3Schema,
        promotionMandateV4Schema,
        promotionMandateV6Schema,
        promotionMandateV5Schema,
        promotionMandateV7Schema,
      ];
      const schemas = client.schemas();
      vi.spyOn(client, 'schemas').mockReturnValue(schemas);
      vi.spyOn(client, 'fetch').mockImplementation((path) => {
        const said = path.slice('/schema/'.length);
        const schema = documents.find((document) => document.$id === said);
        if (!available.has(said) || schema === undefined)
          return Promise.reject(new Error(`HTTP GET /schema/${said} - 404 missing`));
        return Promise.resolve(Response.json(schema));
      });
      const oobis = client.oobis();
      vi.spyOn(client, 'oobis').mockReturnValue(oobis);
      const resolve = vi.spyOn(oobis, 'resolve').mockImplementation((url) => {
        available.add(new URL(url).pathname.slice('/oobi/'.length));
        return Promise.resolve({
          name: 'oobi.fixture',
          done: false as const,
          metadata: { oobi: url },
        });
      });
      const operations = client.operations();
      vi.spyOn(client, 'operations').mockReturnValue(operations);
      vi.spyOn(operations, 'get').mockResolvedValue({
        name: 'oobi.fixture',
        done: true,
        response: {},
      });
      vi.spyOn(operations, 'wait').mockResolvedValue({
        name: 'oobi.fixture',
        done: true,
        response: {},
      });
      vi.spyOn(operations, 'delete').mockResolvedValue(undefined);
      const credentials = client.credentials();
      vi.spyOn(client, 'credentials').mockReturnValue(credentials);
      const issue = vi
        .spyOn(credentials, 'issue')
        .mockRejectedValue(new Error('fixture stops before issuance'));
      const custody = await connectLocalMandateCustody({
        adminUrl: 'http://keria.invalid',
        bootUrl: 'http://keria.invalid',
        bran: '0123456789abcdefghijk',
        securityTier: 'low',
        expectedControllerAid: controller,
        expectedAgentAid: agent,
        taskMandateSchemaOobi: taskMandateSchemaOobi(
          `http://issuer.test/oobi/${taskMandateSchemaSaid}`,
        ),
        promotionMandateSchemaOobi: promotionMandateSchemaOobi(
          `http://issuer.test/oobi/${promotionMandateSchemaSaid}`,
        ),
        operationTimeoutMs: 100,
      });
      const budgets = {
        ...(experience ? taskEvaluationBudgetCeilings : taskBudgetCeilings),
        runsPerAdmittedUser: runs,
      };
      const scope = {
        corpusSaid: `E${'q'.repeat(43)}`,
        repositoryResourceSaid: `E${'s'.repeat(43)}`,
        disclosure: 'AuthorizedAnalogy' as const,
      };
      const promotionClaims = {
        authority: 'ActivateEvaluatedSuccessor' as const,
        taskId: input.claims.taskId,
        taskRevisionSaid: input.claims.taskRevisionSaid,
        harnessLineageId: input.claims.harnessLineageId,
        capabilityCeiling: input.claims.allowedCapabilities,
        budgetCeiling: budgets,
        evolutionClassCeiling: input.claims.allowedEvolutionClasses,
        requiredEvidenceClasses: promotionEvidenceClasses,
        ...(experience ? { experience: scope } : {}),
        notBefore: input.claims.notBefore,
        expiresAt: input.claims.expiresAt,
      };
      const request: StableMandateIssuance =
        kind === 'TaskMandate'
          ? {
              ...input,
              claims: { ...input.claims, budgets, ...(experience ? { experience: scope } : {}) },
            }
          : {
              ...input,
              kind,
              holderAid: governorAid(holder),
              claims: exact
                ? {
                    ...promotionClaims,
                    experience: scope,
                    evaluationManifestSaid: `E${'m'.repeat(43)}`,
                    requiredMetrics: promotionRequiredMetrics,
                    requiredChecks: promotionRequiredChecks,
                    riskLimit: promotionRiskLimit,
                  }
                : promotionClaims,
            };
      await expect(custody.submitIssuance(request)).rejects.toThrow(
        'fixture stops before issuance',
      );
      expect(issue).toHaveBeenCalledTimes(1);
      const issuance = issue.mock.calls[0]?.[1];
      expect(issuance).toMatchObject({
        s: expectedSchema.$id,
        a: kind === 'TaskMandate' ? { budgets } : { budgetCeiling: budgets },
      });
      if (issuance === undefined) throw new Error('Missing fixture issuance arguments');
      const mandate = saidify({
        v: 'ACDC10JSON000000_',
        d: '',
        i: issuance.i,
        ri: issuance.ri,
        s: issuance.s,
        a: saidify({ d: '', ...issuance.a }),
      });
      expect(
        reconcileMandateIssuanceEvidence(
          [{ sad: mandate, iss: { d: 'issuance' }, anc: { d: 'anchor' }, ancatc: [] }],
          [],
          request,
        ),
      ).toEqual({ kind: 'Materialized', credentialSaid: mandate.d });
      expect(
        reconcileMandateIssuanceEvidence(
          [],
          [{ name: 'credential.fixture', metadata: { ced: mandate } }],
          request,
        ),
      ).toEqual({
        kind: 'Submitted',
        credentialSaid: mandate.d,
        operationName: 'credential.fixture',
      });
      expect(resolve).toHaveBeenCalledWith(
        `http://issuer.test/oobi/${expectedSchema.$id}`,
        'devrandom-credential-schema',
      );
      const newSchemas = [
        taskMandateV3Schema,
        promotionMandateV4Schema,
        promotionMandateV5Schema,
        taskMandateV4Schema,
        promotionMandateV6Schema,
        promotionMandateV7Schema,
      ];
      for (const schema of newSchemas.filter((schema) => schema !== expectedSchema)) {
        expect(available.has(schema.$id)).toBe(false);
      }
    },
  );

  it('prefers exact materialized credential evidence over a still-listed operation', () => {
    const mandate = credential();
    expect(
      reconcileMandateIssuanceEvidence(
        [{ sad: mandate, iss: { d: 'issuance' }, anc: { d: 'anchor' }, ancatc: [] }],
        [{ name: 'credential.operation', metadata: { ced: mandate } }],
        input,
      ),
    ).toEqual({ kind: 'Materialized', credentialSaid: mandate.d });
  });

  it('retains the real operation only while the exact credential is not materialized', () => {
    const mandate = credential();
    expect(
      reconcileMandateIssuanceEvidence(
        [],
        [{ name: 'credential.operation', metadata: { ced: mandate } }],
        input,
      ),
    ).toEqual({
      kind: 'Submitted',
      credentialSaid: mandate.d,
      operationName: 'credential.operation',
    });
  });
});
