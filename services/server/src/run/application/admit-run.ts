import { isDeepStrictEqual } from 'node:util';

import {
  acceptInitialSpecialization,
  createRun,
  effectiveRunBudget,
  type InitialSpecializationActivation,
  type InitialSpecializationAccepted,
  type RunPurpose,
} from '@devrandom/domain';
import {
  runAdmissionCommandFingerprint,
  projectRun,
  type BaselineHarnessProjection,
  type RunAdmissionCommand,
  type RunAdmissionPendingProjection,
  type RunAdmissionPayload,
  type RunProjection,
} from '@devrandom/protocol';

import type { CurrentMandateUserCredential } from '../../mandate/application/user-credential.js';
import type { AuthenticatedTaskOwner } from '../../task/application/tasks.js';
import type { CurrentRunMandates } from './run-authority.js';
import type { RunAdmissionReservations } from './run-admissions.js';
import type { Runs } from './runs.js';

export type RunAdmissionExchangeInspection =
  | { readonly kind: 'Pending' }
  | {
      readonly kind: 'Verified';
      readonly sourceAid: string;
      readonly payload: RunAdmissionPayload;
    }
  | {
      readonly kind: 'Rejected';
      readonly reason:
        | 'AdmissionExchangeMalformed'
        | 'AdmissionExchangeSaidMismatch'
        | 'AdmissionExchangeRouteMismatch'
        | 'AdmissionExchangeRecipientMismatch'
        | 'AdmissionExchangePayloadMismatch';
    }
  | { readonly kind: 'Unavailable'; readonly dependency: 'Keria' | 'Witness' };

export interface RunAdmissionExchanges {
  inspect(exchangeSaid: string): Promise<RunAdmissionExchangeInspection>;
}

export type AcceptedHarnessInspection =
  | {
      readonly kind: 'AcceptedHarnessFound';
      readonly projection: BaselineHarnessProjection;
      readonly activation: InitialSpecializationActivation;
    }
  | { readonly kind: 'HarnessNotFound' }
  | { readonly kind: 'DependencyUnavailable'; readonly dependency: 'HostedMongoDB' };

export interface AcceptedHarnesses {
  findAccepted(ownerAid: string, harnessRevisionSaid: string): Promise<AcceptedHarnessInspection>;
}

export interface AdmitRunDependencies {
  readonly currentUserCredential: CurrentMandateUserCredential;
  readonly reservations: RunAdmissionReservations;
  readonly exchange: RunAdmissionExchanges;
  readonly harnesses: AcceptedHarnesses;
  readonly currentMandates: CurrentRunMandates;
  readonly commitments: Pick<Runs, 'accept'>;
  now(): string;
  newRunId(): string;
  newEvidenceStreamId(): string;
}

export interface AdmitRunInput {
  readonly owner: AuthenticatedTaskOwner;
  readonly command: RunAdmissionCommand;
}

export type RunAdmissionRejection =
  | 'AdmissionExchangeMalformed'
  | 'AdmissionExchangeSaidMismatch'
  | 'AdmissionExchangeRouteMismatch'
  | 'AdmissionExchangeRecipientMismatch'
  | 'AdmissionExchangeSignerMismatch'
  | 'AdmissionExchangePayloadMismatch'
  | 'TaskBindingMismatch'
  | 'HarnessBindingMismatch'
  | 'RepositoryBindingMismatch'
  | 'MandateBindingMismatch'
  | 'BudgetRejected'
  | 'PrincipalConflict';

