import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { renewHostedEvaluationLease } from './renew-evaluation-lease.js';

describe('hosted Evaluation lease renewal', () => {
  it('does not extend effect rights after current authority is denied', async () => {
    let changed = 0;
    const result = await renewHostedEvaluationLease(
      {
        ownerAid: `E${'o'.repeat(43)}`,
        command: {
          version: 1,
          commandId: randomUUID(),
          fingerprint: `sha256:${'a'.repeat(64)}`,
          evaluationId: randomUUID(),
          leaseId: randomUUID(),
          expectedEvaluationVersion: 1,
        },
      },
      {
        authority: {
          inspect: () => Promise.resolve({ kind: 'Blocked' as const, gate: 'Authority' as const }),
        },
        leases: {
          renew: () => {
            changed += 1;
            return Promise.reject(new Error('must not renew'));
          },
        },
      },
    );
    expect(result).toEqual({ kind: 'Blocked', gate: 'Authority' });
    expect(changed).toBe(0);
  });
});
