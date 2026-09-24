export interface RegistrationBinding {
  readonly registrationId: string;
  readonly protocolVersion: string;
  readonly userAid: string;
  readonly userAgentOobi: string;
  readonly issuerAid: string;
  readonly challengeWords: readonly string[];
  readonly cliCapabilityHash: string;
  readonly browserCapabilityHash: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface AidProof {
  readonly registrationId: string;
  readonly sourceAid: string;
  readonly recipientAid: string;
  readonly challengeWords: readonly string[];
  readonly responseSaid: string;
  readonly acceptedAt: number;
}

interface AwaitingApproval {
  readonly kind: 'awaiting-approval';
}

interface ApprovalRecorded {
  readonly kind: 'approval-recorded';
  readonly contactEmail: string;
  readonly approvedAt: number;
}

type PendingProofApproval = AwaitingApproval | ApprovalRecorded;

interface AcceptedApproval {
  readonly contactEmail: string;
  readonly approvedAt: number;
}

export interface PendingProofRegistration {
  readonly kind: 'pending-proof';
  readonly binding: RegistrationBinding;
  readonly approval: PendingProofApproval;
}

export interface PendingApprovalRegistration {
  readonly kind: 'pending-approval';
  readonly binding: RegistrationBinding;
  readonly proof: AidProof;
}

export interface ApprovedRegistration {
  readonly kind: 'approved';
  readonly binding: RegistrationBinding;
  readonly proof: AidProof;
  readonly approval: AcceptedApproval;
}

interface PreparedIssuance {
  readonly kind: 'prepared';
  readonly issuedAt: number;
}

interface CredentialSubmittedIssuance {
  readonly kind: 'credential-submitted';
  readonly issuedAt: number;
  readonly credentialSaid: string;
  readonly operationName: string;
  readonly recordedAt: number;
}

interface CredentialVerifiedIssuance {
  readonly kind: 'credential-verified';
  readonly issuedAt: number;
  readonly credentialSaid: string;
  readonly credentialOperationName: string;
  readonly credentialSubmissionRecordedAt: number;
  readonly verifiedAt: number;
}

interface GrantPreparedIssuance {
  readonly kind: 'grant-prepared';
  readonly issuedAt: number;
  readonly credentialSaid: string;
  readonly credentialOperationName: string;
  readonly credentialSubmissionRecordedAt: number;
  readonly credentialVerifiedAt: number;
  readonly grantSaid: string;
  readonly preparedAt: number;
}

interface GrantSubmittedIssuance {
  readonly kind: 'grant-submitted';
  readonly issuedAt: number;
  readonly credentialSaid: string;
  readonly credentialOperationName: string;
  readonly credentialSubmissionRecordedAt: number;
  readonly credentialVerifiedAt: number;
  readonly grantSaid: string;
  readonly grantPreparedAt: number;
  readonly grantOperationName: string;
  readonly recordedAt: number;
}

export type IssuanceProgress =
  | PreparedIssuance
  | CredentialSubmittedIssuance
  | CredentialVerifiedIssuance
  | GrantPreparedIssuance
  | GrantSubmittedIssuance;

export interface IssuingRegistration {
  readonly kind: 'issuing';
  readonly binding: RegistrationBinding;
  readonly proof: AidProof;
  readonly approval: AcceptedApproval;
  readonly progress: IssuanceProgress;
}

export interface IssuedRegistration {
  readonly kind: 'issued';
  readonly binding: RegistrationBinding;
  readonly proof: AidProof;
  readonly approval: AcceptedApproval;
  readonly issuedAt: number;
  readonly credentialSaid: string;
  readonly credentialOperationName: string;
  readonly credentialSubmissionRecordedAt: number;
  readonly credentialVerifiedAt: number;
  readonly grantSaid: string;
  readonly grantPreparedAt: number;
  readonly grantOperationName: string;
  readonly grantSubmissionRecordedAt: number;
  readonly completedAt: number;
}

export type RegistrationRejection =
  | { readonly kind: 'browser-declined' }
  | { readonly kind: 'proof-rejected'; readonly reason: string }
  | { readonly kind: 'issuance-failed'; readonly reason: string };

export interface RejectedRegistration {
  readonly kind: 'rejected';
  readonly binding: RegistrationBinding;
  readonly rejection: RegistrationRejection;
  readonly rejectedAt: number;
}

export interface ExpiredRegistration {
  readonly kind: 'expired';
  readonly binding: RegistrationBinding;
  readonly expiredAt: number;
}

export type RegistrationSession =
  | PendingProofRegistration
  | PendingApprovalRegistration
  | ApprovedRegistration
  | IssuingRegistration
  | IssuedRegistration
  | RejectedRegistration
  | ExpiredRegistration;

export type RegistrationAction =
  | 'prove'
  | 'approve'
  | 'reject'
  | 'begin-issuance'
  | 'record-credential-submission'
  | 'record-credential-verification'
  | 'record-grant-preparation'
  | 'record-grant-submission'
  | 'complete-issuance';

export type ProofBindingField =
  'registrationId' | 'sourceAid' | 'recipientAid' | 'challengeWords' | 'responseSaid';

export type RegistrationCreationFailure =
  'invalid-interval' | 'capabilities-not-separated' | 'empty-binding';

export type RegistrationSessionError =
  | { readonly kind: 'invalid-creation'; readonly reason: RegistrationCreationFailure }
  | { readonly kind: 'invalid-time'; readonly action: RegistrationAction | 'observe' }
  | {
      readonly kind: 'time-regressed';
      readonly action: RegistrationAction;
      readonly earliestAllowedAt: number;
    }
  | { readonly kind: 'proof-mismatch'; readonly field: ProofBindingField }
  | { readonly kind: 'conflicting-retry'; readonly action: RegistrationAction }
  | {
      readonly kind: 'invalid-transition';
      readonly action: RegistrationAction;
      readonly state: RegistrationSession['kind'];
    };

export class RegistrationSessionFailure extends Error {
  readonly detail: RegistrationSessionError;

  constructor(detail: RegistrationSessionError) {
    super(registrationSessionErrorMessage(detail));
    this.name = 'RegistrationSessionFailure';
    this.detail = detail;
  }
}

export function createRegistrationSession(binding: RegistrationBinding): PendingProofRegistration {
  if (
    !nonEmpty(binding.registrationId) ||
    !nonEmpty(binding.protocolVersion) ||
    !nonEmpty(binding.userAid) ||
    !nonEmpty(binding.userAgentOobi) ||
    !nonEmpty(binding.issuerAid) ||
    binding.challengeWords.length === 0 ||
    binding.challengeWords.some((word) => !nonEmpty(word)) ||
    !nonEmpty(binding.cliCapabilityHash) ||
    !nonEmpty(binding.browserCapabilityHash)
  ) {
    throw new RegistrationSessionFailure({ kind: 'invalid-creation', reason: 'empty-binding' });
  }
  if (!validInstant(binding.createdAt) || !validInstant(binding.expiresAt)) {
    throw new RegistrationSessionFailure({ kind: 'invalid-creation', reason: 'invalid-interval' });
  }
  if (binding.expiresAt <= binding.createdAt) {
    throw new RegistrationSessionFailure({ kind: 'invalid-creation', reason: 'invalid-interval' });
  }
  if (binding.cliCapabilityHash === binding.browserCapabilityHash) {
    throw new RegistrationSessionFailure({
      kind: 'invalid-creation',
      reason: 'capabilities-not-separated',
    });
  }

  return {
    kind: 'pending-proof',
    binding: { ...binding, challengeWords: [...binding.challengeWords] },
    approval: { kind: 'awaiting-approval' },
  };
}

export function reconstructRegistrationSession(session: RegistrationSession): RegistrationSession {
  const pending = createRegistrationSession(session.binding);
  switch (session.kind) {
    case 'pending-proof':
      if (session.approval.kind === 'awaiting-approval') {
        return session;
      }
      requirePendingProof(
        approveRegistration(pending, {
          contactEmail: session.approval.contactEmail,
          approvedAt: session.approval.approvedAt,
        }),
        'approve',
      );
      return session;
    case 'pending-approval':
      requirePendingApproval(submitAidProof(pending, session.proof), 'prove');
      return session;
    case 'approved':
      reconstructApproval(pending, session.proof, session.approval);
      return session;
    case 'issuing':
      reconstructIssuance(
        reconstructApproval(pending, session.proof, session.approval),
        session.progress,
      );
      return session;
    case 'issued': {
      let issuing = requireIssuing(
        beginIssuance(reconstructApproval(pending, session.proof, session.approval), {
          issuedAt: session.issuedAt,
        }),
        'begin-issuance',
      );
      issuing = requireIssuing(
        recordCredentialSubmission(issuing, {
          credentialSaid: session.credentialSaid,
          operationName: session.credentialOperationName,
          recordedAt: session.credentialSubmissionRecordedAt,
        }),
        'record-credential-submission',
      );
      issuing = requireIssuing(
        recordCredentialVerification(issuing, {
          credentialSaid: session.credentialSaid,
          verifiedAt: session.credentialVerifiedAt,
        }),
        'record-credential-verification',
      );
      issuing = requireIssuing(
        recordGrantPreparation(issuing, {
          credentialSaid: session.credentialSaid,
          grantSaid: session.grantSaid,
          preparedAt: session.grantPreparedAt,
        }),
        'record-grant-preparation',
      );
      issuing = requireIssuing(
        recordGrantSubmission(issuing, {
          credentialSaid: session.credentialSaid,
          grantSaid: session.grantSaid,
          operationName: session.grantOperationName,
          recordedAt: session.grantSubmissionRecordedAt,
        }),
        'record-grant-submission',
      );
      requireIssued(
        completeIssuance(issuing, {
          credentialSaid: session.credentialSaid,
          grantSaid: session.grantSaid,
          completedAt: session.completedAt,
        }),
      );
      return session;
    }
    case 'rejected':
      requireRejected(
        rejectRegistration(pending, {
          rejection: session.rejection,
          rejectedAt: session.rejectedAt,
        }),
      );
      return session;
    case 'expired': {
      const expired = observeRegistrationSession(pending, session.expiredAt);
      if (expired.kind !== 'expired' || expired.expiredAt !== session.expiredAt) {
        invalidTransition('reject', session.kind);
      }
      return session;
    }
  }
}

export function observeRegistrationSession(
  session: RegistrationSession,
  observedAt: number,
): RegistrationSession {
  requireInstant(observedAt, 'observe');
  if (session.kind === 'issued' || session.kind === 'rejected' || session.kind === 'expired') {
    return session;
  }
  if (observedAt >= session.binding.expiresAt) {
    return {
      kind: 'expired',
      binding: session.binding,
      expiredAt: session.binding.expiresAt,
    };
  }
  return session;
}

export function submitAidProof(session: RegistrationSession, proof: AidProof): RegistrationSession {
  requireTransitionTime(session, proof.acceptedAt, 'prove');
  const current = observeRegistrationSession(session, proof.acceptedAt);
  if (current.kind === 'expired') {
    return current;
  }

  const mismatch = proofBindingMismatch(current.binding, proof);
  if (mismatch !== undefined) {
    throw new RegistrationSessionFailure({ kind: 'proof-mismatch', field: mismatch });
  }
  if (!nonEmpty(proof.responseSaid)) {
    throw new RegistrationSessionFailure({ kind: 'proof-mismatch', field: 'responseSaid' });
  }

  switch (current.kind) {
    case 'pending-proof': {
      const acceptedProof = { ...proof, challengeWords: [...proof.challengeWords] };
      if (current.approval.kind === 'awaiting-approval') {
        return {
          kind: 'pending-approval',
          binding: current.binding,
          proof: acceptedProof,
        };
      }
      return {
        kind: 'approved',
        binding: current.binding,
        proof: acceptedProof,
        approval: acceptedApproval(current.approval),
      };
    }
    case 'pending-approval':
    case 'approved':
    case 'issuing':
    case 'issued':
      if (sameProof(current.proof, proof)) {
        return current;
      }
      return conflictingRetry('prove');
    case 'rejected':
      return invalidTransition('prove', current.kind);
  }
}

export interface ApproveRegistration {
  readonly contactEmail: string;
  readonly approvedAt: number;
}

export function approveRegistration(
  session: RegistrationSession,
  approval: ApproveRegistration,
): RegistrationSession {
  requireTransitionTime(session, approval.approvedAt, 'approve');
  const current = observeRegistrationSession(session, approval.approvedAt);
  if (current.kind === 'expired') {
    return current;
  }
  if (!nonEmpty(approval.contactEmail)) {
    return conflictingRetry('approve');
  }

  switch (current.kind) {
    case 'pending-proof': {
      if (current.approval.kind === 'awaiting-approval') {
        return {
          ...current,
          approval: {
            kind: 'approval-recorded',
            contactEmail: approval.contactEmail,
            approvedAt: approval.approvedAt,
          },
        };
      }
      if (current.approval.contactEmail === approval.contactEmail) {
        return current;
      }
      return conflictingRetry('approve');
    }
    case 'pending-approval':
      return {
        kind: 'approved',
        binding: current.binding,
        proof: current.proof,
        approval,
      };
    case 'approved':
    case 'issuing':
    case 'issued':
      if (current.approval.contactEmail === approval.contactEmail) {
        return current;
      }
      return conflictingRetry('approve');
    case 'rejected':
      return invalidTransition('approve', current.kind);
  }
}

export interface RejectRegistration {
  readonly rejection: RegistrationRejection;
  readonly rejectedAt: number;
}

export function rejectRegistration(
  session: RegistrationSession,
  command: RejectRegistration,
): RegistrationSession {
  requireTransitionTime(session, command.rejectedAt, 'reject');
  const current = observeRegistrationSession(session, command.rejectedAt);
  if (current.kind === 'expired') {
    return current;
  }
  if (current.kind === 'issued') {
    return invalidTransition('reject', current.kind);
  }
  if (current.kind === 'rejected') {
    if (sameRejection(current.rejection, command.rejection)) {
      return current;
    }
    return conflictingRetry('reject');
  }

  return {
    kind: 'rejected',
    binding: current.binding,
    rejection: command.rejection,
    rejectedAt: command.rejectedAt,
  };
}

export interface BeginIssuance {
  readonly issuedAt: number;
}

export function beginIssuance(
  session: RegistrationSession,
  command: BeginIssuance,
): RegistrationSession {
  requireTransitionTime(session, command.issuedAt, 'begin-issuance');
  const current = observeRegistrationSession(session, command.issuedAt);
  if (current.kind === 'expired') {
    return current;
  }
  if (current.kind === 'approved') {
    return {
      kind: 'issuing',
      binding: current.binding,
      proof: current.proof,
      approval: current.approval,
      progress: { kind: 'prepared', issuedAt: command.issuedAt },
    };
  }
  if (current.kind === 'issuing' || current.kind === 'issued') {
    const issuedAt = current.kind === 'issuing' ? current.progress.issuedAt : current.issuedAt;
    if (issuedAt === command.issuedAt) {
      return current;
    }
    return conflictingRetry('begin-issuance');
  }
  return invalidTransition('begin-issuance', current.kind);
}

export interface RecordCredentialSubmission {
  readonly credentialSaid: string;
  readonly operationName: string;
  readonly recordedAt: number;
}

export function recordCredentialSubmission(
  session: RegistrationSession,
  command: RecordCredentialSubmission,
): RegistrationSession {
  const current = issuingAt(session, command.recordedAt, 'record-credential-submission');
  if (current.kind !== 'issuing') {
    return current;
  }
  if (current.progress.kind === 'prepared') {
    requireNonEmptyIssuanceValues(
      command.credentialSaid,
      command.operationName,
      'record-credential-submission',
    );
    return {
      ...current,
      progress: {
        kind: 'credential-submitted',
        issuedAt: current.progress.issuedAt,
        credentialSaid: command.credentialSaid,
        operationName: command.operationName,
        recordedAt: command.recordedAt,
      },
    };
  }
  if (sameCredentialSubmission(current.progress, command)) {
    return current;
  }
  return conflictingRetry('record-credential-submission');
}

export interface RecordCredentialVerification {
  readonly credentialSaid: string;
  readonly verifiedAt: number;
}

export function recordCredentialVerification(
  session: RegistrationSession,
  command: RecordCredentialVerification,
): RegistrationSession {
  const current = issuingAt(session, command.verifiedAt, 'record-credential-verification');
  if (current.kind !== 'issuing') {
    return current;
  }
  switch (current.progress.kind) {
    case 'credential-submitted':
      if (current.progress.credentialSaid !== command.credentialSaid) {
        return conflictingRetry('record-credential-verification');
      }
      return {
        ...current,
        progress: {
          kind: 'credential-verified',
          issuedAt: current.progress.issuedAt,
          credentialSaid: current.progress.credentialSaid,
          credentialOperationName: current.progress.operationName,
          credentialSubmissionRecordedAt: current.progress.recordedAt,
          verifiedAt: command.verifiedAt,
        },
      };
    case 'credential-verified':
    case 'grant-prepared':
    case 'grant-submitted':
      if (current.progress.credentialSaid === command.credentialSaid) {
        return current;
      }
      return conflictingRetry('record-credential-verification');
    case 'prepared':
      return invalidTransition('record-credential-verification', current.kind);
  }
}

export interface RecordGrantPreparation {
  readonly credentialSaid: string;
  readonly grantSaid: string;
  readonly preparedAt: number;
}

export function recordGrantPreparation(
  session: RegistrationSession,
  command: RecordGrantPreparation,
): RegistrationSession {
  const current = issuingAt(session, command.preparedAt, 'record-grant-preparation');
  if (current.kind !== 'issuing') {
    return current;
  }
  switch (current.progress.kind) {
    case 'credential-verified':
      if (
        current.progress.credentialSaid !== command.credentialSaid ||
        !nonEmpty(command.grantSaid)
      ) {
        return conflictingRetry('record-grant-preparation');
      }
      return {
        ...current,
        progress: {
          kind: 'grant-prepared',
          issuedAt: current.progress.issuedAt,
          credentialSaid: current.progress.credentialSaid,
          credentialOperationName: current.progress.credentialOperationName,
          credentialSubmissionRecordedAt: current.progress.credentialSubmissionRecordedAt,
          credentialVerifiedAt: current.progress.verifiedAt,
          grantSaid: command.grantSaid,
          preparedAt: command.preparedAt,
        },
      };
    case 'grant-prepared':
    case 'grant-submitted':
      if (
        current.progress.credentialSaid === command.credentialSaid &&
        current.progress.grantSaid === command.grantSaid
      ) {
        return current;
      }
      return conflictingRetry('record-grant-preparation');
    case 'prepared':
    case 'credential-submitted':
      return invalidTransition('record-grant-preparation', current.kind);
  }
}

export interface RecordGrantSubmission {
  readonly credentialSaid: string;
  readonly grantSaid: string;
  readonly operationName: string;
  readonly recordedAt: number;
}

export function recordGrantSubmission(
  session: RegistrationSession,
  command: RecordGrantSubmission,
): RegistrationSession {
  const current = issuingAt(session, command.recordedAt, 'record-grant-submission');
  if (current.kind !== 'issuing') {
    return current;
  }
  switch (current.progress.kind) {
    case 'grant-prepared':
      if (
        current.progress.credentialSaid !== command.credentialSaid ||
        current.progress.grantSaid !== command.grantSaid ||
        !nonEmpty(command.operationName)
      ) {
        return conflictingRetry('record-grant-submission');
      }
      return {
        ...current,
        progress: {
          kind: 'grant-submitted',
          issuedAt: current.progress.issuedAt,
          credentialSaid: current.progress.credentialSaid,
          credentialOperationName: current.progress.credentialOperationName,
          credentialSubmissionRecordedAt: current.progress.credentialSubmissionRecordedAt,
          credentialVerifiedAt: current.progress.credentialVerifiedAt,
          grantSaid: current.progress.grantSaid,
          grantPreparedAt: current.progress.preparedAt,
          grantOperationName: command.operationName,
          recordedAt: command.recordedAt,
        },
      };
    case 'grant-submitted':
      if (
        current.progress.credentialSaid === command.credentialSaid &&
        current.progress.grantSaid === command.grantSaid &&
        current.progress.grantOperationName === command.operationName
      ) {
        return current;
      }
      return conflictingRetry('record-grant-submission');
    case 'prepared':
    case 'credential-submitted':
    case 'credential-verified':
      return invalidTransition('record-grant-submission', current.kind);
  }
}

export interface CompleteIssuance {
  readonly credentialSaid: string;
  readonly grantSaid: string;
  readonly completedAt: number;
}

export function completeIssuance(
  session: RegistrationSession,
  command: CompleteIssuance,
): RegistrationSession {
  requireTransitionTime(session, command.completedAt, 'complete-issuance');
  const current = observeRegistrationSession(session, command.completedAt);
  if (current.kind === 'expired') {
    return current;
  }
  if (current.kind === 'issued') {
    if (
      current.credentialSaid === command.credentialSaid &&
      current.grantSaid === command.grantSaid
    ) {
      return current;
    }
    return conflictingRetry('complete-issuance');
  }
  if (current.kind !== 'issuing') {
    return invalidTransition('complete-issuance', current.kind);
  }
  if (current.progress.kind !== 'grant-submitted') {
    return invalidTransition('complete-issuance', current.kind);
  }
  if (
    current.progress.credentialSaid !== command.credentialSaid ||
    current.progress.grantSaid !== command.grantSaid
  ) {
    return conflictingRetry('complete-issuance');
  }

  return {
    kind: 'issued',
    binding: current.binding,
    proof: current.proof,
    approval: current.approval,
    issuedAt: current.progress.issuedAt,
    credentialSaid: current.progress.credentialSaid,
    credentialOperationName: current.progress.credentialOperationName,
    credentialSubmissionRecordedAt: current.progress.credentialSubmissionRecordedAt,
    credentialVerifiedAt: current.progress.credentialVerifiedAt,
    grantSaid: current.progress.grantSaid,
    grantPreparedAt: current.progress.grantPreparedAt,
    grantOperationName: current.progress.grantOperationName,
    grantSubmissionRecordedAt: current.progress.recordedAt,
    completedAt: command.completedAt,
  };
}

function reconstructApproval(
  pending: PendingProofRegistration,
  proof: AidProof,
  approval: AcceptedApproval,
): ApprovedRegistration {
  let current: RegistrationSession = pending;
  if (approval.approvedAt < proof.acceptedAt) {
    current = approveRegistration(current, approval);
    current = submitAidProof(current, proof);
  } else {
    current = submitAidProof(current, proof);
    current = approveRegistration(current, approval);
  }
  return requireApproved(current, 'approve');
}

function reconstructIssuance(
  approved: ApprovedRegistration,
  progress: IssuanceProgress,
): IssuingRegistration {
  let current = requireIssuing(
    beginIssuance(approved, { issuedAt: progress.issuedAt }),
    'begin-issuance',
  );
  if (progress.kind === 'prepared') {
    return current;
  }

  const credentialOperationName =
    progress.kind === 'credential-submitted'
      ? progress.operationName
      : progress.credentialOperationName;
  const credentialSubmissionRecordedAt =
    progress.kind === 'credential-submitted'
      ? progress.recordedAt
      : progress.credentialSubmissionRecordedAt;
  current = requireIssuing(
    recordCredentialSubmission(current, {
      credentialSaid: progress.credentialSaid,
      operationName: credentialOperationName,
      recordedAt: credentialSubmissionRecordedAt,
    }),
    'record-credential-submission',
  );
  if (progress.kind === 'credential-submitted') {
    return current;
  }

  const credentialVerifiedAt =
    progress.kind === 'credential-verified' ? progress.verifiedAt : progress.credentialVerifiedAt;
  current = requireIssuing(
    recordCredentialVerification(current, {
      credentialSaid: progress.credentialSaid,
      verifiedAt: credentialVerifiedAt,
    }),
    'record-credential-verification',
  );
  if (progress.kind === 'credential-verified') {
    return current;
  }

  const grantPreparedAt =
    progress.kind === 'grant-prepared' ? progress.preparedAt : progress.grantPreparedAt;
  current = requireIssuing(
    recordGrantPreparation(current, {
      credentialSaid: progress.credentialSaid,
      grantSaid: progress.grantSaid,
      preparedAt: grantPreparedAt,
    }),
    'record-grant-preparation',
  );
  if (progress.kind === 'grant-prepared') {
    return current;
  }

  return requireIssuing(
    recordGrantSubmission(current, {
      credentialSaid: progress.credentialSaid,
      grantSaid: progress.grantSaid,
      operationName: progress.grantOperationName,
      recordedAt: progress.recordedAt,
    }),
    'record-grant-submission',
  );
}

function requirePendingProof(
  session: RegistrationSession,
  action: RegistrationAction,
): PendingProofRegistration {
  if (session.kind !== 'pending-proof') {
    return invalidTransition(action, session.kind);
  }
  return session;
}

function requirePendingApproval(
  session: RegistrationSession,
  action: RegistrationAction,
): PendingApprovalRegistration {
  if (session.kind !== 'pending-approval') {
    return invalidTransition(action, session.kind);
  }
  return session;
}

function requireApproved(
  session: RegistrationSession,
  action: RegistrationAction,
): ApprovedRegistration {
  if (session.kind !== 'approved') {
    return invalidTransition(action, session.kind);
  }
  return session;
}

function requireIssuing(
  session: RegistrationSession,
  action: RegistrationAction,
): IssuingRegistration {
  if (session.kind !== 'issuing') {
    return invalidTransition(action, session.kind);
  }
  return session;
}

function requireIssued(session: RegistrationSession): IssuedRegistration {
  if (session.kind !== 'issued') {
    return invalidTransition('complete-issuance', session.kind);
  }
  return session;
}

function requireRejected(session: RegistrationSession): RejectedRegistration {
  if (session.kind !== 'rejected') {
    return invalidTransition('reject', session.kind);
  }
  return session;
}

function issuingAt(
  session: RegistrationSession,
  observedAt: number,
  action:
    | 'record-credential-submission'
    | 'record-credential-verification'
    | 'record-grant-preparation'
    | 'record-grant-submission',
): IssuingRegistration | ExpiredRegistration {
  requireTransitionTime(session, observedAt, action);
  const current = observeRegistrationSession(session, observedAt);
  if (current.kind === 'expired') {
    return current;
  }
  if (current.kind !== 'issuing') {
    return invalidTransition(action, current.kind);
  }
  return current;
}

function requireTransitionTime(
  session: RegistrationSession,
  observedAt: number,
  action: RegistrationAction,
): void {
  requireInstant(observedAt, action);
  const earliestAllowedAt = latestRecordedAt(session);
  if (observedAt < earliestAllowedAt) {
    throw new RegistrationSessionFailure({
      kind: 'time-regressed',
      action,
      earliestAllowedAt,
    });
  }
}

function latestRecordedAt(session: RegistrationSession): number {
  switch (session.kind) {
    case 'pending-proof':
      return session.approval.kind === 'approval-recorded'
        ? Math.max(session.binding.createdAt, session.approval.approvedAt)
        : session.binding.createdAt;
    case 'pending-approval':
      return Math.max(session.binding.createdAt, session.proof.acceptedAt);
    case 'approved':
      return Math.max(
        session.binding.createdAt,
        session.proof.acceptedAt,
        session.approval.approvedAt,
      );
    case 'issuing':
      return issuanceRecordedAt(session.progress);
    case 'issued':
      return session.completedAt;
    case 'rejected':
      return session.rejectedAt;
    case 'expired':
      return session.expiredAt;
  }
}

function issuanceRecordedAt(progress: IssuanceProgress): number {
  switch (progress.kind) {
    case 'prepared':
      return progress.issuedAt;
    case 'credential-submitted':
      return progress.recordedAt;
    case 'credential-verified':
      return progress.verifiedAt;
    case 'grant-prepared':
      return progress.preparedAt;
    case 'grant-submitted':
      return progress.recordedAt;
  }
}

function proofBindingMismatch(
  binding: RegistrationBinding,
  proof: AidProof,
): ProofBindingField | undefined {
  if (proof.registrationId !== binding.registrationId) {
    return 'registrationId';
  }
  if (proof.sourceAid !== binding.userAid) {
    return 'sourceAid';
  }
  if (proof.recipientAid !== binding.issuerAid) {
    return 'recipientAid';
  }
  if (!sameOrderedValues(proof.challengeWords, binding.challengeWords)) {
    return 'challengeWords';
  }
  return undefined;
}

function sameProof(left: AidProof, right: AidProof): boolean {
  return (
    left.registrationId === right.registrationId &&
    left.sourceAid === right.sourceAid &&
    left.recipientAid === right.recipientAid &&
    sameOrderedValues(left.challengeWords, right.challengeWords) &&
    left.responseSaid === right.responseSaid
  );
}

function sameCredentialSubmission(
  progress: Exclude<IssuanceProgress, PreparedIssuance>,
  command: RecordCredentialSubmission,
): boolean {
  switch (progress.kind) {
    case 'credential-submitted':
      return (
        progress.credentialSaid === command.credentialSaid &&
        progress.operationName === command.operationName
      );
    case 'credential-verified':
    case 'grant-prepared':
    case 'grant-submitted':
      return (
        progress.credentialSaid === command.credentialSaid &&
        progress.credentialOperationName === command.operationName
      );
  }
}

function sameRejection(left: RegistrationRejection, right: RegistrationRejection): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  switch (left.kind) {
    case 'browser-declined':
      return true;
    case 'proof-rejected':
      return right.kind === 'proof-rejected' && left.reason === right.reason;
    case 'issuance-failed':
      return right.kind === 'issuance-failed' && left.reason === right.reason;
  }
}

