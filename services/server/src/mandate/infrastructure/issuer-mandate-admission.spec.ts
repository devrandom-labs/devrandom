import type { MandateAdmission, MandateAdmissionRejection } from '@devrandom/identity';
import { describe, expect, it } from 'vitest';

import { issuerMandateAdmission } from './issuer-mandate-admission.js';

const input = {
  ownerAid: `E${'a'.repeat(43)}`,
  credentialSaid: `E${'b'.repeat(43)}`,
  grantSaid: `E${'c'.repeat(43)}`,
};

function rejected(reason: MandateAdmissionRejection): MandateAdmission {
  return {
    inspect: () => Promise.resolve({ kind: 'Rejected', reason }),
    begin: () => Promise.resolve({ kind: 'Rejected', reason }),
    observe: () => Promise.resolve({ kind: 'Rejected', reason }),
  };
}

describe('issuer mandate admission adapter', () => {
  it('retains a not-yet-materialized grant as a nonterminal outcome', async () => {
    const pending: MandateAdmission = {
      inspect: () => Promise.resolve({ kind: 'GrantPending' }),
      begin: () => Promise.resolve({ kind: 'GrantPending' }),
      observe: () => Promise.resolve({ kind: 'GrantPending' }),
    };
    const adapted = issuerMandateAdmission(pending);

    await expect(adapted.inspect(input)).resolves.toEqual({ kind: 'MandateGrantPending' });
    await expect(
      adapted.begin({ ...input, preparedAt: Date.parse('2026-09-24T12:00:00.000Z') }),
    ).resolves.toEqual({ kind: 'MandateGrantPending' });
    await expect(adapted.observe({ ...input, operationName: 'operation.123' })).resolves.toEqual({
      kind: 'MandateGrantPending',
    });
  });

  it.each([
    ['GrantEvidenceInvalid', 'GrantEvidenceInvalid'],
    ['GrantSenderMismatch', 'GrantEvidenceInvalid'],
    ['GrantRecipientMismatch', 'GrantEvidenceInvalid'],
    ['AdmissionOperationFailed', 'GrantEvidenceInvalid'],
    ['CredentialSaidMismatch', 'CredentialBindingInvalid'],
    ['CredentialIssuerMismatch', 'CredentialBindingInvalid'],
    ['CredentialIssueeMismatch', 'CredentialBindingInvalid'],
    ['CredentialSchemaMismatch', 'CredentialBindingInvalid'],
    ['CredentialRegistryInvalid', 'CredentialBindingInvalid'],
    ['IncompatibleCredentialState', 'IncompatibleCredentialState'],
  ] satisfies readonly [MandateAdmissionRejection, string][])(
    'maps identity %s without exposing adapter detail',
    async (identityReason, expectedReason) => {
      await expect(
        issuerMandateAdmission(rejected(identityReason)).inspect(input),
      ).resolves.toEqual({
        kind: 'MandateAdmissionRejected',
        reason: expectedReason,
      });
    },
  );

  it('retains forbidden and unavailable alternatives', async () => {
    const admission: MandateAdmission = {
      inspect: () => Promise.resolve({ kind: 'Forbidden', reason: 'MandateRevoked' }),
      begin: () => Promise.resolve({ kind: 'Unavailable', dependency: 'Witness' }),
      observe: () => Promise.resolve({ kind: 'Pending' }),
    };
    const adapted = issuerMandateAdmission(admission);

    await expect(adapted.inspect(input)).resolves.toEqual({
      kind: 'MandateAdmissionForbidden',
      reason: 'MandateRevoked',
    });
    await expect(
      adapted.begin({ ...input, preparedAt: Date.parse('2026-09-24T12:00:00.000Z') }),
    ).resolves.toEqual({
      kind: 'DependencyUnavailable',
      dependency: 'Witness',
    });
    await expect(adapted.observe({ ...input, operationName: 'operation.123' })).resolves.toEqual({
      kind: 'MandateAdmissionPending',
    });
  });
});