export type AdmitRunOutcome =
  | { readonly kind: 'RunCreated'; readonly projection: RunProjection }
  | { readonly kind: 'ExistingRun'; readonly projection: RunProjection }
  | {
      readonly kind: 'RunAdmissionExchangePending';
      readonly projection: RunAdmissionPendingProjection;
    }
  | { readonly kind: 'RunCommandConflict' }
  | { readonly kind: 'ExistingRunRequiresLaterResume'; readonly runId: string }
  | { readonly kind: 'RunAlreadyEnded'; readonly runId: string }
  | { readonly kind: 'InitialHarnessIncumbentConflict' }
  | { readonly kind: 'RunResourceNotFound'; readonly resource: 'Task' | 'HarnessRevision' }
  | {
      readonly kind: 'RunAdmissionForbidden';
      readonly reason:
        | 'UserCredentialNotCurrent'
        | 'TaskMandateNotAdmitted'
        | 'TaskMandatePending'
        | 'TaskMandateNotYetValid'
        | 'TaskMandateExpired'
        | 'TaskMandateRevoked'
        | 'TaskMandateBindingRejected'
        | 'PromotionMandateNotAdmitted'
        | 'PromotionMandatePending'
        | 'PromotionMandateNotYetValid'
        | 'PromotionMandateExpired'
        | 'PromotionMandateRevoked'
        | 'PromotionMandateBindingRejected';
    }
  | { readonly kind: 'RunAdmissionRejected'; readonly reason: RunAdmissionRejection }
  | { readonly kind: 'RunCapacityExceeded'; readonly scope: 'Owner' | 'Global' }
  | { readonly kind: 'ConcurrentRunAdmission' }
  | {
      readonly kind: 'DependencyUnavailable';
      readonly dependency: 'HostedMongoDB' | 'Keria' | 'Witness';
    };

function pending(command: RunAdmissionCommand): RunAdmissionPendingProjection {
  return {
    version: 1,
    disposition: 'RunAdmissionExchangePending',
    commandId: command.commandId,
    admissionExchangeSaid: command.admissionExchangeSaid,
  };
}

