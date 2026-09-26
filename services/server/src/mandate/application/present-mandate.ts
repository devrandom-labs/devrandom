import {
  admitMandatePresentation,
  awaitMandateGrant,
  expireMandatePresentation,
  recordMandateAdmission,
  rejectMandatePresentation,
  type MandatePresentation,
  type MandatePresentationRejection,
  type MandatePresentationTransition,
} from '../domain/presentation.js';
import type { MandateAdmission } from './mandate-admission.js';
import type { MandatePresentations, StoredMandatePresentation } from './presentations.js';
import type { CurrentMandateUserCredential } from './user-credential.js';
import type { Tasks } from '../../task/application/tasks.js';
import { verifyMandateAcceptance } from './mandate-acceptance.js';

export interface PresentMandateDependencies {
  readonly presentations: MandatePresentations;
  readonly eligibility: CurrentMandateUserCredential;
  readonly admission: MandateAdmission;
  readonly tasks: Pick<Tasks, 'findById'>;
  readonly issuerAid: string;
  now(): string;
}

export interface PresentMandateInput {
  readonly authority: {
    readonly ownerAid: string;
    readonly userCredentialSaid: string;
    readonly grantExpiresAt: string;
  };
  readonly command: {
    readonly mandateKind: MandatePresentation['binding']['mandateKind'];
    readonly credentialSaid: string;
    readonly grantSaid: string;
  };
}

export type PresentMandateOutcome =
  | {
      readonly kind: 'MandatePresentationPending';
      readonly presentation: MandatePresentation;
    }
  | {
      readonly kind: 'MandatePresentationAdmitted';
      readonly presentation: MandatePresentation;
    }
  | { readonly kind: 'MandatePresentationRejected'; readonly reason: MandatePresentationRejection }
  | { readonly kind: 'MandatePresentationExpired'; readonly credentialSaid: string }
  | { readonly kind: 'MandatePresentationConflict'; readonly credentialSaid: string }
  | { readonly kind: 'MandatePresentationConcurrentUpdate' }
  | { readonly kind: 'MandatePresentationInvalid' }
  | { readonly kind: 'UserCredentialNotCurrent' }
  | {
      readonly kind: 'MandatePresentationForbidden';
      readonly reason: 'MandateNotYetValid' | 'MandateExpired' | 'MandateRevoked';
    }
  | {
      readonly kind: 'DependencyUnavailable';
      readonly dependency: 'HostedMongoDB' | 'Keria' | 'Witness';
    };

function terminalOutcome(presentation: MandatePresentation): PresentMandateOutcome | undefined {
  switch (presentation.state.kind) {
    case 'Admitted':
      return {
        kind: 'MandatePresentationAdmitted',
        presentation,
      };
    case 'Rejected':
      return { kind: 'MandatePresentationRejected', reason: presentation.state.reason };
    case 'Expired':
      return {
        kind: 'MandatePresentationExpired',
        credentialSaid: presentation.binding.credentialSaid,
      };
    case 'AwaitingGrant':
    case 'Admitting':
      return undefined;
  }
}

async function commitTransition(
  current: StoredMandatePresentation,
  transition: MandatePresentationTransition,
  presentations: MandatePresentations,
): Promise<StoredMandatePresentation | PresentMandateOutcome> {
  if (transition.kind === 'PresentationTransitionRejected') {
    return { kind: 'MandatePresentationInvalid' };
  }
  const commit = await presentations.commit(current, transition.presentation);
  switch (commit.kind) {
    case 'PresentationCommitted':
      return commit.stored;
    case 'PresentationConcurrentlyModified':
      return { kind: 'MandatePresentationConcurrentUpdate' };
    case 'DependencyUnavailable':
      return commit;
  }
}

function isPresentMandateOutcome(
  value: StoredMandatePresentation | PresentMandateOutcome,
): value is PresentMandateOutcome {
  return !('revision' in value);
}

async function expirePendingPresentation(
  current: StoredMandatePresentation,
  observedAt: string,
  presentations: MandatePresentations,
): Promise<PresentMandateOutcome> {
  const committed = await commitTransition(
    current,
    expireMandatePresentation(current.presentation, observedAt),
    presentations,
  );
  if (isPresentMandateOutcome(committed)) {
    return committed;
  }
  return {
    kind: 'MandatePresentationExpired',
    credentialSaid: committed.presentation.binding.credentialSaid,
  };
}

