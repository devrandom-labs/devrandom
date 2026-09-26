import {
  taskBudgetCeilings,
  verifyPromotionMandate,
  verifyTaskMandate,
  type CurrentTaskMandate,
  type CurrentPromotionMandate,
  type MandateInvalidity,
  type MandateTask,
  type PromotionMandateInspection,
} from '@devrandom/domain';
import {
  promotionMandateSchemaSaid,
  promotionMandateV2SchemaSaid,
  promotionMandateV3SchemaSaid,
  taskMandateSchemaSaid,
  taskMandateV2SchemaSaid,
  taskMandateV3SchemaSaid,
  promotionMandateV4SchemaSaid,
  promotionMandateV5SchemaSaid,
  type TaskProjection,
} from '@devrandom/protocol';

import type { Tasks } from '../../task/application/tasks.js';
import type {
  MandateAdmission,
  MandateGrantInspection,
  MandateInspection,
} from './mandate-admission.js';
import type { MandatePresentations } from './presentations.js';
import type {
  AcceptedMandateReference,
  MandateKind,
  MandatePresentationRejection,
} from '../domain/presentation.js';

export interface MandateAcceptanceDependencies {
  readonly issuerAid: string;
  readonly tasks: Pick<Tasks, 'findById'>;
  readonly presentations: Pick<MandatePresentations, 'findAdmittedTaskMandates'>;
  readonly admission: Pick<MandateAdmission, 'inspect'>;
}

export interface MandateAcceptanceInput {
  readonly ownerAid: string;
  readonly mandateKind: MandateKind;
  readonly credentialSaid: string;
  readonly observedAt: string;
  readonly evidence: MandateGrantInspection;
}

export type MandateAcceptance =
  | {
      readonly kind: 'MandateAccepted';
      readonly reference: AcceptedMandateReference;
    }
  | { readonly kind: 'MandatePending' }
  | { readonly kind: 'MandateRejected'; readonly reason: MandatePresentationRejection }
  | {
      readonly kind: 'MandateForbidden';
      readonly reason: 'MandateNotYetValid' | 'MandateExpired' | 'MandateRevoked';
    }
  | {
      readonly kind: 'DependencyUnavailable';
      readonly dependency: 'HostedMongoDB' | 'Keria' | 'Witness';
    };

type MandateAcceptanceFailure = Exclude<MandateAcceptance, { readonly kind: 'MandateAccepted' }>;

function mandateTask(task: TaskProjection): MandateTask {
  return {
    taskId: task.taskId,
    ownerAid: task.ownerAid,
    revisionSaid: task.revisionSaid,
    harnessLineageId: task.harnessLineageId,
    repository: task.revision.repository,
    requestedCapabilities: task.revision.requestedCapabilities,
    unavailableCapabilities: task.revision.unavailableCapabilities,
    budgets: task.revision.budgets,
    evolutionClasses: task.revision.evolutionClasses,
    expiresAt: task.revision.expiresAt,
    ...(task.revision.version === 2 ? { experience: task.revision.constraints.experience } : {}),
  };
}

function promotionSchemaSaid(task: TaskProjection, inspection: PromotionMandateInspection): string {
  if (task.revision.version !== 2) return promotionMandateSchemaSaid;
  const expanded =
    task.revision.budgets.runsPerAdmittedUser > taskBudgetCeilings.runsPerAdmittedUser;
  const exactSchema = expanded ? promotionMandateV5SchemaSaid : promotionMandateV3SchemaSaid;
  return inspection.credential.schemaSaid === exactSchema &&
    'evaluationManifestSaid' in inspection &&
    'requiredMetrics' in inspection &&
    'requiredChecks' in inspection &&
    'riskLimit' in inspection
    ? exactSchema
    : expanded
      ? promotionMandateV4SchemaSaid
      : promotionMandateV2SchemaSaid;
}

export type CurrentTaskMandateInspection =
  | {
      readonly kind: 'CurrentTaskMandate';
      readonly mandate: CurrentTaskMandate;
      readonly reference: AcceptedMandateReference;
    }
  | {
      readonly kind: 'CurrentTaskMandateRejected';
      readonly outcome: Exclude<MandateAcceptance, { readonly kind: 'MandateAccepted' }>;
    };

export type CurrentPromotionMandateInspection =
  | {
      readonly kind: 'CurrentPromotionMandate';
      readonly mandate: CurrentPromotionMandate;
      readonly reference: AcceptedMandateReference;
    }
  | {
      readonly kind: 'CurrentPromotionMandateRejected';
      readonly outcome: Exclude<MandateAcceptance, { readonly kind: 'MandateAccepted' }>;
    };

