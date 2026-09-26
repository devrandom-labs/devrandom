import type { Task } from '@devrandom/domain';
import { describe, expect, it } from 'vitest';

import { projectTask } from './task-projection.js';
import { taskCommandFixture, taskOwnerAid } from '../test/task-command-fixture.js';

describe('Task application projection', () => {
  it('projects the authoritative lifecycle and version without restoring creation defaults', () => {
    const command = taskCommandFixture();
    const task: Task = {
      taskId: '22222222-2222-4222-8222-222222222222',
      ownerAid: taskOwnerAid,
      label: command.label,
      harnessLineageId: '33333333-3333-4333-8333-333333333333',
      revision: { said: command.revision.d },
      lifecycle: { kind: 'Completed' },
      commandId: command.commandId,
      createdAt: '2026-09-24T12:00:00.000Z',
      expectedVersion: 1,
    };

    expect(projectTask(task, command.revision)).toMatchObject({
      lifecycle: { kind: 'Completed' },
      expectedVersion: 1,
    });
  });
});
