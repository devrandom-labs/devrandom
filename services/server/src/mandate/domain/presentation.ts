import type { CurrentPromotionMandate, CurrentTaskMandate } from '@devrandom/domain';

const keriIdentifier = /^[A-Z][A-Za-z0-9_-]{43}$/u;

export type MandateKind = CurrentTaskMandate['kind'] | CurrentPromotionMandate['kind'];

export interface MandatePresentationBinding {
  readonly ownerAid: string;
  readonly userCredentialSaid: string;
  readonly mandateKind: MandateKind;
  readonly credentialSaid: string;
  readonly grantSaid: string;
  readonly requestedAt: string;
  readonly expiresAt: string;
}

export const mandatePresentationRejectionValues = [
  'GrantEvidenceInvalid',
  'CredentialBindingInvalid',
  'ResourceBindingInvalid',
  'AuthorityCeilingInvalid',
  'IncompatibleCredentialState',
] as const;

export type MandatePresentationRejection = (typeof mandatePresentationRejectionValues)[number];

export type MandatePresentationState =
  | { readonly kind: 'AwaitingGrant' }
  | { readonly kind: 'Admitting'; readonly operationName: string }
  | {
      readonly kind: 'Admitted';
      readonly credentialSaid: string;
      readonly admittedAt: string;
    }
  | { readonly kind: 'Rejected'; readonly reason: MandatePresentationRejection }
  | { readonly kind: 'Expired' };

export interface AcceptedMandateReference {
  readonly issueeAid: string;
  readonly registryId: string;
  readonly taskId: string;
  readonly taskRevisionSaid: string;
}

export interface MandatePresentation {
  readonly version: 1;
  readonly binding: MandatePresentationBinding;
  readonly acceptedReference: AcceptedMandateReference | null;
  readonly state: MandatePresentationState;
}

export type MandatePresentationOpening =
  | { readonly kind: 'PresentationOpened'; readonly presentation: MandatePresentation }
  | { readonly kind: 'PresentationOpeningRejected'; readonly reason: 'BindingInvalid' }
  | { readonly kind: 'PresentationOpeningRejected'; readonly reason: 'DeadlineInvalid' };

export type MandatePresentationTransition =
  | { readonly kind: 'PresentationTransitioned'; readonly presentation: MandatePresentation }
  | {
      readonly kind: 'PresentationTransitionRejected';
      readonly reason:
        | 'CredentialConflict'
        | 'OperationInvalid'
        | 'OperationConflict'
        | 'PresentationActive'
        | 'PresentationExpired'
        | 'StateConflict'
        | 'TimeInvalid';
    };

function instant(value: string): number | undefined {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
    ? milliseconds
    : undefined;
}

function validBinding(binding: MandatePresentationBinding): boolean {
  return (
    keriIdentifier.test(binding.ownerAid) &&
    keriIdentifier.test(binding.userCredentialSaid) &&
    keriIdentifier.test(binding.credentialSaid) &&
    keriIdentifier.test(binding.grantSaid)
  );
}

function validAcceptedReference(reference: AcceptedMandateReference): boolean {
  return (
    keriIdentifier.test(reference.issueeAid) &&
    keriIdentifier.test(reference.registryId) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      reference.taskId,
    ) &&
    keriIdentifier.test(reference.taskRevisionSaid)
  );
}

function beforeExpiry(
  presentation: MandatePresentation,
  observedAt: string,
): 'BeforeExpiry' | 'Expired' | 'TimeInvalid' {
  const observed = instant(observedAt);
  const requested = instant(presentation.binding.requestedAt);
  const expires = instant(presentation.binding.expiresAt);
  if (observed === undefined || requested === undefined || expires === undefined) {
    return 'TimeInvalid';
  }
  if (observed < requested) {
    return 'TimeInvalid';
  }
  return observed < expires ? 'BeforeExpiry' : 'Expired';
}

export function awaitMandateGrant(binding: MandatePresentationBinding): MandatePresentationOpening {
  if (!validBinding(binding)) {
    return { kind: 'PresentationOpeningRejected', reason: 'BindingInvalid' };
  }
  const requestedAt = instant(binding.requestedAt);
  const expiresAt = instant(binding.expiresAt);
  if (requestedAt === undefined || expiresAt === undefined || expiresAt <= requestedAt) {
    return { kind: 'PresentationOpeningRejected', reason: 'DeadlineInvalid' };
  }
  return {
    kind: 'PresentationOpened',
    presentation: {
      version: 1,
      binding,
      acceptedReference: null,
      state: { kind: 'AwaitingGrant' },
    },
  };
}

export function reconstructMandatePresentation(
  binding: MandatePresentationBinding,
  state: MandatePresentationState,
  acceptedReference: AcceptedMandateReference | null = null,
): MandatePresentation | undefined {
  const opening = awaitMandateGrant(binding);
  if (opening.kind === 'PresentationOpeningRejected') {
    return undefined;
  }
  switch (state.kind) {
    case 'AwaitingGrant':
    case 'Rejected':
    case 'Expired':
      return acceptedReference === null ? { ...opening.presentation, state } : undefined;
    case 'Admitting':
      return acceptedReference === null &&
        state.operationName.length > 0 &&
        state.operationName.length <= 512
        ? { ...opening.presentation, state }
        : undefined;
    case 'Admitted':
      return state.credentialSaid === binding.credentialSaid &&
        acceptedReference !== null &&
        validAcceptedReference(acceptedReference) &&
        beforeExpiry(opening.presentation, state.admittedAt) === 'BeforeExpiry'
        ? { ...opening.presentation, acceptedReference, state }
        : undefined;
  }
}

