import { describe, expect, it, vi } from 'vitest';

import { taskProjectionFixture } from '../../../test/task-source-fixture.js';
import { SignifyCurrentExperienceMandate } from './signify-current-experience-mandate.js';

describe('current experience mandate', () => {
  it('denies a legacy Task before reading local credentials or contacting KERIA', async () => {
    const task = taskProjectionFixture();
    const read = vi.fn();
    const establish = vi.fn();
    const mandate = new SignifyCurrentExperienceMandate({
      task,
      user: { principal: { aid: task.ownerAid } } as never,
      records: { read },
      local: { establish },
      now: () => new Date().toISOString(),
    });
    expect(
      await mandate.inspect({
        taskId: task.taskId,
        taskRevisionSaid: task.revisionSaid,
        ownerAid: task.ownerAid,
      }),
    ).toEqual({ kind: 'Denied' });
    expect(read).not.toHaveBeenCalled();
    expect(establish).not.toHaveBeenCalled();
  });
});