async function reconcileAdmission(
  current: StoredMandatePresentation,
  observedAt: string,
  dependencies: PresentMandateDependencies,
): Promise<PresentMandateOutcome> {
  const terminal = terminalOutcome(current.presentation);
  if (terminal !== undefined) {
    return terminal;
  }
  if (observedAt >= current.presentation.binding.expiresAt) {
    return expirePendingPresentation(current, observedAt, dependencies.presentations);
  }
  const binding = current.presentation.binding;
  if (current.presentation.state.kind === 'AwaitingGrant') {
    const inspection = await dependencies.admission.inspect({
      ownerAid: binding.ownerAid,
      credentialSaid: binding.credentialSaid,
      grantSaid: binding.grantSaid,
    });
    switch (inspection.kind) {
      case 'MandateGrantPending':
        return {
          kind: 'MandatePresentationPending',
          presentation: current.presentation,
        };
      case 'DependencyUnavailable':
        return inspection;
      case 'MandateAdmissionForbidden':
        return { kind: 'MandatePresentationForbidden', reason: inspection.reason };
      case 'MandateAdmissionRejected': {
        const committed = await commitTransition(
          current,
          rejectMandatePresentation(current.presentation, {
            reason: inspection.reason,
            observedAt,
          }),
          dependencies.presentations,
        );
        return isPresentMandateOutcome(committed)
          ? committed
          : { kind: 'MandatePresentationRejected', reason: inspection.reason };
      }
      case 'MandateAdmissionInspected':
        break;
    }
    const acceptance = await verifyMandateAcceptance(
      {
        ownerAid: binding.ownerAid,
        mandateKind: binding.mandateKind,
        credentialSaid: binding.credentialSaid,
        observedAt,
        evidence: inspection.evidence,
      },
      {
        issuerAid: dependencies.issuerAid,
        tasks: dependencies.tasks,
        presentations: dependencies.presentations,
        admission: dependencies.admission,
      },
    );
    switch (acceptance.kind) {
      case 'MandatePending':
        return {
          kind: 'MandatePresentationPending',
          presentation: current.presentation,
        };
      case 'DependencyUnavailable':
        return acceptance;
      case 'MandateForbidden':
        return { kind: 'MandatePresentationForbidden', reason: acceptance.reason };
      case 'MandateRejected': {
        const committed = await commitTransition(
          current,
          rejectMandatePresentation(current.presentation, {
            reason: acceptance.reason,
            observedAt,
          }),
          dependencies.presentations,
        );
        return isPresentMandateOutcome(committed)
          ? committed
          : { kind: 'MandatePresentationRejected', reason: acceptance.reason };
      }
      case 'MandateAccepted':
        break;
    }
    const started = await dependencies.admission.begin({
      ownerAid: binding.ownerAid,
      credentialSaid: binding.credentialSaid,
      grantSaid: binding.grantSaid,
      preparedAt: Date.parse(binding.requestedAt),
    });
    switch (started.kind) {
      case 'MandateGrantPending':
        return {
          kind: 'MandatePresentationPending',
          presentation: current.presentation,
        };
      case 'DependencyUnavailable':
        return started;
      case 'MandateAdmissionForbidden':
        return { kind: 'MandatePresentationForbidden', reason: started.reason };
      case 'MandateAdmissionRejected': {
        const committed = await commitTransition(
          current,
          rejectMandatePresentation(current.presentation, {
            reason: started.reason,
            observedAt,
          }),
          dependencies.presentations,
        );
        return isPresentMandateOutcome(committed)
          ? committed
          : { kind: 'MandatePresentationRejected', reason: started.reason };
      }
      case 'MandateAdmissionStarted': {
        const committed = await commitTransition(
          current,
          recordMandateAdmission(current.presentation, {
            operationName: started.operationName,
            observedAt,
          }),
          dependencies.presentations,
        );
        return isPresentMandateOutcome(committed)
          ? committed
          : {
              kind: 'MandatePresentationPending',
              presentation: committed.presentation,
            };
      }
    }
  }
  if (current.presentation.state.kind === 'Admitting') {
    const observed = await dependencies.admission.observe({
      ownerAid: binding.ownerAid,
      credentialSaid: binding.credentialSaid,
      grantSaid: binding.grantSaid,
      operationName: current.presentation.state.operationName,
    });
    switch (observed.kind) {
      case 'MandateGrantPending':
        return {
          kind: 'MandatePresentationPending',
          presentation: current.presentation,
        };
      case 'DependencyUnavailable':
        return observed;
      case 'MandateAdmissionForbidden':
        return { kind: 'MandatePresentationForbidden', reason: observed.reason };
      case 'MandateAdmissionPending':
        return {
          kind: 'MandatePresentationPending',
          presentation: current.presentation,
        };
      case 'MandateAdmissionRejected': {
        const committed = await commitTransition(
          current,
          rejectMandatePresentation(current.presentation, {
            reason: observed.reason,
            observedAt,
          }),
          dependencies.presentations,
        );
        return isPresentMandateOutcome(committed)
          ? committed
          : { kind: 'MandatePresentationRejected', reason: observed.reason };
      }
      case 'MandateAdmissionVerified': {
        const acceptance = await verifyMandateAcceptance(
          {
            ownerAid: binding.ownerAid,
            mandateKind: binding.mandateKind,
            credentialSaid: binding.credentialSaid,
            observedAt,
            evidence: observed.evidence,
          },
          {
            issuerAid: dependencies.issuerAid,
            tasks: dependencies.tasks,
            presentations: dependencies.presentations,
            admission: dependencies.admission,
          },
        );
        switch (acceptance.kind) {
          case 'MandatePending':
            return {
              kind: 'MandatePresentationPending',
              presentation: current.presentation,
            };
          case 'DependencyUnavailable':
            return acceptance;
          case 'MandateForbidden':
            return { kind: 'MandatePresentationForbidden', reason: acceptance.reason };
          case 'MandateRejected': {
            const rejected = await commitTransition(
              current,
              rejectMandatePresentation(current.presentation, {
                reason: acceptance.reason,
                observedAt,
              }),
              dependencies.presentations,
            );
            return isPresentMandateOutcome(rejected)
              ? rejected
              : { kind: 'MandatePresentationRejected', reason: acceptance.reason };
          }
          case 'MandateAccepted':
            break;
        }
        const committed = await commitTransition(
          current,
          admitMandatePresentation(current.presentation, {
            credentialSaid: observed.credentialSaid,
            admittedAt: observedAt,
            acceptedReference: acceptance.reference,
          }),
          dependencies.presentations,
        );
        if (isPresentMandateOutcome(committed)) {
          return committed;
        }
        const admitted = terminalOutcome(committed.presentation);
        return admitted ?? { kind: 'MandatePresentationInvalid' };
      }
    }
  }
  return { kind: 'MandatePresentationInvalid' };
}

