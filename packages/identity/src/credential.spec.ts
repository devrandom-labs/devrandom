import {
  credentialCapabilities,
  credentialSchema,
  type CredentialCapability,
} from '@devrandom/protocol';
import { Saider } from 'signify-ts';
import { describe, expect, it } from 'vitest';

import {
  credentialRegistryId,
  credentialSaid,
  credentialSchemaId,
  issuerAid,
  userAid,
} from './keri-identifier.js';
import { verifyCredentialEvidence } from './credential.js';

const issuer = issuerAid('EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk');
const anotherIssuer = issuerAid('EJlw5Fw9LKH1CYFEkGiDUlx0cHozvXb7hfqhSoMsH6bs');
const user = userAid('EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz');
const registry = credentialRegistryId('EBfdlu8R27Fbx-ehrqwImnK-8Cm79sqbAQ4MmvEAYqao');
const schema = credentialSchemaId(credentialSchema.$id);

function saidify<Value extends object & { readonly d: string }>(value: Value): Value {
  const [, document] = Saider.saidify(value);
  const untrusted: unknown = document;
  if (
    typeof untrusted !== 'object' ||
    untrusted === null ||
    !('d' in untrusted) ||
    typeof untrusted.d !== 'string'
  ) {
    throw new Error('saidify did not return a document SAID');
  }
  if ('v' in value) {
    if (!('v' in untrusted) || typeof untrusted.v !== 'string') {
      throw new Error('saidify did not return a version string');
    }
    return { ...value, d: untrusted.d, v: untrusted.v };
  }
  return { ...value, d: untrusted.d };
}

function credentialEvidence(
  capabilities: readonly CredentialCapability[] = credentialCapabilities,
) {
  const attributes = saidify({
    d: '',
    i: user,
    dt: '2026-09-23T20:00:00.000000+00:00',
    capabilities: [...capabilities],
  });
  const payload = saidify({
    v: 'ACDC10JSON000000_',
    d: '',
    i: issuer,
    ri: registry,
    s: schema,
    a: attributes,
  });
  const issuance = saidify({
    v: 'KERI10JSON000000_',
    t: 'iss',
    d: '',
    i: payload.d,
    ri: registry,
    s: '0',
    dt: '2026-09-23T20:00:00.000000+00:00',
  });
  const anchor = saidify({
    v: 'KERI10JSON000000_',
    t: 'ixn',
    d: '',
    i: issuer,
    s: '1',
    p: issuer,
    a: [{ i: payload.d, s: issuance.s, d: issuance.d }],
  });

  return {
    expectedCredentialSaid: credentialSaid(payload.d),
    credential: { sad: payload, iss: issuance, anc: anchor },
    credentialState: {
      i: payload.d,
      ri: registry,
      s: '0',
      et: 'iss',
    },
    issuerKeyEvents: [{ ked: anchor }],
    resolvedSchema: credentialSchema,
  };
}

