import {
  IdentityFailure,
  credentialSaid,
  type IssuerCurrentUserCredentialVerification,
} from '@devrandom/identity';
import { credentialCapabilities } from '@devrandom/protocol';
import { describe, expect, it } from 'vitest';

import { issuerWorkAccessCredentialVerification } from './issuer-work-access-credential.js';

const user = 'EMstL6Th90iB6MpQkPjKN2ii7a5XcvA_PCHWHrAAD-l4';
const credential = 'EOiOyOhb0YSm2r84POPLVrHAwb1B81LZZH80gQGKjjho';

describe('issuer-backed Work Access credential verification', () => {
  it('maps only current eligibility claims into the access context', async () => {
    const issuerCapability: IssuerCurrentUserCredentialVerification = {
      verify: (input) =>
        Promise.resolve({
          kind: 'Current',
          userAid: input.userAid,
          credentialSaid: input.credentialSaid,
          attributeSaid: 'attribute-said',
          issuedAt: '2026-09-24T16:00:00.000Z',
          issuerAnchorEventSaid: 'anchor-said',
          eligibilityClaims: credentialCapabilities,
        }),
    };

    await expect(
      issuerWorkAccessCredentialVerification(issuerCapability).verify({
        userAid: user,
        credentialSaid: credential,
      }),
    ).resolves.toEqual({ kind: 'CurrentCredential', claims: credentialCapabilities });
  });

  it('keeps identity invalidity distinct from infrastructure unavailability', async () => {
    const rejected: IssuerCurrentUserCredentialVerification = {
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

    await expect(
      issuerWorkAccessCredentialVerification(rejected).verify({
        userAid: user,
        credentialSaid: credential,
      }),
    ).resolves.toEqual({ kind: 'CredentialRejected' });
    await expect(
      issuerWorkAccessCredentialVerification(unavailable).verify({
        userAid: user,
        credentialSaid: credentialSaid(credential),
      }),
    ).resolves.toEqual({ kind: 'CredentialUnavailable', dependency: 'KERIA' });
  });
});
