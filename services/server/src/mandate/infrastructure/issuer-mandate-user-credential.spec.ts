import { IdentityFailure, type IssuerCurrentUserCredentialVerification } from '@devrandom/identity';
import { describe, expect, it } from 'vitest';

import { issuerMandateUserCredential } from './issuer-mandate-user-credential.js';

const ownerAid = 'EMstL6Th90iB6MpQkPjKN2ii7a5XcvA_PCHWHrAAD-l4';
const credentialSaidValue = 'EOiOyOhb0YSm2r84POPLVrHAwb1B81LZZH80gQGKjjho';

describe('issuer-backed mandate user credential', () => {
  it('distinguishes current, invalid, and unavailable credential evidence', async () => {
    const current: IssuerCurrentUserCredentialVerification = {
      verify: (input) =>
        Promise.resolve({
          kind: 'Current',
          userAid: input.userAid,
          credentialSaid: input.credentialSaid,
          attributeSaid: 'attribute-said',
          issuedAt: '2026-09-24T12:00:00.000Z',
          issuerAnchorEventSaid: 'anchor-said',
          eligibilityClaims: ['CreateTask'],
        }),
    };
    const invalid: IssuerCurrentUserCredentialVerification = {
      verify: () =>
        Promise.reject(new IdentityFailure({ kind: 'credential-invalid', reason: 'revoked' })),
    };
    const unavailable: IssuerCurrentUserCredentialVerification = {
      verify: () =>
        Promise.reject(
          new IdentityFailure({
            kind: 'keria-unavailable',
            stage: 'credential lookup',
            reason: 'offline',
          }),
        ),
    };
    const input = { ownerAid, credentialSaid: credentialSaidValue };

    await expect(issuerMandateUserCredential(current).verify(input)).resolves.toEqual({
      kind: 'UserCredentialCurrent',
    });
    await expect(issuerMandateUserCredential(invalid).verify(input)).resolves.toEqual({
      kind: 'UserCredentialNotCurrent',
    });
    await expect(issuerMandateUserCredential(unavailable).verify(input)).resolves.toEqual({
      kind: 'DependencyUnavailable',
      dependency: 'Keria',
    });
  });
});