function authorityFailure(
  kind: Exclude<
    Awaited<ReturnType<CurrentRunMandates['authorize']>>['kind'],
    'CurrentRunMandatesAuthorized'
  >,
): AdmitRunOutcome {
  switch (kind) {
    case 'TaskNotFound':
      return { kind: 'RunResourceNotFound', resource: 'Task' };
    case 'TaskBindingRejected':
      return { kind: 'RunAdmissionRejected', reason: 'TaskBindingMismatch' };
    case 'DependencyUnavailable':
      return { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' };
    case 'TaskMandateNotAdmitted':
    case 'TaskMandatePending':
    case 'TaskMandateNotYetValid':
    case 'TaskMandateExpired':
    case 'TaskMandateRevoked':
    case 'TaskMandateBindingRejected':
    case 'PromotionMandateNotAdmitted':
    case 'PromotionMandatePending':
    case 'PromotionMandateNotYetValid':
    case 'PromotionMandateExpired':
    case 'PromotionMandateRevoked':
    case 'PromotionMandateBindingRejected':
      return { kind: 'RunAdmissionForbidden', reason: kind };
  }
}

function bindingRejection(
  payload: RunAdmissionPayload,
  sourceAid: string,
  harness: BaselineHarnessProjection,
): RunAdmissionRejection | undefined {
  const revision = harness.revision;
  if (
    payload.taskId !== revision.task.taskId ||
    payload.taskRevisionSaid !== revision.task.revisionSaid ||
    payload.harnessLineageId !== revision.task.harnessLineageId
  ) {
    return 'TaskBindingMismatch';
  }
  if (payload.harnessRevisionSaid !== revision.d) {
    return 'HarnessBindingMismatch';
  }
  if (
    !isDeepStrictEqual(payload.repository, {
      objectFormat: revision.repository.objectFormat,
      commit: revision.repository.commit,
      tree: revision.repository.tree,
    })
  ) {
    return 'RepositoryBindingMismatch';
  }
  if (sourceAid !== revision.authority.personalAgentAid) {
    return 'AdmissionExchangeSignerMismatch';
  }
  if (payload.taskMandateSaid !== revision.authority.taskMandateSaid) {
    return 'MandateBindingMismatch';
  }
  return undefined;
}

function initialSpecialization(
  current: InitialSpecializationActivation,
  purpose: RunPurpose,
  runId: string,
  acceptedAt: string,
): InitialSpecializationAccepted | undefined {
  const accepted = acceptInitialSpecialization(current, {
    harnessLineageId: current.harnessLineageId,
    harnessRevisionSaid: current.harnessRevisionSaid,
    runId,
    acceptedAt,
    purpose,
  });
  switch (accepted.kind) {
    case 'Accepted':
    case 'Equivalent':
    case 'IncumbentConfirmed':
      return accepted.activation;
    case 'InitialCalibrationRequired':
    case 'HarnessBindingConflict':
    case 'IncumbentConflict':
      return undefined;
  }
}

function commitmentOutcome(outcome: Awaited<ReturnType<Runs['accept']>>): AdmitRunOutcome {
  switch (outcome.kind) {
    case 'RunCommitted':
      return { kind: 'RunCreated', projection: projectRun(outcome.run) };
    case 'ExistingRun':
      return { kind: 'ExistingRun', projection: projectRun(outcome.run) };
    case 'RunCommandConflict':
    case 'ExistingRunRequiresLaterResume':
    case 'RunAlreadyEnded':
    case 'InitialHarnessIncumbentConflict':
    case 'ConcurrentRunAdmission':
    case 'DependencyUnavailable':
      return outcome;
    case 'OwnerRunCapacityExceeded':
      return { kind: 'RunCapacityExceeded', scope: 'Owner' };
    case 'GlobalRunCapacityExceeded':
      return { kind: 'RunCapacityExceeded', scope: 'Global' };
  }
}

export async function admitRun(
  input: AdmitRunInput,
  dependencies: AdmitRunDependencies,
): Promise<AdmitRunOutcome> {
  const userCredential = await dependencies.currentUserCredential.verify({
    ownerAid: input.owner.ownerAid,
    credentialSaid: input.owner.credentialSaid,
  });
  if (userCredential.kind === 'DependencyUnavailable') {
    return userCredential;
  }
  if (userCredential.kind === 'UserCredentialNotCurrent') {
    return { kind: 'RunAdmissionForbidden', reason: 'UserCredentialNotCurrent' };
  }
  const commandFingerprint = runAdmissionCommandFingerprint(input.command);
  const reservedAt = dependencies.now();
  const reservation = await dependencies.reservations.reserve({
    ownerAid: input.owner.ownerAid,
    commandId: input.command.commandId,
    commandFingerprint,
    admissionExchangeSaid: input.command.admissionExchangeSaid,
    reservedAt,
  });
  switch (reservation.kind) {
    case 'AcceptedRunAdmission':
      return { kind: 'ExistingRun', projection: projectRun(reservation.run) };
    case 'RunCommandConflict':
    case 'DependencyUnavailable':
      return reservation;
    case 'RunAdmissionReserved':
      break;
  }
  const exchange = await dependencies.exchange.inspect(input.command.admissionExchangeSaid);
  switch (exchange.kind) {
    case 'Pending':
      return { kind: 'RunAdmissionExchangePending', projection: pending(input.command) };
    case 'Rejected':
      return { kind: 'RunAdmissionRejected', reason: exchange.reason };
    case 'Unavailable':
      return { kind: 'DependencyUnavailable', dependency: exchange.dependency };
    case 'Verified':
      break;
  }
  if (exchange.payload.commandId !== input.command.commandId) {
    return { kind: 'RunAdmissionRejected', reason: 'AdmissionExchangePayloadMismatch' };
  }
  const harness = await dependencies.harnesses.findAccepted(
    input.owner.ownerAid,
    exchange.payload.harnessRevisionSaid,
  );
  if (harness.kind === 'HarnessNotFound') {
    return { kind: 'RunResourceNotFound', resource: 'HarnessRevision' };
  }
  if (harness.kind === 'DependencyUnavailable') {
    return harness;
  }
  const rejectedBinding = bindingRejection(
    exchange.payload,
    exchange.sourceAid,
    harness.projection,
  );
  if (rejectedBinding !== undefined) {
    return { kind: 'RunAdmissionRejected', reason: rejectedBinding };
  }
  const acceptedAt = dependencies.now();
  const mandateAuthorization = await dependencies.currentMandates.authorize({
    ownerAid: input.owner.ownerAid,
    taskId: exchange.payload.taskId,
    taskRevisionSaid: exchange.payload.taskRevisionSaid,
    harnessLineageId: exchange.payload.harnessLineageId,
    personalAgentAid: exchange.sourceAid,
    taskMandateSaid: exchange.payload.taskMandateSaid,
    governorAid: exchange.payload.governorAid,
    promotionMandateSaid: exchange.payload.promotionMandateSaid,
    observedAt: acceptedAt,
  });
  if (mandateAuthorization.kind !== 'CurrentRunMandatesAuthorized') {
    return mandateAuthorization.kind === 'DependencyUnavailable'
      ? mandateAuthorization
      : authorityFailure(mandateAuthorization.kind);
  }
  if (
    mandateAuthorization.task.ownerAid !== input.owner.ownerAid ||
    mandateAuthorization.task.revisionSaid !== exchange.payload.taskRevisionSaid
  ) {
    return { kind: 'RunAdmissionRejected', reason: 'TaskBindingMismatch' };
  }
  if (
    mandateAuthorization.personalAgentAid !== exchange.sourceAid ||
    mandateAuthorization.taskMandateSaid !== exchange.payload.taskMandateSaid ||
    mandateAuthorization.governorAid !== exchange.payload.governorAid ||
    mandateAuthorization.promotionMandateSaid !== exchange.payload.promotionMandateSaid
  ) {
    return { kind: 'RunAdmissionRejected', reason: 'MandateBindingMismatch' };
  }
  const budget = effectiveRunBudget({
    requested: exchange.payload.requestedBudget,
    task: mandateAuthorization.task.revision.budgets,
    server: harness.projection.revision.budgetCeilings.server,
    mandate: mandateAuthorization.taskMandateBudget,
  });
  const runId = dependencies.newRunId();
  const activation = initialSpecialization(
    harness.activation,
    exchange.payload.purpose,
    runId,
    acceptedAt,
  );
  if (activation === undefined) {
    return { kind: 'InitialHarnessIncumbentConflict' };
  }
  const created = createRun({
    runId,
    ownerAid: input.owner.ownerAid,
    taskId: exchange.payload.taskId,
    taskRevisionSaid: exchange.payload.taskRevisionSaid,
    harnessLineageId: exchange.payload.harnessLineageId,
    personalAgentAid: exchange.sourceAid,
    taskMandateSaid: exchange.payload.taskMandateSaid,
    governorAid: exchange.payload.governorAid,
    promotionMandateSaid: exchange.payload.promotionMandateSaid,
    initialHarnessRevisionSaid: exchange.payload.harnessRevisionSaid,
    purpose: exchange.payload.purpose,
    initialSpecialization: activation,
    repository: exchange.payload.repository,
    commandId: input.command.commandId,
    admissionExchangeSaid: input.command.admissionExchangeSaid,
    evidenceStreamId: dependencies.newEvidenceStreamId(),
    budget,
    acceptedAt,
  });
  if (created.kind === 'Rejected') {
    if (created.reason === 'InitialSpecializationConflict') {
      return { kind: 'InitialHarnessIncumbentConflict' };
    }
    return {
      kind: 'RunAdmissionRejected',
      reason: created.reason === 'PrincipalConflict' ? 'PrincipalConflict' : 'BudgetRejected',
    };
  }
  return commitmentOutcome(
    await dependencies.commitments.accept({
      ownerAid: input.owner.ownerAid,
      commandId: input.command.commandId,
      commandFingerprint,
      run: created.run,
      activation,
    }),
  );
}
