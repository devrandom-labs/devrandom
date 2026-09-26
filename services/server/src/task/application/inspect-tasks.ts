import type { TaskListProjection, TaskListQuery, TaskProjection } from '@devrandom/protocol';

import type { TaskPageCursor } from './task-page-cursor.js';
import type { Tasks } from './tasks.js';

export type ListTasksOutcome =
  | { readonly kind: 'TasksListed'; readonly page: TaskListProjection }
  | { readonly kind: 'TaskQueryRejected' }
  | { readonly kind: 'DependencyUnavailable'; readonly dependency: 'HostedMongoDB' };

export type InspectTaskOutcome =
  | { readonly kind: 'TaskFound'; readonly task: TaskProjection }
  | { readonly kind: 'TaskNotFound' }
  | { readonly kind: 'DependencyUnavailable'; readonly dependency: 'HostedMongoDB' };

export async function listTasks(
  input: { readonly ownerAid: string; readonly query: TaskListQuery },
  dependencies: { readonly tasks: Tasks; readonly cursors: TaskPageCursor },
): Promise<ListTasksOutcome> {
  const limit = input.query.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return { kind: 'TaskQueryRejected' };
  }
  const decoding =
    input.query.cursor === undefined
      ? { kind: 'CursorAcceptedWithoutPosition' as const }
      : dependencies.cursors.decode({
          ownerAid: input.ownerAid,
          limit,
          cursor: input.query.cursor,
        });
  if (decoding.kind === 'CursorRejected') {
    return { kind: 'TaskQueryRejected' };
  }
  const after = decoding.kind === 'CursorAcceptedWithoutPosition' ? null : decoding.position;
  const page = await dependencies.tasks.list(input.ownerAid, { limit, after });
  if (page.kind === 'DependencyUnavailable') {
    return page;
  }
  const nextCursor =
    page.nextPosition === null
      ? null
      : dependencies.cursors.encode({
          ownerAid: input.ownerAid,
          limit,
          position: page.nextPosition,
        });
  return {
    kind: 'TasksListed',
    page: { version: 1, tasks: [...page.tasks], nextCursor },
  };
}

export async function inspectTaskByLabel(
  input: { readonly ownerAid: string; readonly label: string },
  tasks: Tasks,
): Promise<InspectTaskOutcome> {
  return tasks.findByLabel(input.ownerAid, input.label);
}
