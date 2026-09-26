import { describe, expect, it } from 'vitest';

import type { RunLeaseReceipt } from './lease-keeper.js';
import { AcceptedRunLease } from './accepted-run-lease.js';

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

describe('accepted monotonic Run lease', () => {
  it.each([
    { remaining: 20_000, expected: 'Held' },
    { remaining: 5_000, expected: 'Lost' },
    { remaining: 0, expected: 'Unavailable' },
    { remaining: -1, expected: 'Unavailable' },
    { remaining: 45_001, expected: 'Unavailable' },
  ] as const)(
    'interprets a remaining server interval of $remaining milliseconds',
    async ({ remaining, expected }) => {
      const initial = receipt(1, '2026-09-24T20:00:00.000Z');
      const lease = new AcceptedRunLease(
        {
          ...initial,
          expiresAt: new Date(Date.parse(initial.serverTime) + remaining).toISOString(),
        },
        { monotonicNow: () => 0 },
        0,
      );
      await expect(lease.inspect({ runId, incarnationId })).resolves.toEqual({ kind: expected });
    },
  );
  it('does not add renewal response latency to tool authority', async () => {
    let now = 0;
    const lease = new AcceptedRunLease(
      receipt(1, '2026-09-24T20:00:00.000Z'),
      {
        monotonicNow: () => now,
      },
      now,
    );
    now = 35_000;
    lease.accept(receipt(2, '2026-09-24T20:00:15.000Z'), 15_000);
    now = 54_999;
    await expect(lease.inspect({ runId, incarnationId })).resolves.toEqual({ kind: 'Held' });
    now = 55_000;
    await expect(lease.inspect({ runId, incarnationId })).resolves.toEqual({ kind: 'Lost' });
  });
  it('reports Held only before the conservative deadline for the exact Run incarnation', async () => {
    let now = 1_000;
    const lease = new AcceptedRunLease(
      receipt(1, '2026-09-24T20:00:00.000Z'),
      {
        monotonicNow: () => now,
      },
      now,
    );

    await expect(lease.inspect({ runId, incarnationId })).resolves.toEqual({ kind: 'Held' });
    await expect(
      lease.inspect({ runId, incarnationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
    ).resolves.toEqual({ kind: 'Lost' });
    now = 40_999;
    await expect(lease.inspect({ runId, incarnationId })).resolves.toEqual({ kind: 'Held' });
    now = 41_000;
    await expect(lease.inspect({ runId, incarnationId })).resolves.toEqual({ kind: 'Lost' });
  });

  it('extends ownership only from the next exact accepted receipt received before uncertainty', async () => {
    let now = 1_000;
    const lease = new AcceptedRunLease(
      receipt(1, '2026-09-24T20:00:00.000Z'),
      {
        monotonicNow: () => now,
      },
      now,
    );
    now = 16_000;
    lease.accept(receipt(2, '2026-09-24T20:00:15.000Z'), 16_000);
    now = 55_999;
    await expect(lease.inspect({ runId, incarnationId })).resolves.toEqual({ kind: 'Held' });
    now = 56_000;
    await expect(lease.inspect({ runId, incarnationId })).resolves.toEqual({ kind: 'Lost' });

    const conflicting = new AcceptedRunLease(
      receipt(1, '2026-09-24T20:00:00.000Z'),
      {
        monotonicNow: () => 2_000,
      },
      2_000,
    );
    conflicting.accept(
      { ...receipt(2, '2026-09-24T20:00:15.000Z'), runId: crypto.randomUUID() },
      2_000,
    );
    await expect(conflicting.inspect({ runId, incarnationId })).resolves.toEqual({ kind: 'Lost' });
  });

  it('is unavailable rather than guessing when the monotonic clock is invalid', async () => {
    const lease = new AcceptedRunLease(
      receipt(1, '2026-09-24T20:00:00.000Z'),
      {
        monotonicNow: () => Number.NaN,
      },
      Number.NaN,
    );

    await expect(lease.inspect({ runId, incarnationId })).resolves.toEqual({
      kind: 'Unavailable',
    });
  });

  it('never restores ownership after the conservative deadline has been observed', async () => {
    let now = 1_000;
    const lease = new AcceptedRunLease(
      receipt(1, '2026-09-24T20:00:00.000Z'),
      {
        monotonicNow: () => now,
      },
      now,
    );

    now = 41_000;
    await expect(lease.inspect({ runId, incarnationId })).resolves.toEqual({ kind: 'Lost' });
    now = 2_000;
    await expect(lease.inspect({ runId, incarnationId })).resolves.toEqual({ kind: 'Lost' });
  });
});
