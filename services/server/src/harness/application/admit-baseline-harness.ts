import { isDeepStrictEqual } from 'node:util';

import type {
  CurrentTaskMandate,
  ProtectedCredentials,
  TaskToolCapability,
} from '@devrandom/domain';
import {
  decodeBaselineHarnessRevision,
  harnessCommandFingerprint,
  identifyHarnessCompletionCommand,
  identifyHarnessToolCommand,
  taskBudgetCeilings,
  type AdmitBaselineHarnessBody,
  type BaselineHarnessProjection,
} from '@devrandom/protocol';

import type {
  CurrentTaskMandateAuthorization,
  CurrentTaskMandateInput,
} from '../../mandate/application/current-task-mandate.js';
import type { CurrentMandateUserCredential } from '../../mandate/application/user-credential.js';
import type { AuthenticatedTaskOwner } from '../../task/application/tasks.js';
import type { HarnessRevisions } from './harness-revisions.js';

export interface HarnessTaskMandateAuthorization {
  authorize(input: CurrentTaskMandateInput): Promise<CurrentTaskMandateAuthorization>;
}

export interface AdmitBaselineHarnessDependencies {
  readonly currentUserCredential: CurrentMandateUserCredential;
  readonly currentTaskMandate: HarnessTaskMandateAuthorization;
  readonly revisions: HarnessRevisions;
  now(): string;
}

export interface AdmitBaselineHarnessInput {
  readonly protectedCredentials: ProtectedCredentials;
  readonly owner: AuthenticatedTaskOwner;
  readonly command: AdmitBaselineHarnessBody;
}

export type HarnessRevisionRejection =
  | 'ManifestInvalid'
  | 'TaskBindingMismatch'
  | 'HarnessLineageMismatch'
  | 'RepositoryBindingMismatch'
  | 'PrincipalBindingMismatch'
  | 'MandateBindingMismatch'
  | 'CapabilityMismatch'
  | 'BudgetCeilingMismatch'
  | 'CompletionCommandMismatch'
  | 'ToolCommandMismatch'
  | 'SecretDetected';

export type AdmitBaselineHarnessOutcome =
  | { readonly kind: 'HarnessRevisionCreated'; readonly projection: BaselineHarnessProjection }
  | { readonly kind: 'ExistingHarnessRevision'; readonly projection: BaselineHarnessProjection }
  | { readonly kind: 'HarnessCommandConflict' }
  | { readonly kind: 'HarnessLineageConflict' }
  | { readonly kind: 'HarnessTaskNotFound' }
  | { readonly kind: 'HarnessRevisionRejected'; readonly reason: HarnessRevisionRejection }
  | {
      readonly kind: 'HarnessAdmissionForbidden';
      readonly reason:
        | 'UserCredentialNotCurrent'
        | 'TaskMandateNotAdmitted'
        | 'TaskMandatePending'
        | 'TaskMandateNotYetValid'
        | 'TaskMandateExpired'
        | 'TaskMandateRevoked'
        | 'TaskMandateBindingRejected';
    }
  | {
      readonly kind: 'DependencyUnavailable';
      readonly dependency: 'HostedMongoDB' | 'Keria' | 'Witness';
    };

function completionCommandsMatch(
  revision: AdmitBaselineHarnessBody['revision'],
  task: Extract<
    CurrentTaskMandateAuthorization,
    { readonly kind: 'CurrentTaskMandateAuthorized' }
  >['task'],
): boolean {
  if (revision.completionCommands.length !== task.revision.completionConditions.length) {
    return false;
  }
  const expected = task.revision.completionConditions.map((condition, index) => {
    const committed = revision.completionCommands[index];
    return committed === undefined
      ? { kind: 'Rejected' as const, reason: 'SchemaInvalid' as const }
      : identifyHarnessCompletionCommand(condition, committed.executableRealpath);
  });
  if (expected.some((identified) => identified.kind === 'Rejected')) {
    return false;
  }
  const commands = expected.flatMap((identified) =>
    identified.kind === 'Identified' ? [identified.command] : [],
  );
  return isDeepStrictEqual(revision.completionCommands, commands);
}

