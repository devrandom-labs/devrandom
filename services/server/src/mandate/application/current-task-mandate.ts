import type { CurrentTaskMandate } from '@devrandom/domain';
import type { TaskProjection } from '@devrandom/protocol';

import type { Tasks } from '../../task/application/tasks.js';
import { inspectCurrentTaskMandate } from './mandate-acceptance.js';
import type { MandateAdmission } from './mandate-admission.js';
import type { MandatePresentations, StoredMandatePresentation } from './presentations.js';

export interface CurrentTaskMandateDependencies {
  readonly issuerAid: string;
  readonly tasks: Pick<Tasks, 'findById'>;
  readonly presentations: Pick<MandatePresentations, 'findByCredential'>;
  readonly admission: Pick<MandateAdmission, 'inspect'>;
}

export interface CurrentTaskMandateInput {
  readonly ownerAid: string;
  readonly taskId: string;
  readonly taskRevisionSaid: string;
  readonly harnessLineageId: string;
  readonly personalAgentAid: string;
  readonly taskMandateSaid: string;
  readonly observedAt: string;
}

export type CurrentTaskMandateAuthorization =
  | {
      readonly kind: 'CurrentTaskMandateAuthorized';
      readonly task: TaskProjection;
      readonly mandate: CurrentTaskMandate;
    }
  | { readonly kind: 'TaskNotFound' }
  | { readonly kind: 'TaskBindingRejected' }
  | { readonly kind: 'TaskMandateNotAdmitted' }
  | { readonly kind: 'TaskMandatePending' }
  | { readonly kind: 'TaskMandateNotYetValid' }
  | { readonly kind: 'TaskMandateExpired' }
  | { readonly kind: 'TaskMandateRevoked' }
  | { readonly kind: 'TaskMandateBindingRejected' }
  | {
      readonly kind: 'DependencyUnavailable';
      readonly dependency: 'HostedMongoDB' | 'Keria' | 'Witness';
    };

function presentationMatches(
  input: CurrentTaskMandateInput,
  stored: StoredMandatePresentation,
): boolean {
  const presentation = stored.presentation;
  const accepted = presentation.acceptedReference;
  return (
    presentation.binding.ownerAid === input.ownerAid &&
    presentation.binding.mandateKind === 'TaskMandate' &&
    presentation.binding.credentialSaid === input.taskMandateSaid &&
    presentation.state.kind === 'Admitted' &&
    presentation.state.credentialSaid === input.taskMandateSaid &&
    accepted !== null &&
    accepted.issueeAid === input.personalAgentAid &&
    accepted.taskId === input.taskId &&
    accepted.taskRevisionSaid === input.taskRevisionSaid
  );
}

export async function authorizeCurrentTaskMandate(
  input: CurrentTaskMandateInput,
  dependencies: CurrentTaskMandateDependencies,
): Promise<CurrentTaskMandateAuthorization> {
  const locatedTask = await dependencies.tasks.findById(input.ownerAid, input.taskId);
  if (locatedTask.kind !== 'TaskFound') {
    return locatedTask.kind === 'TaskNotFound' ? { kind: 'TaskNotFound' } : locatedTask;
  }
  if (
    locatedTask.task.revisionSaid !== input.taskRevisionSaid ||
    locatedTask.task.harnessLineageId !== input.harnessLineageId
  ) {
    return { kind: 'TaskBindingRejected' };
  }

  const locatedPresentation = await dependencies.presentations.findByCredential(
    input.ownerAid,
    input.taskMandateSaid,
  );
  if (locatedPresentation.kind === 'DependencyUnavailable') {
    return locatedPresentation;
  }
  if (locatedPresentation.kind === 'PresentationNotFound') {
    return { kind: 'TaskMandateNotAdmitted' };
  }
  const presentation = locatedPresentation.stored.presentation;
  if (presentation.state.kind === 'AwaitingGrant' || presentation.state.kind === 'Admitting') {
    return { kind: 'TaskMandatePending' };
  }
  if (!presentationMatches(input, locatedPresentation.stored)) {
    return { kind: 'TaskMandateBindingRejected' };
  }

  const inspected = await dependencies.admission.inspect({
    ownerAid: input.ownerAid,
    credentialSaid: input.taskMandateSaid,
    grantSaid: presentation.binding.grantSaid,
  });
  switch (inspected.kind) {
    case 'MandateGrantPending':
      return { kind: 'TaskMandatePending' };
    case 'MandateAdmissionForbidden':
      return { kind: 'TaskMandateRevoked' };
    case 'MandateAdmissionRejected':
      return { kind: 'TaskMandateBindingRejected' };
    case 'DependencyUnavailable':
      return inspected;
    case 'MandateAdmissionInspected':
      break;
  }

  const current = inspectCurrentTaskMandate({
    ownerAid: input.ownerAid,
    credentialSaid: input.taskMandateSaid,
    observedAt: input.observedAt,
    task: locatedTask.task,
    evidence: inspected.evidence,
    issuerAid: dependencies.issuerAid,
  });
  if (current.kind === 'CurrentTaskMandateRejected') {
    switch (current.outcome.kind) {
      case 'MandatePending':
        return { kind: 'TaskMandatePending' };
      case 'MandateForbidden':
        if (current.outcome.reason === 'MandateNotYetValid') {
          return { kind: 'TaskMandateNotYetValid' };
        }
        if (current.outcome.reason === 'MandateExpired') {
          return { kind: 'TaskMandateExpired' };
        }
        return { kind: 'TaskMandateRevoked' };
      case 'MandateRejected':
        return { kind: 'TaskMandateBindingRejected' };
      case 'DependencyUnavailable':
        return current.outcome;
    }
  }
  if (current.mandate.credential.issueeAid !== input.personalAgentAid) {
    return { kind: 'TaskMandateBindingRejected' };
  }
  return {
    kind: 'CurrentTaskMandateAuthorized',
    task: locatedTask.task,
    mandate: current.mandate,
  };
}