export async function presentMandate(
  input: PresentMandateInput,
  dependencies: PresentMandateDependencies,
): Promise<PresentMandateOutcome> {
  const eligibility = await dependencies.eligibility.verify({
    ownerAid: input.authority.ownerAid,
    credentialSaid: input.authority.userCredentialSaid,
  });
  switch (eligibility.kind) {
    case 'UserCredentialNotCurrent':
      return eligibility;
    case 'DependencyUnavailable':
      return eligibility;
    case 'UserCredentialCurrent':
      break;
  }

  const reconciliation = await dependencies.presentations.reconcile(
    input.authority.ownerAid,
    input.command.credentialSaid,
    input.command.grantSaid,
  );
  let current: StoredMandatePresentation;
  switch (reconciliation.kind) {
    case 'ExistingPresentation':
      current = reconciliation.stored;
      break;
    case 'PresentationConflict':
      return {
        kind: 'MandatePresentationConflict',
        credentialSaid: input.command.credentialSaid,
      };
    case 'DependencyUnavailable':
      return reconciliation;
    case 'NoPresentation': {
      const requestedAt = dependencies.now();
      const opening = awaitMandateGrant({
        ownerAid: input.authority.ownerAid,
        userCredentialSaid: input.authority.userCredentialSaid,
        mandateKind: input.command.mandateKind,
        credentialSaid: input.command.credentialSaid,
        grantSaid: input.command.grantSaid,
        requestedAt,
        expiresAt: input.authority.grantExpiresAt,
      });
      if (opening.kind === 'PresentationOpeningRejected') {
        return opening.reason === 'DeadlineInvalid'
          ? {
              kind: 'MandatePresentationExpired',
              credentialSaid: input.command.credentialSaid,
            }
          : { kind: 'MandatePresentationInvalid' };
      }
      const creation = await dependencies.presentations.create(opening.presentation);
      switch (creation.kind) {
        case 'PresentationCreated':
        case 'ExistingPresentation':
          current = creation.stored;
          break;
        case 'PresentationConflict':
          return {
            kind: 'MandatePresentationConflict',
            credentialSaid: input.command.credentialSaid,
          };
        case 'DependencyUnavailable':
          return creation;
      }
      break;
    }
  }
  return reconcileAdmission(current, dependencies.now(), dependencies);
}