export function recordMandateAdmission(
  current: MandatePresentation,
  input: { readonly operationName: string; readonly observedAt: string },
): MandatePresentationTransition {
  if (input.operationName.length === 0 || input.operationName.length > 512) {
    return { kind: 'PresentationTransitionRejected', reason: 'OperationInvalid' };
  }
  const expiry = beforeExpiry(current, input.observedAt);
  if (expiry !== 'BeforeExpiry') {
    return {
      kind: 'PresentationTransitionRejected',
      reason: expiry === 'Expired' ? 'PresentationExpired' : 'TimeInvalid',
    };
  }
  switch (current.state.kind) {
    case 'AwaitingGrant':
      return {
        kind: 'PresentationTransitioned',
        presentation: {
          ...current,
          state: { kind: 'Admitting', operationName: input.operationName },
        },
      };
    case 'Admitting':
      return current.state.operationName === input.operationName
        ? { kind: 'PresentationTransitioned', presentation: current }
        : { kind: 'PresentationTransitionRejected', reason: 'OperationConflict' };
    case 'Admitted':
    case 'Rejected':
    case 'Expired':
      return { kind: 'PresentationTransitionRejected', reason: 'StateConflict' };
  }
}

export function admitMandatePresentation(
  current: MandatePresentation,
  input: {
    readonly credentialSaid: string;
    readonly admittedAt: string;
    readonly acceptedReference: AcceptedMandateReference;
  },
): MandatePresentationTransition {
  if (input.credentialSaid !== current.binding.credentialSaid) {
    return { kind: 'PresentationTransitionRejected', reason: 'CredentialConflict' };
  }
  if (!validAcceptedReference(input.acceptedReference)) {
    return { kind: 'PresentationTransitionRejected', reason: 'CredentialConflict' };
  }
  const expiry = beforeExpiry(current, input.admittedAt);
  if (expiry !== 'BeforeExpiry') {
    return {
      kind: 'PresentationTransitionRejected',
      reason: expiry === 'Expired' ? 'PresentationExpired' : 'TimeInvalid',
    };
  }
  switch (current.state.kind) {
    case 'Admitting':
      return {
        kind: 'PresentationTransitioned',
        presentation: {
          ...current,
          acceptedReference: input.acceptedReference,
          state: {
            kind: 'Admitted',
            credentialSaid: input.credentialSaid,
            admittedAt: input.admittedAt,
          },
        },
      };
    case 'Admitted':
      return current.state.credentialSaid === input.credentialSaid &&
        current.state.admittedAt === input.admittedAt &&
        current.acceptedReference !== null &&
        current.acceptedReference.issueeAid === input.acceptedReference.issueeAid &&
        current.acceptedReference.registryId === input.acceptedReference.registryId &&
        current.acceptedReference.taskId === input.acceptedReference.taskId &&
        current.acceptedReference.taskRevisionSaid === input.acceptedReference.taskRevisionSaid
        ? { kind: 'PresentationTransitioned', presentation: current }
        : { kind: 'PresentationTransitionRejected', reason: 'CredentialConflict' };
    case 'AwaitingGrant':
    case 'Rejected':
    case 'Expired':
      return { kind: 'PresentationTransitionRejected', reason: 'StateConflict' };
  }
}

export function rejectMandatePresentation(
  current: MandatePresentation,
  input: { readonly reason: MandatePresentationRejection; readonly observedAt: string },
): MandatePresentationTransition {
  const expiry = beforeExpiry(current, input.observedAt);
  if (expiry !== 'BeforeExpiry') {
    return {
      kind: 'PresentationTransitionRejected',
      reason: expiry === 'Expired' ? 'PresentationExpired' : 'TimeInvalid',
    };
  }
  switch (current.state.kind) {
    case 'AwaitingGrant':
    case 'Admitting':
      return {
        kind: 'PresentationTransitioned',
        presentation: { ...current, state: { kind: 'Rejected', reason: input.reason } },
      };
    case 'Rejected':
      return current.state.reason === input.reason
        ? { kind: 'PresentationTransitioned', presentation: current }
        : { kind: 'PresentationTransitionRejected', reason: 'StateConflict' };
    case 'Admitted':
    case 'Expired':
      return { kind: 'PresentationTransitionRejected', reason: 'StateConflict' };
  }
}

export function expireMandatePresentation(
  current: MandatePresentation,
  observedAt: string,
): MandatePresentationTransition {
  const expiry = beforeExpiry(current, observedAt);
  if (expiry === 'TimeInvalid') {
    return { kind: 'PresentationTransitionRejected', reason: 'TimeInvalid' };
  }
  if (expiry === 'BeforeExpiry') {
    return { kind: 'PresentationTransitionRejected', reason: 'PresentationActive' };
  }
  switch (current.state.kind) {
    case 'AwaitingGrant':
    case 'Admitting':
      return {
        kind: 'PresentationTransitioned',
        presentation: { ...current, state: { kind: 'Expired' } },
      };
    case 'Expired':
      return { kind: 'PresentationTransitioned', presentation: current };
    case 'Admitted':
    case 'Rejected':
      return { kind: 'PresentationTransitionRejected', reason: 'StateConflict' };
  }
}
