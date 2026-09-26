import { describe, expect, it } from 'vitest';

import { acceptEvaluationEvidence } from './accept-evaluation-evidence.js';

describe('evaluation evidence admission', () => {
  it('rejects malformed or substituted batch bytes before persistence', async () => {
    let writes = 0;
    const result = await acceptEvaluationEvidence(
      { ownerAid: 'owner', upload: { version: 1, batch: { d: 'forged' }, events: [] } },
      {
        batches: {
          accept: () => {
            writes += 1;
            return Promise.reject(new Error('must not write'));
          },
        },
      },
    );
    expect(result).toEqual({ kind: 'Rejected', reason: 'InvalidBatch' });
    expect(writes).toBe(0);
  });
});
