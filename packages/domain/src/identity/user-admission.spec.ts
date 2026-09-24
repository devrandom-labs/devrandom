import { describe, expect, it } from 'vitest';

import {
  confirmCurrentUserCustody,
  decideUserAdmission,
  devrandomUserEligibilityClaims,
  verifyDevrandomUserCredential,
  type AdmittedUser,
  type CurrentUserCredential,
  type CurrentUserCustody,
  type DevrandomUserCredentialPolicy,
  type UserCredentialInspection,
  type UserPrincipal,
} from '../index.js';

const principal: UserPrincipal = {
  aid: 'EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz',
};

const policy: DevrandomUserCredentialPolicy = {
  issuerAid: 'EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk',
  issueeAid: principal.aid,
  registryId: 'ERegistry0000000000000000000000000000000000000',
  schemaSaid: 'ESchema00000000000000000000000000000000000000',
};

const inspection: UserCredentialInspection = {
  credentialSaid: 'ECredential0000000000000000000000000000000000',
  attributeSaid: 'EAttribute00000000000000000000000000000000000',
  issuerAid: policy.issuerAid,
  issueeAid: policy.issueeAid,
  registryId: policy.registryId,
  schemaSaid: policy.schemaSaid,
  issuedAt: '2026-09-24T15:00:00.000Z',
  verifiedAt: '2026-09-24T15:01:00.000Z',
  credentialSaidBinding: { kind: 'Verified' },
  attributeSaidBinding: { kind: 'Verified' },
  schemaDocument: { kind: 'Resolved', schemaSaid: policy.schemaSaid },
  telState: { kind: 'Issued' },
  issuerAnchor: {
    kind: 'Anchored',
    eventSaid: 'EAnchor000000000000000000000000000000000000000',
  },
  eligibilityClaims: devrandomUserEligibilityClaims,
};

function currentCustody(user: UserPrincipal = principal): CurrentUserCustody {
  const confirmation = confirmCurrentUserCustody({
    user,
    controllerAid: 'EController00000000000000000000000000000000000',
    keriaAgentAid: 'EKeriaAgent0000000000000000000000000000000000',
    kelSequence: 0,
    witnessAids: ['BWitness000000000000000000000000000000000000'],
    witnessThreshold: 1,
    witnessReceiptIndexes: [0],
    verifiedAt: '2026-09-24T15:01:00.000Z',
  });

  if (confirmation.kind !== 'Current') {
    throw new Error('expected current custody');
  }

  return confirmation.custody;
}

function currentCredential(
  candidate: UserCredentialInspection = inspection,
  expectation: DevrandomUserCredentialPolicy = policy,
): CurrentUserCredential {
  const verification = verifyDevrandomUserCredential(expectation, candidate);

  if (verification.kind !== 'Current') {
    throw new Error(`expected current credential, received ${verification.invalidity.kind}`);
  }

  return verification.credential;
}

describe('current user custody', () => {
  it('requires enough distinct witnessed receipt indexes for the configured threshold', () => {
    const confirmation = confirmCurrentUserCustody({
      user: principal,
      controllerAid: 'EController00000000000000000000000000000000000',
      keriaAgentAid: 'EKeriaAgent0000000000000000000000000000000000',
      kelSequence: 3,
      witnessAids: [
        'BWitnessOne0000000000000000000000000000000000',
        'BWitnessTwo0000000000000000000000000000000000',
      ],
      witnessThreshold: 2,
      witnessReceiptIndexes: [0, 0],
      verifiedAt: '2026-09-24T15:01:00.000Z',
    });

    expect(confirmation).toEqual({
      kind: 'RecoveryRequired',
      reason: {
        kind: 'WitnessThresholdNotMet',
        required: 2,
        received: 1,
      },
    });
  });
});

