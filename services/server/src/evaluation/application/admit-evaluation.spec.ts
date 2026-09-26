import { describe, expect, it } from 'vitest';

import { admitEvaluation } from './admit-evaluation.js';

const said = (letter: string): string => `E${letter.repeat(43)}`;
const id = (digit: string): string =>
  `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const budget = {
  providerRequests: 2,
  providerInputTokens: 100,
  providerOutputTokens: 100,
  providerSpendMicroUsd: 100,
  runWallTimeSeconds: 100,
  toolProposals: 100,
  aggregateChildCommandTimeSeconds: 100,
  changedFiles: 100,
  changedWorktreeBytes: 100,
  evidencePlusArtifactsPerRunBytes: 100,
};
const command = {
  version: 1 as const,
  commandId: id('1'),
  fingerprint: `sha256:${'a'.repeat(64)}`,
  taskId: id('2'),
  taskRevisionSaid: said('t'),
  originRunId: id('3'),
  retainedCheckpointSaid: said('c'),
  retainedSealSaid: said('s'),
  expectedActiveRevisionSaid: said('h'),
  personalAgentAid: said('a'),
  taskMandateSaid: said('m'),
  policySaid: said('p'),
  executionProfileSaid: said('e'),
  sourceInventorySaid: said('i'),
  allocation: { diagnosis: budget, perEntry: budget, finalization: budget },
};

describe('hosted evaluation admission', () => {
  it('does not reserve an Evaluation when qualification or current authority is absent', async () => {
    let commits = 0;
    const dependencies = {
      eligibility: {
        inspect: () =>
          Promise.resolve({ kind: 'Blocked' as const, gate: 'Qualification' as const }),
      },
      reservations: {
        reconcile: () => Promise.resolve({ kind: 'NotFound' as const }),
        reserve: () => {
          commits += 1;
          return Promise.reject(new Error('must not commit'));
        },
      },
    };
    expect(await admitEvaluation({ ownerAid: said('o'), command }, dependencies)).toEqual({
      kind: 'Blocked',
      gate: 'Qualification',
    });
    expect(commits).toBe(0);
  });

  it('rejects an allocation beyond the verified residual before a durable reservation', async () => {
    let commits = 0;
    const dependencies = {
      eligibility: {
        inspect: () => Promise.resolve({ kind: 'Eligible' as const, remaining: budget }),
      },
      reservations: {
        reconcile: () => Promise.resolve({ kind: 'NotFound' as const }),
        reserve: () => {
          commits += 1;
          return Promise.reject(new Error('must not commit'));
        },
      },
    };
    expect(await admitEvaluation({ ownerAid: said('o'), command }, dependencies)).toEqual({
      kind: 'Blocked',
      gate: 'Budget',
    });
    expect(commits).toBe(0);
  });

  it('returns the exact prior admission after a lost reply without allocating again', async () => {
    let inspections = 0;
    let reservations = 0;
    const prior = {
      kind: 'Admitted' as const,
      evaluationId: id('4'),
      version: 1,
      lease: {
        evaluationId: id('4'),
        leaseId: id('5'),
        version: 1,
        serverTime: '2026-09-26T05:00:00.000Z',
        expiresAt: '2026-09-26T05:00:45.000Z',
      },
      evidenceStreamId: id('6'),
      reservationSaid: said('r'),
    };
    expect(
      await admitEvaluation(
        { ownerAid: said('o'), command },
        {
          eligibility: {
            inspect: () => {
              inspections += 1;
              return Promise.resolve({ kind: 'Blocked' as const, gate: 'Budget' as const });
            },
          },
          reservations: {
            reconcile: () => Promise.resolve(prior),
            reserve: () => {
              reservations += 1;
              return Promise.resolve(prior);
            },
          },
        },
      ),
    ).toEqual(prior);
    expect(inspections).toBe(0);
    expect(reservations).toBe(0);
  });
});
