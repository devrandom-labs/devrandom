import { expect, it, vi } from 'vitest';
import {
  renewOwnedEvaluationLease,
  type EvaluationLeaseRenewalCustody,
} from './renew-owned-evaluation-lease.js';

function fixture() {
  const now = Date.parse('2026-09-26T12:00:30.000Z');
  const lease = {
    evaluationId: 'evaluation',
    leaseId: 'lease',
    version: 2,
    serverTime: '2026-09-26T12:00:00.000Z',
    expiresAt: '2026-09-26T12:00:45.000Z',
  };
  const controller = new AbortController();
  const input = {
    ownerAid: 'owner',
    currentEvaluationVersion: 12,
    lease,
    leaseRequestStartedAt: now - 30000,
    signal: controller.signal,
    now: () => now,
  };
  const position = {
    ownerAid: 'owner',
    evaluationId: 'evaluation',
    currentEvaluationVersion: 13,
    lease,
  };
  const receipt = {
    version: 14,
    lease: {
      ...lease,
      version: 3,
      serverTime: '2026-09-26T12:00:30.000Z',
      expiresAt: '2026-09-26T12:01:15.000Z',
    },
  };
  return { input, position, receipt, controller };
}

it('rereads a concurrent append version and renews the identical lease with a new command', async () => {
  const { input, position, receipt } = fixture();
  const renew = vi
    .fn<EvaluationLeaseRenewalCustody['renew']>()
    .mockResolvedValueOnce({ kind: 'Conflict' })
    .mockResolvedValueOnce({ kind: 'Renewed', receipt });
  const inspect = vi
    .fn<EvaluationLeaseRenewalCustody['inspect']>()
    .mockResolvedValue({ kind: 'Read', position });
  expect(await renewOwnedEvaluationLease(input, { inspect, renew })).toEqual({
    kind: 'Renewed',
    lease: receipt.lease,
    requestStartedAt: input.now(),
  });
  expect(renew.mock.calls).toEqual([[12], [13]]);
  expect(inspect).toHaveBeenCalledOnce();
});

it.each(['owner', 'lease', 'version', 'expiry', 'expired', 'cancelled', 'unavailable'] as const)(
  'refuses a %s change or failure during conflict reconciliation',
  async (change) => {
    const { input, position, controller } = fixture();
    const renew = vi
      .fn<EvaluationLeaseRenewalCustody['renew']>()
      .mockResolvedValue({ kind: change === 'unavailable' ? 'Unavailable' : 'Conflict' });
    const inspect = vi.fn<EvaluationLeaseRenewalCustody['inspect']>().mockImplementation(() => {
      if (change === 'cancelled') controller.abort();
      if (change === 'expired') input.now = () => Date.parse(input.lease.expiresAt);
      return Promise.resolve({
        kind: 'Read',
        position: {
          ...position,
          ownerAid: change === 'owner' ? 'other' : position.ownerAid,
          lease: {
            ...position.lease,
            leaseId: change === 'lease' ? 'other' : position.lease.leaseId,
            version: change === 'version' ? 3 : 2,
            expiresAt: change === 'expiry' ? '2026-09-26T12:01:00.000Z' : position.lease.expiresAt,
          },
        },
      });
    });
    expect(await renewOwnedEvaluationLease(input, { inspect, renew })).toEqual({ kind: 'Lost' });
    expect(renew).toHaveBeenCalledOnce();
  },
);

it('limits changing concurrent append conflicts to three attempts', async () => {
  const { input, position } = fixture();
  let version = 12;
  const renew = vi
    .fn<EvaluationLeaseRenewalCustody['renew']>()
    .mockResolvedValue({ kind: 'Conflict' });
  const inspect = vi
    .fn<EvaluationLeaseRenewalCustody['inspect']>()
    .mockImplementation(() =>
      Promise.resolve({
        kind: 'Read',
        position: { ...position, currentEvaluationVersion: ++version },
      }),
    );
  expect(await renewOwnedEvaluationLease(input, { inspect, renew })).toEqual({ kind: 'Lost' });
  expect(renew.mock.calls).toEqual([[12], [13], [14]]);
  expect(inspect).toHaveBeenCalledTimes(2);
});
