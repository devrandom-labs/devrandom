import { describe, expect, it } from 'vitest';

import { BoundedWorkAccessAttemptQuota } from './bounded-work-access-attempt-quota.js';

describe('bounded public Work Access attempt quota', () => {
  it('admits exactly twenty attempts per source in one minute', () => {
    let now = 1_000;
    const quota = new BoundedWorkAccessAttemptQuota(() => now);

    const admitted = Array.from({ length: 20 }, () => quota.admit('127.0.0.1'));
    expect(admitted.every((entry) => entry.kind === 'AttemptQuotaAdmitted')).toBe(true);
    expect(quota.admit('127.0.0.1')).toEqual({ kind: 'AttemptRateExceeded' });

    now += 60_000;
    expect(quota.admit('127.0.0.1')).toEqual({ kind: 'AttemptQuotaAdmitted' });
  });

  it('fails closed when distinct-source tracking reaches its bound', () => {
    const quota = new BoundedWorkAccessAttemptQuota(() => 1_000);
    for (let index = 0; index < 32; index += 1) {
      expect(quota.admit(`192.0.2.${String(index)}`)).toEqual({
        kind: 'AttemptQuotaAdmitted',
      });
    }

    expect(quota.admit('198.51.100.1')).toEqual({ kind: 'AttemptRateExceeded' });
  });
});
