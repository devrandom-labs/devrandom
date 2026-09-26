import type { WorkAccessAttemptProjection } from '@devrandom/protocol';

import type { WorkAccessAttempt } from '../domain/work-access.js';

export function projectWorkAccessAttempt(attempt: WorkAccessAttempt): WorkAccessAttemptProjection {
  const binding = {
    version: 1 as const,
    attemptId: attempt.binding.attemptId,
    userAid: attempt.binding.userAid,
    credentialSaid: attempt.binding.credentialSaid,
    issuerRecipientAid: attempt.binding.issuerRecipientAid,
    clientInstanceId: attempt.binding.clientInstanceId,
    commandId: attempt.binding.commandId,
    grantSecretHash: attempt.binding.grantSecretHash,
    attemptExpiresAt: attempt.binding.attemptExpiresAt,
  };
  switch (attempt.state.kind) {
    case 'AwaitingProof':
      return {
        ...binding,
        kind: 'AwaitingProof',
        challengeWords: [...attempt.state.challengeWords],
      };
    case 'VerifyingProof':
      return { ...binding, kind: 'VerifyingProof', responseSaid: attempt.state.responseSaid };
    case 'Granted':
      return {
        ...binding,
        kind: 'Granted',
        verifiedResponseSaid: attempt.state.verifiedResponseSaid,
        scopes: [...attempt.state.scopes],
        policyFingerprint: attempt.state.policyFingerprint,
        disposition:
          attempt.state.disposition.kind === 'Active'
            ? {
                ...attempt.state.disposition,
                expiresAt: attempt.state.expiresAt,
              }
            : attempt.state.disposition,
      };
    case 'Rejected':
      return { ...binding, kind: 'Rejected', reason: attempt.state.reason };
    case 'Expired':
      return { ...binding, kind: 'Expired' };
  }
}