function acceptedApproval(approval: ApprovalRecorded): AcceptedApproval {
  return { contactEmail: approval.contactEmail, approvedAt: approval.approvedAt };
}

function sameOrderedValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function requireNonEmptyIssuanceValues(
  left: string,
  right: string,
  action: RegistrationAction,
): void {
  if (!nonEmpty(left) || !nonEmpty(right)) {
    conflictingRetry(action);
  }
}

function requireInstant(value: number, action: RegistrationAction | 'observe'): void {
  if (!validInstant(value)) {
    throw new RegistrationSessionFailure({ kind: 'invalid-time', action });
  }
}

function validInstant(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function nonEmpty(value: string): boolean {
  return value.length > 0;
}

function conflictingRetry(action: RegistrationAction): never {
  throw new RegistrationSessionFailure({ kind: 'conflicting-retry', action });
}

function invalidTransition(action: RegistrationAction, state: RegistrationSession['kind']): never {
  throw new RegistrationSessionFailure({ kind: 'invalid-transition', action, state });
}

function registrationSessionErrorMessage(error: RegistrationSessionError): string {
  switch (error.kind) {
    case 'invalid-creation':
      return `registration creation is invalid: ${error.reason}`;
    case 'invalid-time':
      return `${error.action} requires a non-negative integer timestamp`;
    case 'time-regressed':
      return `${error.action} cannot precede ${String(error.earliestAllowedAt)}`;
    case 'proof-mismatch':
      return `AID proof does not match registration ${error.field}`;
    case 'conflicting-retry':
      return `${error.action} conflicts with the recorded registration transition`;
    case 'invalid-transition':
      return `${error.action} is not lawful from ${error.state}`;
  }
}