describe('credential verification', () => {
  it('accepts complete content, registry, status, schema, and issuer-anchor evidence', () => {
    const verified = verifyCredentialEvidence(credentialEvidence(), {
      issuerAid: issuer,
      issueeAid: user,
      registryId: registry,
      schemaId: schema,
      payloadSchema: credentialSchema,
    });

    expect(verified.payload).toMatchObject({
      i: issuer,
      ri: registry,
      s: schema,
      a: { i: user, capabilities: credentialCapabilities },
    });
    expect(verified.credentialSaid).toBe(verified.payload.d);
  });

  it('rejects a credential when the expected issuer differs', () => {
    expect(() =>
      verifyCredentialEvidence(credentialEvidence(), {
        issuerAid: anotherIssuer,
        issueeAid: user,
        registryId: registry,
        schemaId: schema,
        payloadSchema: credentialSchema,
      }),
    ).toThrow('credential issuer does not match expected state');
  });

  it('rejects a different valid credential returned for the requested SAID', () => {
    const evidence = credentialEvidence();

    expect(() =>
      verifyCredentialEvidence(
        {
          ...evidence,
          expectedCredentialSaid: credentialSaid('EJlw5Fw9LKH1CYFEkGiDUlx0cHozvXb7hfqhSoMsH6bs'),
        },
        {
          issuerAid: issuer,
          issueeAid: user,
          registryId: registry,
          schemaId: schema,
          payloadSchema: credentialSchema,
        },
      ),
    ).toThrow('credential SAID does not match the requested credential');
  });

  it('rejects a credential when the expected issuee differs', () => {
    expect(() =>
      verifyCredentialEvidence(credentialEvidence(), {
        issuerAid: issuer,
        issueeAid: userAid(anotherIssuer),
        registryId: registry,
        schemaId: schema,
        payloadSchema: credentialSchema,
      }),
    ).toThrow('credential issuee does not match expected state');
  });

  it('rejects a credential when the expected registry differs', () => {
    expect(() =>
      verifyCredentialEvidence(credentialEvidence(), {
        issuerAid: issuer,
        issueeAid: user,
        registryId: credentialRegistryId(schema),
        schemaId: schema,
        payloadSchema: credentialSchema,
      }),
    ).toThrow('credential registry does not match expected state');
  });

  it('rejects a credential bound to a different schema', () => {
    const evidence = credentialEvidence();
    const payload = saidify({
      ...evidence.credential.sad,
      d: '',
      s: anotherIssuer,
    });

    expect(() =>
      verifyCredentialEvidence(
        {
          ...evidence,
          credential: { ...evidence.credential, sad: payload },
        },
        {
          issuerAid: issuer,
          issueeAid: user,
          registryId: registry,
          schemaId: schema,
          payloadSchema: credentialSchema,
        },
      ),
    ).toThrow('credential schema does not match expected state');
  });

  it('rejects a credential whose credential SAID is corrupted', () => {
    const evidence = credentialEvidence();

    expect(() =>
      verifyCredentialEvidence(
        {
          ...evidence,
          credential: {
            ...evidence.credential,
            sad: { ...evidence.credential.sad, d: anotherIssuer },
          },
        },
        {
          issuerAid: issuer,
          issueeAid: user,
          registryId: registry,
          schemaId: schema,
          payloadSchema: credentialSchema,
        },
      ),
    ).toThrow('credential payload is not bound by its SAID');
  });

  it('rejects a credential whose attribute SAID is corrupted', () => {
    const evidence = credentialEvidence();
    const payload = saidify({
      ...evidence.credential.sad,
      d: '',
      a: { ...evidence.credential.sad.a, d: anotherIssuer },
    });

    expect(() =>
      verifyCredentialEvidence(
        {
          ...evidence,
          credential: { ...evidence.credential, sad: payload },
        },
        {
          issuerAid: issuer,
          issueeAid: user,
          registryId: registry,
          schemaId: schema,
          payloadSchema: credentialSchema,
        },
      ),
    ).toThrow('credential attributes is not bound by its SAID');
  });

  it('rejects a credential whose issuance SAID is corrupted', () => {
    const evidence = credentialEvidence();

    expect(() =>
      verifyCredentialEvidence(
        {
          ...evidence,
          credential: {
            ...evidence.credential,
            iss: { ...evidence.credential.iss, d: anotherIssuer },
          },
        },
        {
          issuerAid: issuer,
          issueeAid: user,
          registryId: registry,
          schemaId: schema,
          payloadSchema: credentialSchema,
        },
      ),
    ).toThrow('credential issuance event is not bound by its SAID');
  });

  it('rejects a credential whose anchor issuer differs', () => {
    const evidence = credentialEvidence();
    const anchor = saidify({
      ...evidence.credential.anc,
      d: '',
      i: anotherIssuer,
    });

    expect(() =>
      verifyCredentialEvidence(
        {
          ...evidence,
          credential: { ...evidence.credential, anc: anchor },
          issuerKeyEvents: [{ ked: anchor }],
        },
        {
          issuerAid: issuer,
          issueeAid: user,
          registryId: registry,
          schemaId: schema,
          payloadSchema: credentialSchema,
        },
      ),
    ).toThrow('issuer anchor does not match expected state');
  });

  it('rejects a credential whose anchor SAID is corrupted', () => {
    const evidence = credentialEvidence();

    expect(() =>
      verifyCredentialEvidence(
        {
          ...evidence,
          credential: {
            ...evidence.credential,
            anc: { ...evidence.credential.anc, d: anotherIssuer },
          },
        },
        {
          issuerAid: issuer,
          issueeAid: user,
          registryId: registry,
          schemaId: schema,
          payloadSchema: credentialSchema,
        },
      ),
    ).toThrow('issuer anchor event is not bound by its SAID');
  });

  it('rejects a credential whose anchor does not seal the issuance event', () => {
    const evidence = credentialEvidence();
    const [seal] = evidence.credential.anc.a;
    if (seal === undefined) {
      throw new Error('credential evidence did not contain an issuance seal');
    }
    const anchor = saidify({
      ...evidence.credential.anc,
      d: '',
      a: [{ ...seal, d: anotherIssuer }],
    });

    expect(() =>
      verifyCredentialEvidence(
        {
          ...evidence,
          credential: { ...evidence.credential, anc: anchor },
          issuerKeyEvents: [{ ked: anchor }],
        },
        {
          issuerAid: issuer,
          issueeAid: user,
          registryId: registry,
          schemaId: schema,
          payloadSchema: credentialSchema,
        },
      ),
    ).toThrow('issuer anchor does not seal the issuance event');
  });

  it('rejects a corrupted issuer KEL copy of the credential anchor', () => {
    const evidence = credentialEvidence();

    expect(() =>
      verifyCredentialEvidence(
        {
          ...evidence,
          issuerKeyEvents: [
            {
              ked: {
                ...evidence.credential.anc,
                a: [],
              },
            },
          ],
        },
        {
          issuerAid: issuer,
          issueeAid: user,
          registryId: registry,
          schemaId: schema,
          payloadSchema: credentialSchema,
        },
      ),
    ).toThrow('issuer KEL anchor event is not bound by its SAID');
  });

  it('rejects a resolved schema whose SAID is corrupted', () => {
    const evidence = credentialEvidence();

    expect(() =>
      verifyCredentialEvidence(
        {
          ...evidence,
          resolvedSchema: { ...credentialSchema, title: 'Corrupted credential schema' },
        },
        {
          issuerAid: issuer,
          issueeAid: user,
          registryId: registry,
          schemaId: schema,
          payloadSchema: credentialSchema,
        },
      ),
    ).toThrow('resolved schema is not bound by its SAID');
  });

  it('rejects a credential with the wrong fixed capability claim set', () => {
    expect(() =>
      verifyCredentialEvidence(
        credentialEvidence([
          'CreateAgent',
          'CreateAgent',
          'RunPrivateTask',
          'PublishHarness',
          'ReceiveTaskResults',
        ]),
        {
          issuerAid: issuer,
          issueeAid: user,
          registryId: registry,
          schemaId: schema,
          payloadSchema: credentialSchema,
        },
      ),
    ).toThrow('payload does not match the expected credential schema');
  });

  it('rejects a credential without its issued TEL state', () => {
    const evidence = credentialEvidence();
    expect(() =>
      verifyCredentialEvidence(
        {
          ...evidence,
          credentialState: { ...evidence.credentialState, s: '1', et: 'rev' },
        },
        {
          issuerAid: issuer,
          issueeAid: user,
          registryId: registry,
          schemaId: schema,
          payloadSchema: credentialSchema,
        },
      ),
    ).toThrow('credential does not have an issued TEL state');
  });

  it('rejects a credential whose anchor is absent from the issuer KEL', () => {
    expect(() =>
      verifyCredentialEvidence(
        { ...credentialEvidence(), issuerKeyEvents: [] },
        {
          issuerAid: issuer,
          issueeAid: user,
          registryId: registry,
          schemaId: schema,
          payloadSchema: credentialSchema,
        },
      ),
    ).toThrow('issuer KEL does not contain the credential anchor');
  });
});
