import { taskBudgetCeilings } from '@devrandom/domain';
import { promotionMandateSchemaSaid, taskMandateSchemaSaid } from '@devrandom/protocol';
import { Saider } from 'signify-ts';
import { describe, expect, it } from 'vitest';

import {
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
import { credentialRegistryId, personalAgentAid, userAid } from './keri-identifier.js';

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
      budgets: taskBudgetCeilings,
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