function rejected(reason: MandatePresentationRejection): MandateAcceptanceFailure {
  return { kind: 'MandateRejected', reason };
}

function mappedInvalidity(invalidity: MandateInvalidity): MandateAcceptanceFailure {
  switch (invalidity.kind) {
    case 'NotYetValid':
      return { kind: 'MandateForbidden', reason: 'MandateNotYetValid' };
    case 'Expired':
      return { kind: 'MandateForbidden', reason: 'MandateExpired' };
    case 'CredentialRevoked':
      return { kind: 'MandateForbidden', reason: 'MandateRevoked' };
    case 'IncompatibleCredentialState':
      return rejected('IncompatibleCredentialState');
    case 'UnexpectedTask':
    case 'UnexpectedTaskRevision':
    case 'UnexpectedHarnessLineage':
    case 'RepositoryBindingMismatch':
    case 'ExperienceScopeMismatch':
    case 'ExpiryMismatch':
      return rejected('ResourceBindingInvalid');
    case 'AuthorityMismatch':
    case 'DuplicateCapability':
    case 'CapabilityOutsideTask':
    case 'BudgetOutsideTask':
    case 'BudgetInvalid':
    case 'DuplicateEvolutionClass':
    case 'EvolutionClassOutsideTask':
    case 'CapabilityCeilingOutsideTaskMandate':
    case 'BudgetCeilingOutsideTaskMandate':
    case 'EvolutionClassCeilingOutsideTaskMandate':
    case 'EvidenceRequirementsMismatch':
      return rejected('AuthorityCeilingInvalid');
    case 'UnexpectedIssuer':
    case 'UnexpectedIssuee':
    case 'UnexpectedRegistry':
    case 'UnexpectedSchema':
    case 'UnexpectedCredentialSaid':
    case 'CredentialSaidMismatch':
    case 'AttributeSaidMismatch':
    case 'SchemaDocumentMismatch':
    case 'CredentialNotIssued':
    case 'IssuerAnchorMissing':
    case 'IssuerAnchorMismatch':
    case 'IssuanceTimeInvalid':
    case 'NotBeforeMismatch':
    case 'ObservationTimeInvalid':
      return rejected('CredentialBindingInvalid');
  }
}

function grantBindingInvalidity(
  input: MandateAcceptanceInput,
  inspection: MandateInspection,
  issuerAid: string,
): MandatePresentationRejection | undefined {
  const credential = inspection.value.credential;
  if (
    input.mandateKind !== inspection.kind ||
    input.credentialSaid !== credential.credentialSaid ||
    input.ownerAid !== credential.issuerAid
  ) {
    return 'CredentialBindingInvalid';
  }
  if (
    input.evidence.grantRecipientAid !== issuerAid ||
    input.evidence.grantSenderAid !== credential.issueeAid ||
    input.evidence.grantSenderAid === credential.issuerAid
  ) {
    return 'GrantEvidenceInvalid';
  }
  return undefined;
}

function reference(
  inspection: MandateInspection,
  grantSenderAid: string,
): AcceptedMandateReference {
  return {
    issueeAid: grantSenderAid,
    registryId: inspection.value.credential.registryId,
    taskId: inspection.value.taskId,
    taskRevisionSaid: inspection.value.taskRevisionSaid,
  };
}