describe('Devrandom user credential verification', () => {
  it('recognizes only the exact issuer, issuee, registry, schema, TEL, SAIDs, anchor, and claims', () => {
    const verification = verifyDevrandomUserCredential(policy, inspection);

    expect(verification.kind).toBe('Current');
    if (verification.kind !== 'Current') {
      throw new Error('expected current credential');
    }
    expect(verification.credential.eligibilityClaims).toEqual(devrandomUserEligibilityClaims);
  });

  it.each([
    ['UnexpectedIssuer', { ...inspection, issuerAid: 'EUnexpectedIssuer' }],
    ['UnexpectedIssuee', { ...inspection, issueeAid: 'EUnexpectedIssuee' }],
    ['UnexpectedRegistry', { ...inspection, registryId: 'EUnexpectedRegistry' }],
    ['UnexpectedSchema', { ...inspection, schemaSaid: 'EUnexpectedSchema' }],
    ['CredentialSaidMismatch', { ...inspection, credentialSaidBinding: { kind: 'Mismatch' } }],
    ['AttributeSaidMismatch', { ...inspection, attributeSaidBinding: { kind: 'Mismatch' } }],
    [
      'SchemaDocumentMismatch',
      {
        ...inspection,
        schemaDocument: { kind: 'Resolved', schemaSaid: 'EUnexpectedResolvedSchema' },
      },
    ],
    [
      'CredentialRevoked',
      {
        ...inspection,
        telState: { kind: 'Revoked', revokedAt: '2026-09-24T15:00:30.000Z' },
      },
    ],
    ['CredentialNotIssued', { ...inspection, telState: { kind: 'NotIssued' } }],
    ['IssuerAnchorMissing', { ...inspection, issuerAnchor: { kind: 'Missing' } }],
    [
      'IssuerAnchorMismatch',
      {
        ...inspection,
        issuerAnchor: { kind: 'Mismatch', eventSaid: 'EUnrelatedAnchor' },
      },
    ],
  ] satisfies ReadonlyArray<readonly [string, UserCredentialInspection]>)(
    'rejects %s evidence',
    (expectedInvalidity, candidate) => {
      const verification = verifyDevrandomUserCredential(policy, candidate);

      expect(verification.kind).toBe('InvalidCredential');
      if (verification.kind !== 'InvalidCredential') {
        throw new Error('expected invalid credential');
      }
      expect(verification.invalidity.kind).toBe(expectedInvalidity);
    },
  );

  it.each([
    ['MissingEligibilityClaim', devrandomUserEligibilityClaims.slice(1)],
    ['UnexpectedEligibilityClaim', [...devrandomUserEligibilityClaims, 'AdministerPlatform']],
    ['DuplicateEligibilityClaim', [...devrandomUserEligibilityClaims, 'CreateAgent']],
  ])('rejects an inexact claim set as %s', (expectedInvalidity, eligibilityClaims) => {
    const verification = verifyDevrandomUserCredential(policy, {
      ...inspection,
      eligibilityClaims,
    });

    expect(verification.kind).toBe('InvalidCredential');
    if (verification.kind !== 'InvalidCredential') {
      throw new Error('expected invalid credential');
    }
    expect(verification.invalidity.kind).toBe(expectedInvalidity);
  });
});

describe('user admission', () => {
  it('constructs an ephemeral AdmittedUser only from current custody and current credential evidence', () => {
    const custody = currentCustody();
    const credential = currentCredential();
    const admission = decideUserAdmission({
      kind: 'CurrentCustody',
      custody,
      credential: { kind: 'Current', credential },
    });

    expect(admission.kind).toBe('Ready');
    if (admission.kind !== 'Ready') {
      throw new Error('expected ready admission');
    }
    expect(admission.user.principal).toEqual(principal);
    expect(admission.user.credential.credentialSaid).toBe(inspection.credentialSaid);
    expect(admission.user).not.toHaveProperty('ready');

    // @ts-expect-error AdmittedUser is an opaque construction capability.
    const forgedUser: AdmittedUser = { principal, custody, credential };
    expect(forgedUser.principal).toEqual(principal);
  });

  it('keeps registration, invalid credential, recovery, and infrastructure outcomes distinct', () => {
    const custody = currentCustody();
    const invalidCredential = verifyDevrandomUserCredential(policy, {
      ...inspection,
      issuerAid: 'EUnexpectedIssuer',
    });
    if (invalidCredential.kind !== 'InvalidCredential') {
      throw new Error('expected invalid credential evidence');
    }

    expect(
      decideUserAdmission({
        kind: 'CurrentCustody',
        custody,
        credential: { kind: 'RegistrationRequired' },
      }),
    ).toEqual({ kind: 'RegistrationRequired', principal });

    expect(
      decideUserAdmission({
        kind: 'CurrentCustody',
        custody,
        credential: invalidCredential,
      }),
    ).toEqual({
      kind: 'InvalidCredential',
      principal,
      invalidity: invalidCredential.invalidity,
    });

    expect(
      decideUserAdmission({
        kind: 'RecoveryRequired',
        reason: { kind: 'CustodyUnavailable' },
      }),
    ).toEqual({
      kind: 'RecoveryRequired',
      reason: { kind: 'CustodyUnavailable' },
    });

    expect(
      decideUserAdmission({
        kind: 'InfrastructureUnavailable',
        dependency: 'Keria',
      }),
    ).toEqual({
      kind: 'InfrastructureUnavailable',
      dependency: 'Keria',
    });

    expect(
      decideUserAdmission({
        kind: 'CurrentCustody',
        custody,
        credential: {
          kind: 'InfrastructureUnavailable',
          dependency: 'Issuer',
        },
      }),
    ).toEqual({
      kind: 'InfrastructureUnavailable',
      dependency: 'Issuer',
    });
  });

  it('rejects a current credential verified for a different locally controlled user', () => {
    const otherPrincipal: UserPrincipal = { aid: 'EOtherUser' };
    const admission = decideUserAdmission({
      kind: 'CurrentCustody',
      custody: currentCustody(otherPrincipal),
      credential: { kind: 'Current', credential: currentCredential() },
    });

    expect(admission).toEqual({
      kind: 'InvalidCredential',
      principal: otherPrincipal,
      invalidity: {
        kind: 'UnexpectedIssuee',
        expected: otherPrincipal.aid,
        actual: principal.aid,
      },
    });
  });
});
