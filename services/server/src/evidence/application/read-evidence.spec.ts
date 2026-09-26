import { describe, expect, it } from 'vitest';

import { readEvidence } from './read-evidence.js';

describe('exact evidence reading', () => {
  it('does not reach raw storage without current authorized source scope', async () => {
    let rawReads = 0;
    const result = await readEvidence(
      {
        ownerAid: 'owner',
        query: {
          version: 1,
          taskId: '22222222-2222-4222-8222-222222222222',
          sourceInventorySaid: `E${'i'.repeat(43)}`,
          evidenceSaid: `E${'r'.repeat(43)}`,
          offset: 0,
          maximumBytes: 1024,
        },
      },
      {
        scope: { inspect: () => Promise.resolve({ kind: 'Denied' as const }) },
        reading: {
          read: () => {
            rawReads += 1;
            return Promise.reject(new Error('must not read'));
          },
        },
      },
    );
    expect(result).toEqual({ kind: 'Denied' });
    expect(rawReads).toBe(0);
  });
});