export function inspectCurrentTaskMandate(input: {
  readonly ownerAid: string;
  readonly credentialSaid: string;
  readonly observedAt: string;
  readonly task: TaskProjection;
  readonly evidence: MandateGrantInspection;
  readonly issuerAid: string;
}): CurrentTaskMandateInspection {
  const acceptanceInput: MandateAcceptanceInput = {
    ownerAid: input.ownerAid,
    mandateKind: 'TaskMandate',
    credentialSaid: input.credentialSaid,
    observedAt: input.observedAt,
    evidence: input.evidence,
  };
  const bindingFailure = grantBindingInvalidity(
    acceptanceInput,
    input.evidence.inspection,
    input.issuerAid,
  );
  if (bindingFailure !== undefined || input.evidence.inspection.kind !== 'TaskMandate') {
    return {
      kind: 'CurrentTaskMandateRejected',
      outcome: rejected(bindingFailure ?? 'CredentialBindingInvalid'),
    };
  }
  const acceptedReference = reference(input.evidence.inspection, input.evidence.grantSenderAid);
  const verified = verifyTaskMandate(
    {
      credential: {
        issuerAid: input.ownerAid,
        issueeAid: acceptedReference.issueeAid,
        registryId: acceptedReference.registryId,
        schemaSaid:
          input.task.revision.version !== 2
            ? taskMandateSchemaSaid
            : input.task.revision.budgets.runsPerAdmittedUser >
                taskBudgetCeilings.runsPerAdmittedUser
              ? taskMandateV3SchemaSaid
              : taskMandateV2SchemaSaid,
        credentialSaid: input.credentialSaid,
      },
      task: mandateTask(input.task),
      observedAt: input.observedAt,
    },
    input.evidence.inspection.value,
  );
  return verified.kind === 'Current'
    ? {
        kind: 'CurrentTaskMandate',
        mandate: verified.mandate,
        reference: acceptedReference,
      }
    : { kind: 'CurrentTaskMandateRejected', outcome: mappedInvalidity(verified.invalidity) };
}

export function inspectCurrentPromotionMandate(input: {
  readonly ownerAid: string;
  readonly credentialSaid: string;
  readonly observedAt: string;
  readonly task: TaskProjection;
  readonly taskMandate: CurrentTaskMandate;
  readonly evidence: MandateGrantInspection;
  readonly issuerAid: string;
}): CurrentPromotionMandateInspection {
  const acceptanceInput: MandateAcceptanceInput = {
    ownerAid: input.ownerAid,
    mandateKind: 'PromotionMandate',
    credentialSaid: input.credentialSaid,
    observedAt: input.observedAt,
    evidence: input.evidence,
  };
  const bindingFailure = grantBindingInvalidity(
    acceptanceInput,
    input.evidence.inspection,
    input.issuerAid,
  );
  if (bindingFailure !== undefined || input.evidence.inspection.kind !== 'PromotionMandate') {
    return {
      kind: 'CurrentPromotionMandateRejected',
      outcome: rejected(bindingFailure ?? 'CredentialBindingInvalid'),
    };
  }
  const acceptedReference = reference(input.evidence.inspection, input.evidence.grantSenderAid);
  if (acceptedReference.issueeAid === input.taskMandate.credential.issueeAid) {
    return {
      kind: 'CurrentPromotionMandateRejected',
      outcome: rejected('CredentialBindingInvalid'),
    };
  }
  const verified = verifyPromotionMandate(
    {
      credential: {
        issuerAid: input.ownerAid,
        issueeAid: acceptedReference.issueeAid,
        registryId: acceptedReference.registryId,
        schemaSaid: promotionSchemaSaid(input.task, input.evidence.inspection.value),
        credentialSaid: input.credentialSaid,
      },
      task: mandateTask(input.task),
      taskMandate: input.taskMandate,
      observedAt: input.observedAt,
    },
    input.evidence.inspection.value,
  );
  return verified.kind === 'Current'
    ? {
        kind: 'CurrentPromotionMandate',
        mandate: verified.mandate,
        reference: acceptedReference,
      }
    : { kind: 'CurrentPromotionMandateRejected', outcome: mappedInvalidity(verified.invalidity) };
}

async function currentTaskMandate(
  input: MandateAcceptanceInput,
  task: MandateTask,
  dependencies: MandateAcceptanceDependencies,
): Promise<
  | { readonly kind: 'CurrentTaskMandateFound'; readonly mandate: CurrentTaskMandate }
  | { readonly kind: 'CurrentTaskMandateRejected'; readonly outcome: MandateAcceptance }
