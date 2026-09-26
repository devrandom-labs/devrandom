import type { CurrentPromotionMandate, CurrentTaskMandate } from '@devrandom/domain';
import type { TaskProjection } from '@devrandom/protocol';

import { inspectCurrentPromotionMandate, type MandateAcceptance } from './mandate-acceptance.js';
import type { MandateAdmission } from './mandate-admission.js';
import type {
  CurrentTaskMandateAuthorization,
  CurrentTaskMandateInput,
} from './current-task-mandate.js';
import type { MandatePresentations, StoredMandatePresentation } from './presentations.js';

export interface CurrentPromotionMandateInput extends CurrentTaskMandateInput {
  readonly governorAid: string;
  readonly promotionMandateSaid: string;
}

export interface CurrentPromotionMandateDependencies {
  readonly issuerAid: string;
  readonly currentTaskMandate: {
    authorize(input: CurrentTaskMandateInput): Promise<CurrentTaskMandateAuthorization>;
  };
  readonly presentations: Pick<MandatePresentations, 'findByCredential'>;
  readonly admission: Pick<MandateAdmission, 'inspect'>;
}

export type CurrentPromotionMandateAuthorization =
  | {
      readonly kind: 'CurrentPromotionMandateAuthorized';
      readonly task: TaskProjection;
      readonly taskMandate: CurrentTaskMandate;
      readonly promotionMandate: CurrentPromotionMandate;
    }
  | Exclude<CurrentTaskMandateAuthorization, { readonly kind: 'CurrentTaskMandateAuthorized' }>
  | { readonly kind: 'PromotionMandateNotAdmitted' }
  | { readonly kind: 'PromotionMandatePending' }
  | { readonly kind: 'PromotionMandateNotYetValid' }
  | { readonly kind: 'PromotionMandateExpired' }
  | { readonly kind: 'PromotionMandateRevoked' }
  | { readonly kind: 'PromotionMandateBindingRejected' };

function presentationMatches(
  input: CurrentPromotionMandateInput,
  stored: StoredMandatePresentation,
): boolean {
  const presentation = stored.presentation;
  const accepted = presentation.acceptedReference;
  return (
    presentation.binding.ownerAid === input.ownerAid &&
    presentation.binding.mandateKind === 'PromotionMandate' &&
    presentation.binding.credentialSaid === input.promotionMandateSaid &&
    presentation.state.kind === 'Admitted' &&
    presentation.state.credentialSaid === input.promotionMandateSaid &&
    accepted !== null &&
    accepted.issueeAid === input.governorAid &&
    accepted.taskId === input.taskId &&
    accepted.taskRevisionSaid === input.taskRevisionSaid
  );
}

function rejectedCurrentPromotion(
  outcome: Exclude<MandateAcceptance, { readonly kind: 'MandateAccepted' }>,
): CurrentPromotionMandateAuthorization {
  switch (outcome.kind) {
    case 'MandatePending':
      return { kind: 'PromotionMandatePending' };
    case 'MandateForbidden':
      if (outcome.reason === 'MandateNotYetValid') {
        return { kind: 'PromotionMandateNotYetValid' };
      }
      if (outcome.reason === 'MandateExpired') {
        return { kind: 'PromotionMandateExpired' };
      }
      return { kind: 'PromotionMandateRevoked' };
    case 'MandateRejected':
      return { kind: 'PromotionMandateBindingRejected' };
    case 'DependencyUnavailable':
      return outcome;
  }
}

export async function authorizeCurrentPromotionMandate(
  input: CurrentPromotionMandateInput,
  dependencies: CurrentPromotionMandateDependencies,
): Promise<CurrentPromotionMandateAuthorization> {
  const taskAuthorization = await dependencies.currentTaskMandate.authorize(input);
  if (taskAuthorization.kind !== 'CurrentTaskMandateAuthorized') {
    return taskAuthorization;
  }
  if (
    taskAuthorization.mandate.credential.issueeAid !== input.personalAgentAid ||
    input.personalAgentAid === input.governorAid
  ) {
    return { kind: 'PromotionMandateBindingRejected' };
  }
  const located = await dependencies.presentations.findByCredential(
    input.ownerAid,
    input.promotionMandateSaid,
  );
  if (located.kind === 'DependencyUnavailable') {
    return located;
  }
  if (located.kind === 'PresentationNotFound') {
    return { kind: 'PromotionMandateNotAdmitted' };
  }
  const presentation = located.stored.presentation;
  if (presentation.state.kind === 'AwaitingGrant' || presentation.state.kind === 'Admitting') {
    return { kind: 'PromotionMandatePending' };
  }
  if (!presentationMatches(input, located.stored)) {
    return { kind: 'PromotionMandateBindingRejected' };
  }
  const inspected = await dependencies.admission.inspect({
    ownerAid: input.ownerAid,
    credentialSaid: input.promotionMandateSaid,
    grantSaid: presentation.binding.grantSaid,
  });
  switch (inspected.kind) {
    case 'MandateGrantPending':
      return { kind: 'PromotionMandatePending' };
    case 'MandateAdmissionForbidden':
      return { kind: 'PromotionMandateRevoked' };
    case 'MandateAdmissionRejected':
      return { kind: 'PromotionMandateBindingRejected' };
    case 'DependencyUnavailable':
      return inspected;
    case 'MandateAdmissionInspected':
      break;
  }
  const current = inspectCurrentPromotionMandate({
    ownerAid: input.ownerAid,
    credentialSaid: input.promotionMandateSaid,
    observedAt: input.observedAt,
    task: taskAuthorization.task,
    taskMandate: taskAuthorization.mandate,
    evidence: inspected.evidence,
    issuerAid: dependencies.issuerAid,
  });
  if (current.kind === 'CurrentPromotionMandateRejected') {
    return rejectedCurrentPromotion(current.outcome);
  }
  if (current.mandate.credential.issueeAid !== input.governorAid) {
    return { kind: 'PromotionMandateBindingRejected' };
  }
  return {
    kind: 'CurrentPromotionMandateAuthorized',
    task: taskAuthorization.task,
    taskMandate: taskAuthorization.mandate,
    promotionMandate: current.mandate,
  };
}
