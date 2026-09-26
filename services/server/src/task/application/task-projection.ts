import type { Task } from '@devrandom/domain';
import type { AuthorizedTaskRevision, TaskProjection, TaskSummary } from '@devrandom/protocol';

export function projectTask(task: Task, revision: AuthorizedTaskRevision): TaskProjection {
  return Object.freeze({
    version: 1,
    taskId: task.taskId,
    ownerAid: task.ownerAid,
    label: task.label,
    harnessLineageId: task.harnessLineageId,
    revisionSaid: task.revision.said,
    revision,
    lifecycle: Object.freeze({ ...task.lifecycle }),
    commandId: task.commandId,
    createdAt: task.createdAt,
    expectedVersion: task.expectedVersion,
  });
}

export function summarizeTask(task: TaskProjection): TaskSummary {
  return Object.freeze({
    version: 1,
    taskId: task.taskId,
    ownerAid: task.ownerAid,
    label: task.label,
    harnessLineageId: task.harnessLineageId,
    revisionSaid: task.revisionSaid,
    lifecycle: task.lifecycle,
    commandId: task.commandId,
    createdAt: task.createdAt,
    expectedVersion: task.expectedVersion,
  });
}
