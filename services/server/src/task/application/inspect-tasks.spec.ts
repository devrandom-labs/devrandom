import type { TaskProjection, TaskSummary } from '@devrandom/protocol';
import { describe, expect, it, vi } from 'vitest';

import { inspectTaskByLabel, listTasks } from './inspect-tasks.js';
import type { Tasks } from './tasks.js';
import { taskCommandFixture, taskOwnerAid } from '../test/task-command-fixture.js';

const summary: TaskSummary = {
  version: 1,
  taskId: '22222222-2222-4222-8222-222222222222',
  ownerAid: taskOwnerAid,
  label: 'compatibility-fix',
  harnessLineageId: '33333333-3333-4333-8333-333333333333',
  revisionSaid: taskCommandFixture().revision.d,
  lifecycle: { kind: 'Open' },
  commandId: taskCommandFixture().commandId,
  createdAt: '2026-09-24T12:00:00.000Z',
  expectedVersion: 0,
};

const projection: TaskProjection = { ...summary, revision: taskCommandFixture().revision };

function tasks(overrides: Partial<Tasks> = {}): Tasks {
  return {
    reconcile: () => Promise.resolve({ kind: 'NoTask' }),
    create: () => Promise.resolve({ kind: 'OwnerCapacityExceeded' }),
    list: () => Promise.resolve({ kind: 'TaskPage', tasks: [summary], nextPosition: null }),
    findByLabel: () => Promise.resolve({ kind: 'TaskFound', task: projection }),
    findById: () => Promise.resolve({ kind: 'TaskFound', task: projection }),
    ...overrides,
  };
}

describe('Task owner-scoped queries', () => {
  it('uses a bounded default page and returns the closed list projection', async () => {
    const list = vi.fn<Tasks['list']>(() =>
      Promise.resolve({ kind: 'TaskPage', tasks: [summary], nextPosition: null }),
    );

    const outcome = await listTasks(
      { ownerAid: taskOwnerAid, query: {} },
      {
        tasks: tasks({ list }),
        cursors: {
          encode: vi.fn(),
          decode: vi.fn(),
        },
      },
    );

    expect(list).toHaveBeenCalledWith(taskOwnerAid, { limit: 25, after: null });
    expect(outcome).toEqual({
      kind: 'TasksListed',
      page: { version: 1, tasks: [summary], nextCursor: null },
    });
  });

  it('rejects a cursor that is not bound to the owner and normalized query', async () => {
    const list = vi.fn<Tasks['list']>();
    const outcome = await listTasks(
      { ownerAid: taskOwnerAid, query: { limit: 50, cursor: 'opaque' } },
      {
        tasks: tasks({ list }),
        cursors: {
          encode: vi.fn(),
          decode: () => ({ kind: 'CursorRejected' }),
        },
      },
    );

    expect(outcome).toEqual({ kind: 'TaskQueryRejected' });
    expect(list).not.toHaveBeenCalled();
  });

  it('looks up a label only inside the authenticated owner scope', async () => {
    const findByLabel = vi.fn<Tasks['findByLabel']>(() =>
      Promise.resolve({ kind: 'TaskFound', task: projection }),
    );

    const outcome = await inspectTaskByLabel(
      { ownerAid: taskOwnerAid, label: 'compatibility-fix' },
      tasks({ findByLabel }),
    );

    expect(findByLabel).toHaveBeenCalledWith(taskOwnerAid, 'compatibility-fix');
    expect(outcome).toEqual({ kind: 'TaskFound', task: projection });
  });
});
