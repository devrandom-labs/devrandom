import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { HmacEvidenceTimelineCursor } from './hmac-evidence-timeline-cursor.js';

const ownerAid = `E${'a'.repeat(43)}`;
const runId = '1cc482f1-98e9-4454-8e4c-5566cb47ce3d';

describe('HMAC evidence timeline cursor', () => {
  it('round-trips only for the same owner, Run, and page limit', () => {
    const cursor = new HmacEvidenceTimelineCursor(randomBytes(32));
    const encoded = cursor.encode({ ownerAid, runId, limit: 25, afterSequence: 17 });

    expect(cursor.decode({ ownerAid, runId, limit: 25, cursor: encoded })).toEqual({
      kind: 'CursorAccepted',
      afterSequence: 17,
    });
    expect(
      cursor.decode({
        ownerAid: `E${'b'.repeat(43)}`,
        runId,
        limit: 25,
        cursor: encoded,
      }),
    ).toEqual({ kind: 'CursorRejected' });
    expect(
      cursor.decode({
        ownerAid,
        runId: 'e3810b6b-5866-44d3-8fb8-6bcb1f47bb63',
        limit: 25,
        cursor: encoded,
      }),
    ).toEqual({ kind: 'CursorRejected' });
    expect(cursor.decode({ ownerAid, runId, limit: 100, cursor: encoded })).toEqual({
      kind: 'CursorRejected',
    });
  });

  it('rejects tampering and short signing keys', () => {
    expect(() => new HmacEvidenceTimelineCursor(randomBytes(31))).toThrow(
      'Evidence timeline cursor key must contain at least 32 bytes',
    );
    const cursor = new HmacEvidenceTimelineCursor(randomBytes(32));
    const encoded = cursor.encode({ ownerAid, runId, limit: 25, afterSequence: 0 });
    const replacement = encoded.endsWith('a') ? 'b' : 'a';

    expect(
      cursor.decode({
        ownerAid,
        runId,
        limit: 25,
        cursor: `${encoded.slice(0, -1)}${replacement}`,
      }),
    ).toEqual({ kind: 'CursorRejected' });
  });
});
