import type { RunLeaseProjection } from '@devrandom/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { HostedRuns } from '../application/baseline-run-admission.js';
import { HostedRunLeaseAuthority, initialRunLeaseReceipt } from './hosted-run-lease-authority.js';

const runId = '1cc482f1-98e9-4454-8e4c-5566cb47ce3d';
const incarnationId = 'ee87e11d-fb5f-46b4-841f-8a7a5faad97c';

function hosted(renewLease: HostedRuns['renewLease']): HostedRuns {
  return {
    admit: vi.fn(),
    inspect: vi.fn(),
    acquireLease: vi.fn(),
    renewLease,
  };
}

describe('hosted Run lease authority', () => {
  it('maps the exact initial projection and renews from the accepted version', async () => {
    const projection: RunLeaseProjection = {
      version: 1,
      disposition: 'Acquired',
      runId,
      incarnationId,
      runVersion: 1,
      serverTime: '2026-09-24T20:00:01.000Z',
      expiresAt: '2026-09-24T20:10:01.000Z',
    };
    expect(initialRunLeaseReceipt(projection)).toEqual({
      runId,
      incarnationId,
      runVersion: 1,
      serverTime: projection.serverTime,
      expiresAt: projection.expiresAt,
    });
    const renewLease = vi.fn<HostedRuns['renewLease']>(() =>
      Promise.resolve({
        kind: 'Renewed',
        receipt: {
          version: 1,
          runId,
          incarnationId,
          runVersion: 2,
          serverTime: '2026-09-24T20:05:01.000Z',
          expiresAt: '2026-09-24T20:15:01.000Z',
        },
      }),
    );
    const authority = new HostedRunLeaseAuthority(hosted(renewLease));

    await expect(authority.renew({ runId, incarnationId, expectedRunVersion: 1 })).resolves.toEqual(
      {
        kind: 'Renewed',
        receipt: {
          runId,
          incarnationId,
          runVersion: 2,
          serverTime: '2026-09-24T20:05:01.000Z',
          expiresAt: '2026-09-24T20:15:01.000Z',
        },
      },
    );
    expect(renewLease).toHaveBeenCalledWith(runId, incarnationId, {
      version: 1,
      expectedRunVersion: 1,
    });
  });

  it('keeps rejection distinct from transport and response unavailability', async () => {
    const rejected = new HostedRunLeaseAuthority(
      hosted(() =>
        Promise.resolve({
          kind: 'RequestRejected',
          problem: {
            type: 'https://devrandom.example/problems/run-conflict',
            title: 'Run command conflicts with durable state',
            status: 409,
            code: 'RunConflict',
            correlationId: '97e16745-4b76-4de3-9ae5-a183496e73e8',
            reason: 'LeaseConflict',
            incarnationId,
            expiresAt: '2026-09-24T20:10:01.000Z',
            currentVersion: 2,
          },
        }),
      ),
    );
    await expect(rejected.renew({ runId, incarnationId, expectedRunVersion: 1 })).resolves.toEqual({
      kind: 'Rejected',
    });

    for (const kind of ['ServerUnavailable', 'ResponseInvalid'] as const) {
      const unavailable = new HostedRunLeaseAuthority(hosted(() => Promise.resolve({ kind })));
      await expect(
        unavailable.renew({ runId, incarnationId, expectedRunVersion: 1 }),
      ).resolves.toEqual({ kind: 'Unavailable' });
    }
  });
});
