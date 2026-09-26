import { describe, expect, it } from 'vitest';

import { acquireFirstRunLease, renewRunLease } from '@devrandom/domain';

import { runFixture } from '../test/run-fixture.js';
import { renewHeldRunLease, type RenewRunLeaseDependencies } from './renew-run-lease.js';

const runId = runFixture().binding.runId;
const incarnationId = 'ee87e11d-fb5f-46b4-841f-8a7a5faad97c';
const ownerAid = runFixture().binding.ownerAid;

function heldRun() {
  const acquired = acquireFirstRunLease(runFixture(), {
    incarnationId,
    expectedRunVersion: 0,
    serverTime: '2026-09-24T20:00:00.000Z',
  });
  if (acquired.kind !== 'Acquired') {
    throw new Error('expected a held lease fixture');
  }
  return acquired.run;
}

function dependencies(): RenewRunLeaseDependencies {
  return {
    leases: {
      renew: (input) => {
        const renewed = renewRunLease(heldRun(), input);
        return Promise.resolve(
          renewed.kind === 'Renewed'
            ? { kind: 'RunLeaseRenewed', run: renewed.run }
            : { kind: 'RunLeaseConcurrentUpdate' },
        );
      },
    },
    now: () => '2026-09-24T20:00:15.000Z',
  };
}

describe('held Run lease renewal application', () => {
  it('returns the exact server-time receipt needed for a monotonic local deadline', async () => {
    await expect(
      renewHeldRunLease(
        {
          ownerAid,
          runId,
          incarnationId,
          command: { version: 1, expectedRunVersion: 1 },
        },
        dependencies(),
      ),
    ).resolves.toEqual({
      kind: 'RunLeaseRenewed',
      receipt: {
        version: 1,
        runId,
        incarnationId,
        runVersion: 2,
        serverTime: '2026-09-24T20:00:15.000Z',
        expiresAt: '2026-09-24T20:01:00.000Z',
      },
    });
  });
});
