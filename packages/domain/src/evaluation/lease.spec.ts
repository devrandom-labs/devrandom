import { describe, expect, it } from 'vitest';

import {
  assessEvaluationLease,
  evaluationLeaseSafetyDeadline,
  renewEvaluationLease,
} from './lease.js';

const receipt = {
  evaluationId: 'evaluation',
  leaseId: 'evaluation-lease',
  version: 1,
  serverTime: '2026-09-26T03:00:00.000Z',
  expiresAt: '2026-09-26T03:00:45.000Z',
};

describe('exclusive evaluation lease', () => {
  it('reserves the same 5-second client safety margin without borrowing a Run lease', () => {
    expect(evaluationLeaseSafetyDeadline(receipt, 1000)).toBe(41000);
    expect(assessEvaluationLease(receipt, 'evaluation', 'evaluation-lease', 1000, 40999)).toEqual({
      kind: 'Held',
    });
    expect(assessEvaluationLease(receipt, 'evaluation', 'evaluation-lease', 1000, 41000)).toEqual({
      kind: 'Lost',
    });
  });

  it('rejects a Run or different evaluation binding and invalid durations', () => {
    expect(assessEvaluationLease(receipt, 'run', 'evaluation-lease', 1000, 2000)).toEqual({
      kind: 'Lost',
    });
    expect(assessEvaluationLease(receipt, 'evaluation', 'run-incarnation', 1000, 2000)).toEqual({
      kind: 'Lost',
    });
    expect(
      evaluationLeaseSafetyDeadline({ ...receipt, expiresAt: '2026-09-26T03:00:46.000Z' }, 1000),
    ).toBeUndefined();
  });

  it('renews only an unexpired evaluation lease in its 15-second window', () => {
    expect(renewEvaluationLease(receipt, '2026-09-26T03:00:29.999Z')).toEqual({
      kind: 'TooEarly',
    });
    expect(renewEvaluationLease(receipt, '2026-09-26T03:00:30.000Z')).toEqual({
      kind: 'Renewed',
      lease: {
        ...receipt,
        version: 2,
        serverTime: '2026-09-26T03:00:30.000Z',
        expiresAt: '2026-09-26T03:01:15.000Z',
      },
    });
    expect(renewEvaluationLease(receipt, receipt.expiresAt)).toEqual({ kind: 'Lost' });
  });
});