function bindingRejection(
  command: AdmitBaselineHarnessBody,
  authorization: Extract<
    CurrentTaskMandateAuthorization,
    { readonly kind: 'CurrentTaskMandateAuthorized' }
  >,
): HarnessRevisionRejection | undefined {
  const revision = command.revision;
  const task = authorization.task;
  const mandate: CurrentTaskMandate = authorization.mandate;
  if (revision.task.taskId !== task.taskId || revision.task.revisionSaid !== task.revisionSaid) {
    return 'TaskBindingMismatch';
  }
  if (revision.task.harnessLineageId !== task.harnessLineageId) {
    return 'HarnessLineageMismatch';
  }
  if (
    !isDeepStrictEqual(revision.repository.objectFormat, task.revision.repository.objectFormat) ||
    revision.repository.commit !== task.revision.repository.commit ||
    revision.repository.tree !== task.revision.repository.tree
  ) {
    return 'RepositoryBindingMismatch';
  }
  if (revision.authority.personalAgentAid !== mandate.credential.issueeAid) {
    return 'PrincipalBindingMismatch';
  }
  if (revision.authority.taskMandateSaid !== mandate.credential.credentialSaid) {
    return 'MandateBindingMismatch';
  }
  const taskTools = task.revision.requestedCapabilities.flatMap(
    (capability): TaskToolCapability[] => (capability === 'ReadTaskMemory' ? [] : [capability]),
  );
  const mandateTools = mandate.allowedCapabilities.flatMap((capability): TaskToolCapability[] =>
    capability === 'ReadTaskMemory' ? [] : [capability],
  );
  const unavailableTools = task.revision.unavailableCapabilities.flatMap(
    (capability): TaskToolCapability[] => (capability === 'ReadTaskMemory' ? [] : [capability]),
  );
  if (
    !isDeepStrictEqual(revision.task.requestedCapabilities, taskTools) ||
    !isDeepStrictEqual(revision.authority.allowedCapabilities, mandateTools) ||
    !isDeepStrictEqual(revision.capabilities.unavailable, unavailableTools)
  ) {
    return 'CapabilityMismatch';
  }
  if (
    !isDeepStrictEqual(revision.budgetCeilings.task, task.revision.budgets) ||
    !isDeepStrictEqual(revision.budgetCeilings.server, taskBudgetCeilings) ||
    !isDeepStrictEqual(revision.budgetCeilings.mandate, mandate.budgets)
  ) {
    return 'BudgetCeilingMismatch';
  }
  if (!completionCommandsMatch(revision, task)) {
    return 'CompletionCommandMismatch';
  }
  const declarations = task.revision.toolCommands ?? [];
  const committed = revision.toolCommands ?? [];
  if (declarations.length !== committed.length) return 'ToolCommandMismatch';
  for (const [index, declaration] of declarations.entries()) {
    const binding = committed[index];
    if (binding === undefined) return 'ToolCommandMismatch';
    const identified = identifyHarnessToolCommand(declaration, binding.executableRealpath);
    if (identified.kind !== 'Identified' || !isDeepStrictEqual(identified.command, binding)) {
      return 'ToolCommandMismatch';
    }
  }
  return undefined;
}

function forbidden(
  authorization: Exclude<
    CurrentTaskMandateAuthorization,
    | { readonly kind: 'CurrentTaskMandateAuthorized' }
    | { readonly kind: 'TaskNotFound' }
    | { readonly kind: 'TaskBindingRejected' }
    | { readonly kind: 'DependencyUnavailable' }
  >,
): AdmitBaselineHarnessOutcome {
  return { kind: 'HarnessAdmissionForbidden', reason: authorization.kind };
}

export async function admitBaselineHarness(
  input: AdmitBaselineHarnessInput,
  dependencies: AdmitBaselineHarnessDependencies,
): Promise<AdmitBaselineHarnessOutcome> {
  if (
    input.protectedCredentials.inspect(new TextEncoder().encode(JSON.stringify(input.command)))
      .kind === 'WithheldSecret'
  ) {
    return { kind: 'HarnessRevisionRejected', reason: 'SecretDetected' };
  }
  if (decodeBaselineHarnessRevision(input.command.revision).kind !== 'Accepted') {
    return { kind: 'HarnessRevisionRejected', reason: 'ManifestInvalid' };
  }
  const fingerprint = harnessCommandFingerprint(input.command);
  const reconciled = await dependencies.revisions.reconcile(
    input.owner.ownerAid,
    input.command.commandId,
    fingerprint,
  );
  if (reconciled.kind !== 'NoHarnessRevision') {
    switch (reconciled.kind) {
      case 'ExistingHarnessRevision':
        return reconciled;
      case 'HarnessCommandConflict':
        return reconciled;
      case 'DependencyUnavailable':
        return reconciled;
    }
  }

  const userCredential = await dependencies.currentUserCredential.verify({
    ownerAid: input.owner.ownerAid,
    credentialSaid: input.owner.credentialSaid,
  });
  if (userCredential.kind === 'DependencyUnavailable') {
    return userCredential;
  }
  if (userCredential.kind === 'UserCredentialNotCurrent') {
    return { kind: 'HarnessAdmissionForbidden', reason: 'UserCredentialNotCurrent' };
  }

  const revision = input.command.revision;
  const authorization = await dependencies.currentTaskMandate.authorize({
    ownerAid: input.owner.ownerAid,
    taskId: revision.task.taskId,
    taskRevisionSaid: revision.task.revisionSaid,
    harnessLineageId: revision.task.harnessLineageId,
    personalAgentAid: revision.authority.personalAgentAid,
    taskMandateSaid: revision.authority.taskMandateSaid,
    observedAt: dependencies.now(),
  });
  switch (authorization.kind) {
    case 'TaskNotFound':
      return { kind: 'HarnessTaskNotFound' };
    case 'TaskBindingRejected':
      return { kind: 'HarnessRevisionRejected', reason: 'TaskBindingMismatch' };
    case 'TaskMandateNotAdmitted':
    case 'TaskMandatePending':
    case 'TaskMandateNotYetValid':
    case 'TaskMandateExpired':
    case 'TaskMandateRevoked':
    case 'TaskMandateBindingRejected':
      return forbidden(authorization);
    case 'DependencyUnavailable':
      return authorization;
    case 'CurrentTaskMandateAuthorized':
      break;
  }
  const rejection = bindingRejection(input.command, authorization);
  if (rejection !== undefined) {
    return { kind: 'HarnessRevisionRejected', reason: rejection };
  }

  const projection: BaselineHarnessProjection = {
    version: 1,
    ownerAid: input.owner.ownerAid,
    commandId: input.command.commandId,
    acceptedAt: dependencies.now(),
    revision: input.command.revision,
  };
  const created = await dependencies.revisions.create({
    projection,
    commandFingerprint: fingerprint,
  });
  switch (created.kind) {
    case 'HarnessRevisionCreated':
      return { kind: 'HarnessRevisionCreated', projection };
    case 'ExistingHarnessRevision':
      return created;
    case 'HarnessCommandConflict':
      return created;
    case 'HarnessLineageConflict':
      return created;
    case 'DependencyUnavailable':
      return created;
  }
}
