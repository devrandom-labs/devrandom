import { describe, expect, it, vi } from 'vitest';

import { acquireFirstRunLease } from '@devrandom/domain';

import { runFixture } from '../test/run-fixture.js';
import { acquireRunLease, type AcquireRunLeaseDependencies } from './acquire-run-lease.js';

const owner = { ownerAid: runFixture().binding.ownerAid, credentialSaid: `E${'w'.repeat(43)}` };
const input = {
  owner,
  runId: runFixture().binding.runId,
  incarnationId: 'ee87e11d-fb5f-46b4-841f-8a7a5faad97c',
  command: { version: 1 as const, expectedRunVersion: 0 },
};

function dependencies(): AcquireRunLeaseDependencies {
  return {
    currentUserCredential: {
      verify: () => Promise.resolve({ kind: 'UserCredentialCurrent' }),
    },
    leases: {
      acquire: (request) => {
        const acquired = acquireFirstRunLease(runFixture(), request);
        return Promise.resolve(
          acquired.kind === 'Acquired'
            ? { kind: 'RunLeaseAcquired', run: acquired.run }
            : { kind: 'RunLeaseConcurrentUpdate' },
        );
      },
    },
    now: () => '2026-09-24T20:00:00.000Z',
  };
}

describe('first Run lease application', () => {
  it('rechecks the user credential and returns the server-time lease receipt', async () => {
    const verify = vi.fn(() => Promise.resolve({ kind: 'UserCredentialCurrent' as const }));

    const outcome = await acquireRunLease(input, {
      ...dependencies(),
      currentUserCredential: { verify },
    });

    expect(outcome).toEqual({
      kind: 'RunLeaseAcquired',
      projection: {
        version: 1,
        disposition: 'Acquired',
        runId: input.runId,
        incarnationId: input.incarnationId,
        runVersion: 1,
        serverTime: '2026-09-24T20:00:00.000Z',
        expiresAt: '2026-09-24T20:00:45.000Z',
      },
    });
    expect(verify).toHaveBeenCalledExactlyOnceWith(owner);
  });

  it('does not touch the Run when the current user credential fails closed', async () => {
    const acquire = vi.fn<AcquireRunLeaseDependencies['leases']['acquire']>();

    const outcome = await acquireRunLease(input, {
      ...dependencies(),
      currentUserCredential: {
        verify: () => Promise.resolve({ kind: 'UserCredentialNotCurrent' }),
      },
      leases: { acquire },
    });

    expect(outcome).toEqual({ kind: 'RunLeaseForbidden', reason: 'UserCredentialNotCurrent' });
    expect(acquire).not.toHaveBeenCalled();
  });
});
