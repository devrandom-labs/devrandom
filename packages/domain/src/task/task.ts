import { runStateIsCoherent, type RunLifecycle, type SubmissionVerification } from '../run/run.js';

export type TaskLifecycle =
  { readonly kind: 'Open' } | { readonly kind: 'Completed' } | { readonly kind: 'Cancelled' };

export interface TaskRevisionReference {
  readonly said: string;
}

export interface Task {
  readonly taskId: string;
  readonly ownerAid: string;
  readonly label: string;
  readonly harnessLineageId: string;
  readonly revision: TaskRevisionReference;
  readonly lifecycle: TaskLifecycle;
  readonly commandId: string;
  readonly createdAt: string;
  readonly expectedVersion: number;
}

export interface OpenTaskFacts {
  readonly taskId: string;
  readonly ownerAid: string;
  readonly label: string;
  readonly harnessLineageId: string;
  readonly revisionSaid: string;
  readonly commandId: string;
  readonly createdAt: string;
}

export function openTask(facts: OpenTaskFacts): Task {
  const revision = Object.freeze({ said: facts.revisionSaid });
  const lifecycle = Object.freeze({ kind: 'Open' } satisfies TaskLifecycle);

  return Object.freeze({
    taskId: facts.taskId,
    ownerAid: facts.ownerAid,
    label: facts.label,
    harnessLineageId: facts.harnessLineageId,
    revision,
    lifecycle,
    commandId: facts.commandId,
    createdAt: facts.createdAt,
    expectedVersion: 0,
  });
}

export interface SealedRunTaskSettlementInput {
  readonly taskRevisionSaid: string;
  readonly expectedTaskVersion: number;
  readonly lifecycle: RunLifecycle;
  readonly submissionVerification: SubmissionVerification;
}

export type SealedRunTaskSettlement =
  | { readonly kind: 'Settled'; readonly task: Task }
  | { readonly kind: 'Equivalent'; readonly task: Task }
  | { readonly kind: 'TaskRevisionConflict' }
  | { readonly kind: 'TaskVersionConflict'; readonly currentVersion: number }
  | {
      readonly kind: 'TaskLifecycleConflict';
      readonly lifecycle: Exclude<TaskLifecycle['kind'], 'Open'>;
    }
  | { readonly kind: 'RunDispositionInvalid' };

function checkpointedDispositionIsValid(input: SealedRunTaskSettlementInput): boolean {
  if (
    !runStateIsCoherent({
      lifecycle: input.lifecycle,
      submissionVerification: input.submissionVerification,
    })
  ) {
    return false;
  }
  return input.lifecycle.kind === 'Ended' || input.lifecycle.phase.kind === 'Blocked';
}

function isAcceptedSubmission(input: SealedRunTaskSettlementInput): boolean {
  return (
    input.lifecycle.kind === 'Ended' &&
    input.lifecycle.outcome.kind === 'Submitted' &&
    input.submissionVerification.kind === 'Accepted'
  );
}

export function settleTaskFromSealedRun(
  task: Task,
  input: SealedRunTaskSettlementInput,
): SealedRunTaskSettlement {
  if (input.taskRevisionSaid !== task.revision.said) {
    return { kind: 'TaskRevisionConflict' };
  }
  if (!checkpointedDispositionIsValid(input)) {
    return { kind: 'RunDispositionInvalid' };
  }
  const acceptedSubmission = isAcceptedSubmission(input);
  if (
    task.lifecycle.kind === 'Completed' &&
    acceptedSubmission &&
    Number.isSafeInteger(input.expectedTaskVersion) &&
    input.expectedTaskVersion >= 0 &&
    input.expectedTaskVersion + 1 === task.expectedVersion
  ) {
    return { kind: 'Equivalent', task };
  }
  if (
    !Number.isSafeInteger(input.expectedTaskVersion) ||
    input.expectedTaskVersion < 0 ||
    input.expectedTaskVersion !== task.expectedVersion
  ) {
    return { kind: 'TaskVersionConflict', currentVersion: task.expectedVersion };
  }
  if (task.lifecycle.kind !== 'Open') {
    return { kind: 'TaskLifecycleConflict', lifecycle: task.lifecycle.kind };
  }
  if (!acceptedSubmission) {
    return { kind: 'Settled', task };
  }
  return {
    kind: 'Settled',
    task: {
      ...task,
      lifecycle: { kind: 'Completed' },
      expectedVersion: task.expectedVersion + 1,
    },
  };
}
