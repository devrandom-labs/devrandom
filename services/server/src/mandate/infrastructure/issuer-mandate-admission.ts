import type {
  MandateAdmission as IssuerMandateAdmission,
  MandateAdmissionRejection,
} from '@devrandom/identity';

import type {
  MandateAdmission,
  MandateAdmissionFailure,
} from '../application/mandate-admission.js';
import type { MandatePresentationRejection } from '../domain/presentation.js';

function rejection(reason: MandateAdmissionRejection): MandatePresentationRejection {
  switch (reason) {
    case 'GrantEvidenceInvalid':
    case 'GrantSenderMismatch':
    case 'GrantRecipientMismatch':
    case 'AdmissionOperationFailed':
      return 'GrantEvidenceInvalid';
    case 'CredentialSaidMismatch':
    case 'CredentialIssuerMismatch':
    case 'CredentialIssueeMismatch':
    case 'CredentialSchemaMismatch':
    case 'CredentialRegistryInvalid':
      return 'CredentialBindingInvalid';
    case 'IncompatibleCredentialState':
      return 'IncompatibleCredentialState';
  }
}

function failure(
  outcome:
    | { readonly kind: 'Rejected'; readonly reason: MandateAdmissionRejection }
    | { readonly kind: 'Forbidden'; readonly reason: 'MandateRevoked' }
    | { readonly kind: 'Unavailable'; readonly dependency: 'Keria' | 'Witness' },
): MandateAdmissionFailure {
  switch (outcome.kind) {
    case 'Rejected':
      return { kind: 'MandateAdmissionRejected', reason: rejection(outcome.reason) };
    case 'Forbidden':
      return { kind: 'MandateAdmissionForbidden', reason: outcome.reason };
    case 'Unavailable':
      return { kind: 'DependencyUnavailable', dependency: outcome.dependency };
  }
}

export function issuerMandateAdmission(issuerAdmission: IssuerMandateAdmission): MandateAdmission {
  return {
    async inspect(input) {
      const outcome = await issuerAdmission.inspect(input);
      switch (outcome.kind) {
        case 'GrantPending':
          return { kind: 'MandateGrantPending' };
        case 'Inspected':
          return { kind: 'MandateAdmissionInspected', evidence: outcome.evidence };
        case 'Rejected':
        case 'Forbidden':
        case 'Unavailable':
          return failure(outcome);
      }
    },
    async begin(input) {
      const outcome = await issuerAdmission.begin(input);
      switch (outcome.kind) {
        case 'GrantPending':
          return { kind: 'MandateGrantPending' };
        case 'Started':
          return { kind: 'MandateAdmissionStarted', operationName: outcome.operationName };
        case 'Rejected':
        case 'Forbidden':
        case 'Unavailable':
          return failure(outcome);
      }
    },
    async observe(input) {
      const outcome = await issuerAdmission.observe(input);
      switch (outcome.kind) {
        case 'GrantPending':
          return { kind: 'MandateGrantPending' };
        case 'Pending':
          return { kind: 'MandateAdmissionPending' };
        case 'Verified':
          return {
            kind: 'MandateAdmissionVerified',
            credentialSaid: outcome.credentialSaid,
            evidence: outcome.evidence,
          };
        case 'Rejected':
        case 'Forbidden':
        case 'Unavailable':
          return failure(outcome);
      }
    },
  };
}
