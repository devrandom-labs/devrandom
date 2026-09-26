import { describe, expect, it } from 'vitest';

import { HmacTaskPageCursor } from './hmac-task-page-cursor.js';
import { taskOwnerAid } from '../test/task-command-fixture.js';

const position = {
  createdAt: '2026-09-24T12:00:00.000Z',
  taskId: '22222222-2222-4222-8222-222222222222',
};

describe('HMAC Task page cursor', () => {
  it('round-trips one owner and query-bound position', () => {
    const cursors = new HmacTaskPageCursor(new Uint8Array(32).fill(7));
    const cursor = cursors.encode({ ownerAid: taskOwnerAid, limit: 25, position });

    expect(cursors.decode({ ownerAid: taskOwnerAid, limit: 25, cursor })).toEqual({
      kind: 'CursorAccepted',
      position,
    });
    expect(cursors.decode({ ownerAid: `E${'z'.repeat(43)}`, limit: 25, cursor })).toEqual({
      kind: 'CursorRejected',
    });
    expect(cursors.decode({ ownerAid: taskOwnerAid, limit: 50, cursor })).toEqual({
      kind: 'CursorRejected',
    });
  });

  it('rejects tampering and malformed cursors', () => {
    const cursors = new HmacTaskPageCursor(new Uint8Array(32).fill(9));
    const cursor = cursors.encode({ ownerAid: taskOwnerAid, limit: 25, position });
    const replacement = cursor.endsWith('a') ? 'b' : 'a';

    expect(
      cursors.decode({
        ownerAid: taskOwnerAid,
        limit: 25,
        cursor: cursor.slice(0, -1) + replacement,
      }),
    ).toEqual({ kind: 'CursorRejected' });
    expect(cursors.decode({ ownerAid: taskOwnerAid, limit: 25, cursor: 'not-a-cursor' })).toEqual({
      kind: 'CursorRejected',
    });
  });
});
