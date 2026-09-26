import { IdentityFailure, type IssuerCurrentUserCredentialVerification } from '@devrandom/identity';
import { describe, expect, it } from 'vitest';

import { issuerTaskCreationEligibility } from './issuer-task-creation-eligibility.js';

const taskOwnerAid = 'EMstL6Th90iB6MpQkPjKN2ii7a5XcvA_PCHWHrAAD-l4';
const taskCredentialSaid = 'EOiOyOhb0YSm2r84POPLVrHAwb1B81LZZH80gQGKjjho';

describe('issuer-backed Task creation eligibility', () => {
  it('requires the current credential to retain CreateTask eligibility', async () => {
    const eligible: IssuerCurrentUserCredentialVerification = {
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
    const ineligible: IssuerCurrentUserCredentialVerification = {
      verify: (input) =>
        Promise.resolve({
          kind: 'Current',
          userAid: input.userAid,
          credentialSaid: input.credentialSaid,
          attributeSaid: 'attribute-said',
          issuedAt: '2026-09-24T12:00:00.000Z',
          issuerAnchorEventSaid: 'anchor-said',
          eligibilityClaims: ['ReceiveTaskResults'],
        }),
    };

    const input = { ownerAid: taskOwnerAid, credentialSaid: taskCredentialSaid };
    await expect(issuerTaskCreationEligibility(eligible).authorize(input)).resolves.toEqual({
      kind: 'Eligible',
    });
    await expect(issuerTaskCreationEligibility(ineligible).authorize(input)).resolves.toEqual({
      kind: 'EligibilityMissing',
    });
  });

  it('keeps a non-current credential distinct from KERIA unavailability', async () => {
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
    const input = { ownerAid: taskOwnerAid, credentialSaid: taskCredentialSaid };

    await expect(issuerTaskCreationEligibility(rejected).authorize(input)).resolves.toEqual({
      kind: 'CredentialNotCurrent',
    });
    await expect(issuerTaskCreationEligibility(unavailable).authorize(input)).resolves.toEqual({
      kind: 'DependencyUnavailable',
      dependency: 'Keria',
    });
  });
});
