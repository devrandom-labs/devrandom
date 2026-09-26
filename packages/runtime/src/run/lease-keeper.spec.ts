import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  keepRunLease,
  MonotonicLeaseClock,
  type RunLeaseAuthority,
  type RunLeaseReceipt,
} from './lease-keeper.js';

const runId = '1cc482f1-98e9-4454-8e4c-5566cb47ce3d';
const incarnationId = 'ee87e11d-fb5f-46b4-841f-8a7a5faad97c';

function receipt(runVersion: number, serverTime: string): RunLeaseReceipt {
  return {
    runId,
    incarnationId,
    runVersion,
    serverTime,
    expiresAt: new Date(Date.parse(serverTime) + 45_000).toISOString(),
  };
}

describe('Run lease keeper', () => {
  it('stops at the remaining receipt interval rather than restoring a full lease', async () => {
    const renew = vi.fn<RunLeaseAuthority['renew']>();
    const settled = vi.fn();
    const initial = receipt(1, '2026-09-24T20:00:00.000Z');
    const keeping = keepRunLease(
      { ...initial, expiresAt: '2026-09-24T20:00:20.000Z' },
      0,
      { renew },
      new MonotonicLeaseClock(),
      new AbortController().signal,
      { accept: vi.fn() },
    ).then(settled);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await keeping;
    expect(settled).toHaveBeenCalledExactlyOnceWith({
      kind: 'LeaseLost',
      lastAcceptedRunVersion: 1,
    });
    expect(renew).not.toHaveBeenCalled();
  });
  it('subtracts response latency from the renewed safety window', async () => {
    const renew = vi
      .fn<RunLeaseAuthority['renew']>()
      .mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20_000));
        return { kind: 'Renewed', receipt: receipt(2, '2026-09-24T20:00:15.000Z') };
      })
      .mockImplementation(() => new Promise(() => undefined));
    const accept = vi.fn();
    const settled = vi.fn();
    const keeping = keepRunLease(
      receipt(1, '2026-09-24T20:00:00.000Z'),
      0,
      { renew },
      new MonotonicLeaseClock(),
      new AbortController().signal,
      { accept },
    ).then(settled);
    await vi.advanceTimersByTimeAsync(35_000);
    expect(accept).toHaveBeenCalledExactlyOnceWith(receipt(2, '2026-09-24T20:00:15.000Z'), 15_000);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledExactlyOnceWith({
      kind: 'LeaseLost',
      lastAcceptedRunVersion: 2,
    });
    await keeping;
  });
  it('keeps the original safety deadline when preparation delays keeper startup', async () => {
    const renew = vi.fn<RunLeaseAuthority['renew']>(() => new Promise(() => undefined));
    const settled = vi.fn();
    await vi.advanceTimersByTimeAsync(35_000);
    const keeping = keepRunLease(
      receipt(1, '2026-09-24T20:00:00.000Z'),
      0,
      { renew },
      new MonotonicLeaseClock(),
      new AbortController().signal,
      { accept: vi.fn() },
    ).then(settled);
    await vi.advanceTimersByTimeAsync(1);
    expect(renew).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(4_998);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await keeping;
    expect(settled).toHaveBeenCalledExactlyOnceWith({
      kind: 'LeaseLost',
      lastAcceptedRunVersion: 1,
    });
  });
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('loses authority at the safety deadline even while renewal remains pending', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const renew = vi.fn<RunLeaseAuthority['renew']>(() => new Promise(() => undefined));
      const accept = vi.fn();
      const settled = vi.fn();
      const keeping = keepRunLease(
        receipt(1, '2026-09-24T20:00:00.000Z'),
        0,
        { renew },
        new MonotonicLeaseClock(),
        new AbortController().signal,
        { accept },
      ).then(settled);

      await vi.advanceTimersByTimeAsync(15_000);
      expect(renew).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(24_999);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toHaveBeenCalledWith({ kind: 'LeaseLost', lastAcceptedRunVersion: 1 });
      expect(accept).not.toHaveBeenCalled();
      await keeping;
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops promptly on supervisor cancellation while renewal remains pending', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const cancellation = new AbortController();
      const renew = vi.fn<RunLeaseAuthority['renew']>(() => new Promise(() => undefined));
      const settled = vi.fn();
      const keeping = keepRunLease(
        receipt(1, '2026-09-24T20:00:00.000Z'),
        0,
        { renew },
        new MonotonicLeaseClock(),
        cancellation.signal,
        { accept: vi.fn() },
      ).then(settled);

      await vi.advanceTimersByTimeAsync(15_000);
      cancellation.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toHaveBeenCalledWith({ kind: 'StoppedBySupervisor', latestRunVersion: 1 });
      await keeping;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('renews every fifteen seconds with the latest accepted Run version', async () => {
    const abort = new AbortController();
    const renew = vi
      .fn<RunLeaseAuthority['renew']>()
      .mockResolvedValueOnce({
        kind: 'Renewed',
        receipt: receipt(2, '2026-09-24T20:00:15.000Z'),
      })
      .mockResolvedValueOnce({
        kind: 'Renewed',
        receipt: receipt(3, '2026-09-24T20:00:30.000Z'),
      });

    const keeping = keepRunLease(
      receipt(1, '2026-09-24T20:00:00.000Z'),
      0,
      { renew },
      new MonotonicLeaseClock(),
      abort.signal,
      {
        accept: (accepted) => {
          if (accepted.runVersion === 3) abort.abort();
        },
      },
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(keeping).resolves.toEqual({ kind: 'StoppedBySupervisor', latestRunVersion: 3 });
    expect(renew).toHaveBeenNthCalledWith(1, {
      runId,
      incarnationId,
      expectedRunVersion: 1,
    });
    expect(renew).toHaveBeenNthCalledWith(2, {
      runId,
      incarnationId,
      expectedRunVersion: 2,
    });
  });

  it('uses a five-second safety margin and loses the lease when renewal cannot be confirmed', async () => {
    const renew = vi.fn<RunLeaseAuthority['renew']>(() => Promise.resolve({ kind: 'Unavailable' }));
    const keeping = keepRunLease(
      receipt(1, '2026-09-24T20:00:00.000Z'),
      0,
      { renew },
      new MonotonicLeaseClock(),
      new AbortController().signal,
      { accept: () => undefined },
    );
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(keeping).resolves.toEqual({ kind: 'LeaseLost', lastAcceptedRunVersion: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a renewal whose binding or version does not advance exactly once', async () => {
    const renew = vi.fn<RunLeaseAuthority['renew']>(() =>
      Promise.resolve({
        kind: 'Renewed',
        receipt: { ...receipt(4, '2026-09-24T20:00:15.000Z'), incarnationId: crypto.randomUUID() },
      }),
    );

    const keeping = keepRunLease(
      receipt(1, '2026-09-24T20:00:00.000Z'),
      0,
      { renew },
      new MonotonicLeaseClock(),
      new AbortController().signal,
      { accept: () => undefined },
    );
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(keeping).resolves.toEqual({
      kind: 'LeaseReceiptRejected',
      lastAcceptedRunVersion: 1,
    });
  });
});
