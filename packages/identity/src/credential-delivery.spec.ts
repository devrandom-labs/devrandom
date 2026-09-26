import { devrandomUserEligibilityClaims } from '@devrandom/domain';
import { SignifyClient, Tier } from 'signify-ts';
import Type from 'typebox';
import { describe, expect, it, vi } from 'vitest';

import { IdentityFailure } from './identity-error.js';
import {
  reconcileCredentialEvidence,
  signifyDevrandomUserCredentialDelivery,
  reconcileGrantOperationEvidence,
  type StableCredentialIssuance,
} from './credential-delivery.js';

const issuance = {
  issuerAlias: 'devrandom-issuer',
  issuerAid: 'EIssuer',
  issueeAid: 'EUser',
  registryId: 'ERegistry',
  schemaId: 'ESchema',
  issuedAt: Date.parse('2026-09-24T12:00:00.000Z'),
  claims: devrandomUserEligibilityClaims,
  operationTimeoutMs: 30_000,
} satisfies StableCredentialIssuance;

function credential(credentialSaid: string, issueeAid = issuance.issueeAid) {
  return {
    sad: {
      d: credentialSaid,
      i: issuance.issuerAid,
      ri: issuance.registryId,
      s: issuance.schemaId,
      a: {
        i: issueeAid,
        dt: '2026-09-24T12:00:00.000000+00:00',
        capabilities: [...devrandomUserEligibilityClaims],
      },
    },
    iss: { d: 'EIssuanceEvent' },
    anc: { d: 'EAnchor' },
    ancatc: ['-AAB'],
  };
}

describe('credential delivery reconciliation', () => {
  it('reconciles across mixed-schema pages through the Signify delivery boundary', async () => {
    const client = new SignifyClient('http://keria.invalid', '0123456789abcdefghijk', Tier.low);
    const credentials = client.credentials();
    const operations = client.operations();
    vi.spyOn(client, 'credentials').mockReturnValue(credentials);
    vi.spyOn(client, 'operations').mockReturnValue(operations);
    const unrelated = {
      ...credential('EWork'),
      sad: { ...credential('EWork').sad, s: 'EWorkSchema', a: { i: 'EAgent' } },
    };
    const list = vi
      .spyOn(credentials, 'list')
      .mockResolvedValueOnce(Array.from({ length: 1_000 }, () => unrelated))
      .mockResolvedValueOnce([credential('EExpected')]);
    vi.spyOn(operations, 'list').mockResolvedValue([]);
    const delivery = signifyDevrandomUserCredentialDelivery(
      client,
      Type.Object({}, { $id: 'ESchema' }),
    );
    await expect(delivery.reconcileCredential(issuance)).resolves.toEqual({
      kind: 'credential-submitted',
      credentialSaid: 'EExpected',
      operationName: 'credential-reconciled/EExpected',
    });
    expect(list).toHaveBeenNthCalledWith(2, { skip: 1_000, limit: 1_000 });
    list.mockResolvedValueOnce([
      { ...credential('EBroken'), sad: { ...credential('EBroken').sad, a: { i: 'EUser' } } },
    ]);
    await expect(delivery.reconcileCredential(issuance)).rejects.toThrow(IdentityFailure);
  });

  it('correlates only the exact stable credential and its issuance operation', () => {
    expect(
      reconcileCredentialEvidence(
        [credential('EDecoy', 'EDifferentUser'), credential('EExpected')],
        [
          {
            name: 'credential.EDecoyOperation',
            done: true,
            metadata: { ced: credential('EDecoy', 'EDifferentUser').sad },
          },
          {
            name: 'credential.EExpectedOperation',
            done: true,
            metadata: { ced: credential('EExpected').sad },
          },
        ],
        issuance,
      ),
    ).toEqual({
      kind: 'credential-submitted',
      credentialSaid: 'EExpected',
      operationName: 'credential.EExpectedOperation',
    });
  });

  it('reconciles a user credential alongside unrelated work credentials without user capabilities', () => {
    const unrelated = {
      ...credential('EWorkAccess'),
      sad: { ...credential('EWorkAccess').sad, s: 'EWorkAccessSchema', a: { i: 'EAgent' } },
    };
    expect(reconcileCredentialEvidence([unrelated, credential('EExpected')], [], issuance)).toEqual(
      {
        kind: 'credential-submitted',
        credentialSaid: 'EExpected',
        operationName: 'credential-reconciled/EExpected',
      },
    );
    expect(reconcileCredentialEvidence([unrelated], [], issuance)).toEqual({
      kind: 'credential-not-found',
    });
  });

  it('rejects malformed credentials claiming the requested user schema', () => {
    const malformed = {
      ...credential('EBroken'),
      sad: { ...credential('EBroken').sad, a: { i: issuance.issueeAid } },
    };
    expect(() =>
      reconcileCredentialEvidence([malformed, credential('EExpected')], [], issuance),
    ).toThrow(IdentityFailure);
  });

  it('reports absence without converting a decoy into the expected credential', () => {
    expect(
      reconcileCredentialEvidence([credential('EDecoy', 'EDifferentUser')], [], issuance),
    ).toEqual({ kind: 'credential-not-found' });
  });

  it('recovers an exact pending issuance operation before the credential list materializes', () => {
    expect(
      reconcileCredentialEvidence(
        [],
        [
          {
            name: 'credential.EPendingOperation',
            done: false,
            metadata: { ced: credential('EPending').sad },
          },
        ],
        issuance,
      ),
    ).toEqual({
      kind: 'credential-submitted',
      credentialSaid: 'EPending',
      operationName: 'credential.EPendingOperation',
    });
  });

  it('ignores unrelated historical operations that do not carry a stable issuance envelope', () => {
    expect(
      reconcileCredentialEvidence(
        [],
        [
          {
            name: 'credential.EHistoricalOperation',
            done: true,
            metadata: { ced: { d: 'EHistoricalCredential' } },
          },
          {
            name: 'credential.EExpectedOperation',
            done: false,
            metadata: { ced: credential('EExpected').sad },
          },
        ],
        issuance,
      ),
    ).toEqual({
      kind: 'credential-submitted',
      credentialSaid: 'EExpected',
      operationName: 'credential.EExpectedOperation',
    });
  });

  it('rejects disagreement between exact credential and operation evidence', () => {
    expect(() =>
      reconcileCredentialEvidence(
        [credential('ECredential')],
        [
          {
            name: 'credential.EOperation',
            done: true,
            metadata: { ced: credential('EOperationCredential').sad },
          },
        ],
        issuance,
      ),
    ).toThrow(IdentityFailure);
  });

  it('rejects ambiguous exact credentials instead of silently selecting one', () => {
    expect(() =>
      reconcileCredentialEvidence([credential('EFirst'), credential('ESecond')], [], issuance),
    ).toThrow(IdentityFailure);
  });

  it('correlates an exchange operation by the exact durable grant SAID', () => {
    expect(
      reconcileGrantOperationEvidence(
        [
          { name: 'exchange.EDecoy', done: true, metadata: { said: 'EDecoyGrant' } },
          { name: 'exchange.EExpected', done: true, metadata: { said: 'EExpectedGrant' } },
        ],
        'EExpectedGrant',
      ),
    ).toEqual({ kind: 'grant-submitted', operationName: 'exchange.EExpected' });
  });
});
