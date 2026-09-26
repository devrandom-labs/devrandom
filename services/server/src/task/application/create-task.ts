import { openTask, type ProtectedCredentials } from '@devrandom/domain';
import {
  decodeTaskRevision,
  taskTimestampIsCanonical,
  taskCommandFingerprint,
  type PreparedTaskCommand,
  type TaskProjection,
  type TaskRevisionInvalidity,
} from '@devrandom/protocol';

import type { CurrentTaskCreationEligibility } from './task-eligibility.js';
import { projectTask } from './task-projection.js';
import type { AuthenticatedTaskOwner, Tasks } from './tasks.js';

type TaskContractRejectionReason =
  | 'SecretDetected'
  | 'RepositoryBindingInvalid'
  | 'BudgetUnacceptable'
  | 'DeadlineUnacceptable'
  | 'CapabilityConflict'
  | 'CheckpointReferenceInvalid';

function taskContractRejection(invalidity: TaskRevisionInvalidity): TaskContractRejectionReason {
  switch (invalidity) {
    case 'CompletionTimeoutExceedsBudget':
    case 'ToolCommandTimeoutExceedsBudget':
      return 'BudgetUnacceptable';
    case 'CapabilitySetsOverlap':
    case 'ToolCommandCapabilityUnrequested':
      return 'CapabilityConflict';
    case 'DuplicateCheckpointReference':
    case 'UnknownCheckpointReference':
      return 'CheckpointReferenceInvalid';
    case 'SchemaInvalid':
    case 'TextConstraintViolation':
    case 'DuplicateDeliverableId':
    case 'DuplicateDeliverablePath':
    case 'DuplicateCompletionConditionId':
    case 'DuplicateToolCommandId':
    case 'ShellSyntaxNotAccepted':
    case 'NonCanonical':
    case 'SaidMismatch':
      return 'RepositoryBindingInvalid';
    case 'DeadlineInvalid':
      return 'DeadlineUnacceptable';
  }
}

export interface CreateTaskDependencies {
  readonly tasks: Tasks;
  readonly eligibility: CurrentTaskCreationEligibility;
  now(): string;
  newTaskId(): string;
  newHarnessLineageId(): string;
}

export interface CreateTaskInput {
  readonly protectedCredentials: ProtectedCredentials;
  readonly owner: AuthenticatedTaskOwner;
  readonly command: PreparedTaskCommand;
}

export type CreateTaskOutcome =
  | { readonly kind: 'TaskCreated'; readonly task: TaskProjection }
  | { readonly kind: 'ExistingTask'; readonly task: TaskProjection }
  | { readonly kind: 'CommandConflict'; readonly commandId: string }
  | { readonly kind: 'LabelConflict'; readonly label: string }
  | { readonly kind: 'TaskCapacityExceeded' }
  | { readonly kind: 'EligibilityMissing' }
  | { readonly kind: 'CredentialNotCurrent' }
  | { readonly kind: 'TaskContractRejected'; readonly reason: TaskContractRejectionReason }
  | {
      readonly kind: 'DependencyUnavailable';
      readonly dependency: 'HostedMongoDB' | 'Keria' | 'Witness';
    };

function acceptableDeadline(createdAt: string, expiresAt: string): boolean {
  if (!taskTimestampIsCanonical(createdAt) || !taskTimestampIsCanonical(expiresAt)) {
    return false;
  }
  const lifetimeMilliseconds = Date.parse(expiresAt) - Date.parse(createdAt);
  return lifetimeMilliseconds > 0 && lifetimeMilliseconds <= 4 * 60 * 60 * 1_000;
}

export async function createTask(
  input: CreateTaskInput,
  dependencies: CreateTaskDependencies,
): Promise<CreateTaskOutcome> {
  if (
    input.protectedCredentials.inspect(new TextEncoder().encode(JSON.stringify(input.command)))
      .kind === 'WithheldSecret'
  ) {
    return { kind: 'TaskContractRejected', reason: 'SecretDetected' };
  }
  const decoded = decodeTaskRevision(input.command.revision);
  if (decoded.kind === 'Rejected') {
    return { kind: 'TaskContractRejected', reason: taskContractRejection(decoded.reason) };
  }

  let commandFingerprint: string;
  try {
    commandFingerprint = taskCommandFingerprint(input.command);
  } catch {
    return { kind: 'TaskContractRejected', reason: 'RepositoryBindingInvalid' };
  }

  const reconciliation = await dependencies.tasks.reconcile(
    input.owner.ownerAid,
    input.command.commandId,
    commandFingerprint,
  );
  switch (reconciliation.kind) {
    case 'CommandConflict':
      return { kind: 'CommandConflict', commandId: input.command.commandId };
    case 'DependencyUnavailable':
      return reconciliation;
    case 'ExistingTask':
    case 'NoTask':
      break;
  }

  const eligibility = await dependencies.eligibility.authorize(input.owner);
  if (eligibility.kind !== 'Eligible') {
    return eligibility;
  }

  if (reconciliation.kind === 'ExistingTask') {
    return { kind: 'ExistingTask', task: reconciliation.task };
  }

  const createdAt = dependencies.now();
  if (!acceptableDeadline(createdAt, decoded.revision.expiresAt)) {
    return { kind: 'TaskContractRejected', reason: 'DeadlineUnacceptable' };
  }

  const task = openTask({
    taskId: dependencies.newTaskId(),
    ownerAid: input.owner.ownerAid,
    label: input.command.label,
    harnessLineageId: dependencies.newHarnessLineageId(),
    revisionSaid: decoded.revision.d,
    commandId: input.command.commandId,
    createdAt,
  });
  const projection = projectTask(task, decoded.revision);
  const creation = await dependencies.tasks.create({ task: projection, commandFingerprint });
  switch (creation.kind) {
    case 'TaskCreated':
      return { kind: 'TaskCreated', task: creation.task };
    case 'ExistingTask':
      return { kind: 'ExistingTask', task: creation.task };
    case 'OwnerCapacityExceeded':
    case 'GlobalCapacityExceeded':
      return { kind: 'TaskCapacityExceeded' };
    case 'CommandConflict':
      return { kind: 'CommandConflict', commandId: input.command.commandId };
    case 'LabelConflict':
      return { kind: 'LabelConflict', label: input.command.label };
    case 'DependencyUnavailable':
      return creation;
  }
}