> {
  const located = await dependencies.presentations.findAdmittedTaskMandates(
    input.ownerAid,
    task.taskId,
    task.revisionSaid,
  );
  switch (located.kind) {
    case 'DependencyUnavailable':
      return { kind: 'CurrentTaskMandateRejected', outcome: located };
    case 'NoAdmittedTaskMandate':
      return {
        kind: 'CurrentTaskMandateRejected',
        outcome: rejected('AuthorityCeilingInvalid'),
      };
    case 'AdmittedTaskMandatesFound':
      break;
  }
  for (const stored of located.presentations) {
    const accepted = stored.presentation.acceptedReference;
    if (accepted === null) {
      continue;
    }
    const observed = await dependencies.admission.inspect({
      ownerAid: stored.presentation.binding.ownerAid,
      credentialSaid: stored.presentation.binding.credentialSaid,
      grantSaid: stored.presentation.binding.grantSaid,
    });
    switch (observed.kind) {
      case 'MandateGrantPending':
        return {
          kind: 'CurrentTaskMandateRejected',
          outcome: { kind: 'MandatePending' },
        };
      case 'DependencyUnavailable':
        return { kind: 'CurrentTaskMandateRejected', outcome: observed };
      case 'MandateAdmissionForbidden':
      case 'MandateAdmissionRejected':
        continue;
      case 'MandateAdmissionInspected':
        break;
    }
    const evidence = observed.evidence;
    if (evidence.inspection.kind !== 'TaskMandate') {
      continue;
    }
    const candidateInput: MandateAcceptanceInput = {
      ownerAid: input.ownerAid,
      mandateKind: 'TaskMandate',
      credentialSaid: stored.presentation.binding.credentialSaid,
      observedAt: input.observedAt,
      evidence,
    };
    if (
      grantBindingInvalidity(candidateInput, evidence.inspection, dependencies.issuerAid) !==
        undefined ||
      accepted.issueeAid !== evidence.grantSenderAid ||
      accepted.registryId !== evidence.inspection.value.credential.registryId ||
      accepted.taskId !== task.taskId ||
      accepted.taskRevisionSaid !== task.revisionSaid
    ) {
      continue;
    }
    const verified = verifyTaskMandate(
      {
        credential: {
          issuerAid: input.ownerAid,
          issueeAid: accepted.issueeAid,
          registryId: accepted.registryId,
          schemaSaid:
            task.experience === undefined
              ? taskMandateSchemaSaid
              : task.budgets.runsPerAdmittedUser > taskBudgetCeilings.runsPerAdmittedUser
                ? taskMandateV3SchemaSaid
                : taskMandateV2SchemaSaid,
          credentialSaid: stored.presentation.binding.credentialSaid,
        },
        task,
        observedAt: input.observedAt,
      },
      evidence.inspection.value,
    );
    if (verified.kind === 'Current') {
      return { kind: 'CurrentTaskMandateFound', mandate: verified.mandate };
    }
  }
  return {
    kind: 'CurrentTaskMandateRejected',
    outcome: rejected('AuthorityCeilingInvalid'),
  };
}

export async function verifyMandateAcceptance(
  input: MandateAcceptanceInput,
  dependencies: MandateAcceptanceDependencies,
): Promise<MandateAcceptance> {
  const bindingFailure = grantBindingInvalidity(
    input,
    input.evidence.inspection,
    dependencies.issuerAid,
  );
  if (bindingFailure !== undefined) {
    return rejected(bindingFailure);
  }
  const inspection = input.evidence.inspection;
  const found = await dependencies.tasks.findById(input.ownerAid, inspection.value.taskId);
  switch (found.kind) {
    case 'DependencyUnavailable':
      return found;
    case 'TaskNotFound':
      return rejected('ResourceBindingInvalid');
    case 'TaskFound':
      break;
  }
  const task = mandateTask(found.task);
  const acceptedReference = reference(inspection, input.evidence.grantSenderAid);
  if (inspection.kind === 'TaskMandate') {
    const verified = inspectCurrentTaskMandate({
      ownerAid: input.ownerAid,
      credentialSaid: input.credentialSaid,
      observedAt: input.observedAt,
      task: found.task,
      evidence: input.evidence,
      issuerAid: dependencies.issuerAid,
    });
    return verified.kind === 'CurrentTaskMandate'
      ? { kind: 'MandateAccepted', reference: verified.reference }
      : verified.outcome;
  }
  const taskMandate = await currentTaskMandate(input, task, dependencies);
  if (taskMandate.kind === 'CurrentTaskMandateRejected') {
    return taskMandate.outcome;
  }
  if (taskMandate.mandate.credential.issueeAid === acceptedReference.issueeAid) {
    return rejected('CredentialBindingInvalid');
  }
  const verified = verifyPromotionMandate(
    {
      credential: {
        issuerAid: input.ownerAid,
        issueeAid: acceptedReference.issueeAid,
        registryId: acceptedReference.registryId,
        schemaSaid: promotionSchemaSaid(found.task, inspection.value),
        credentialSaid: input.credentialSaid,
      },
      task,
      taskMandate: taskMandate.mandate,
      observedAt: input.observedAt,
    },
    inspection.value,
  );
  return verified.kind === 'Current'
    ? { kind: 'MandateAccepted', reference: acceptedReference }
    : mappedInvalidity(verified.invalidity);
}
