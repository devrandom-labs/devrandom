import {
  IdentityFailure,
  challengeResponseSaid,
  issuerAid,
  userAid,
  type AsynchronousIssuerChallengeProof,
  type IssuerChallengeVerificationRejection,
} from '@devrandom/identity';

import type {
  WorkAccessChallengeAcknowledgement,
  WorkAccessChallengeObservation,
  WorkAccessChallengeProof,
  WorkAccessChallengeVerificationStart,
} from '../application/work-access-challenge.js';

const recipientMismatch = {
  kind: 'ChallengeRejected',
  reason: 'ChallengeRecipientMismatch',
} as const;

type ChallengeInvalidity =
  'ChallengeProofInvalid' | 'ChallengeOperationFailed' | 'ChallengeAcknowledgementRejected';

function rejectionReason(
  rejection: IssuerChallengeVerificationRejection,
): 'ChallengeProofInvalid' | 'ChallengeOperationFailed' {
  switch (rejection.kind) {
    case 'InvalidProof':
      return 'ChallengeProofInvalid';
    case 'OperationFailed':
      return 'ChallengeOperationFailed';
  }
}

function challengeFailure(
  cause: unknown,
  invalidity: ChallengeInvalidity,
): Extract<
  WorkAccessChallengeObservation,
  { readonly kind: 'ChallengeRejected' | 'ChallengeUnavailable' }
> {
  if (
    cause instanceof IdentityFailure &&
    (cause.detail.kind === 'challenge-response-invalid' ||
      cause.detail.kind === 'keria-response-invalid')
  ) {
    return { kind: 'ChallengeRejected', reason: invalidity };
  }
  return { kind: 'ChallengeUnavailable', dependency: 'KERIA' };
}

export function issuerWorkAccessChallengeProof(
  issuerProof: AsynchronousIssuerChallengeProof,
  issuerRecipientAid: string,
): WorkAccessChallengeProof {
  const recipient = issuerAid(issuerRecipientAid);
  return {
    async issue() {
      try {
        return { kind: 'ChallengeIssued', words: [...(await issuerProof.createChallenge())] };
      } catch {
        return { kind: 'ChallengeUnavailable', dependency: 'KERIA' };
      }
    },

    async beginVerification(input): Promise<WorkAccessChallengeVerificationStart> {
      if (input.recipientAid !== recipient) {
        return recipientMismatch;
      }
      try {
        const reference = await issuerProof.startVerification({
          sourceAid: userAid(input.sourceAid),
          challengeWords: input.challengeWords,
        });
        return {
          kind: 'VerificationOperationStarted',
          operationName: reference.operationName,
        };
      } catch (cause) {
        return challengeFailure(cause, 'ChallengeProofInvalid');
      }
    },

    async observeVerification(input): Promise<WorkAccessChallengeObservation> {
      if (input.recipientAid !== recipient) {
        return recipientMismatch;
      }
      try {
        const observed = await issuerProof.observeVerification({
          operationName: input.operationName,
          sourceAid: userAid(input.sourceAid),
          challengeWords: input.challengeWords,
          responseSaid: challengeResponseSaid(input.responseSaid),
        });
        switch (observed.kind) {
          case 'Pending':
            return { kind: 'ChallengeVerificationPending' };
          case 'Verified':
            return { kind: 'ChallengeVerified' };
          case 'Rejected':
            return { kind: 'ChallengeRejected', reason: rejectionReason(observed.rejection) };
        }
      } catch (cause) {
        return challengeFailure(cause, 'ChallengeProofInvalid');
      }
    },

    async acknowledgeResponse(input): Promise<WorkAccessChallengeAcknowledgement> {
      try {
        await issuerProof.acknowledgeResponse({
          sourceAid: userAid(input.sourceAid),
          responseSaid: challengeResponseSaid(input.responseSaid),
        });
        return { kind: 'ChallengeAcknowledged' };
      } catch (cause) {
        return challengeFailure(cause, 'ChallengeAcknowledgementRejected');
      }
    },

    async cleanupVerification(operationName) {
      try {
        await issuerProof.cleanupVerification(operationName);
        return { kind: 'VerificationCleaned' };
      } catch {
        return { kind: 'ChallengeCleanupDeferred', dependency: 'KERIA' };
      }
    },
  };
}
