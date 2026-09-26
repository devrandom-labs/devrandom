import { describe, expect, it, vi } from 'vitest';

import { acquireFirstRunLease } from '@devrandom/domain';

import { harnessTask } from '../../harness/test/harness-command-fixture.js';
import { runFixture } from '../test/run-fixture.js';
import { admitRunContinuation, type RunContinuationCommitments } from './admit-run-continuation.js';

const initial = runFixture();
const leased = acquireFirstRunLease(initial, {
  incarnationId: 'ee87e11d-fb5f-46b4-841f-8a7a5faad97c',
  expectedRunVersion: initial.version,
  serverTime: '2026-09-24T20:00:00.000Z',
});
if (leased.kind !== 'Acquired') throw new Error('lease fixture');
const run = leased.run;
const owner = { ownerAid: run.binding.ownerAid, credentialSaid: `E${'w'.repeat(43)}` };
const command = {
  version: 1 as const,
  expectedRunVersion: run.version,
  predecessorCheckpointSaid: `E${'c'.repeat(43)}`,
  predecessorSealSaid: `E${'s'.repeat(43)}`,
  predecessorHeadSaid: `E${'h'.repeat(43)}`,
  successorIncarnationId: '8b7758da-e018-4c6d-9ae5-8ad172a6b005',
  successorStreamId: '9c7758da-e018-4c6d-9ae5-8ad172a6b005',
  expectedActivePointerVersion: 2,
  expectedActivationReceiptSaid: `E${'a'.repeat(43)}`,
};

function dependencies(
  overrides: {
    readonly disposition?: 'Activated' | 'Retained';
    readonly mandate?: 'Current' | 'Revoked';
    readonly credential?: 'Current' | 'Revoked';
  } = {},
) {
  const admit = vi.fn<RunContinuationCommitments['admit']>(() =>
    Promise.resolve({ kind: 'Rejected' }),
  );
  return {
    credentials: {
      verify: () =>
        Promise.resolve({
          kind:
            overrides.credential === 'Revoked'
              ? ('UserCredentialNotCurrent' as const)
              : ('UserCredentialCurrent' as const),
        }),
    },
    runs: { findById: () => Promise.resolve({ kind: 'RunFound' as const, run }) },
    mandates: {
      authorize: () =>
        Promise.resolve(
          overrides.mandate === 'Revoked'
            ? ({ kind: 'TaskMandateRevoked' } as const)
            : ({
                kind: 'CurrentRunMandatesAuthorized',
                task: { ...harnessTask, revisionSaid: run.binding.taskRevisionSaid },
                personalAgentAid: run.binding.personalAgentAid,
                taskMandateSaid: run.binding.taskMandateSaid,
                taskMandateBudget: run.binding.budget,
                governorAid: run.binding.governorAid,
                promotionMandateSaid: run.binding.promotionMandateSaid,
              } as const),
        ),
    },
    activation: {
      read: () =>
        Promise.resolve({
          kind: 'Read' as const,
          pointer: {
            version: 1 as const,
            kind: 'Committed' as const,
            taskId: run.binding.taskId,
            taskRevisionSaid: run.binding.taskRevisionSaid,
            harnessLineageId: run.binding.harnessLineageId,
            activeRevisionSaid: `E${'z'.repeat(43)}`,
            pointerVersion: 2,
            commandId: '122c06be-9aa2-47c3-8f45-0e93fc2ce6e0',
            decisionReceiptSaid: command.expectedActivationReceiptSaid,
            disposition: overrides.disposition ?? 'Activated',
          },
        }),
    },
    commitments: { admit },
    now: () => '2026-09-24T20:00:46.000Z',
  };
}

describe('same-Run continuation admission authority', () => {
  it('never reaches the replacement writer after revoked credential or mandate or retained pointer', async () => {
    for (const option of [
      { credential: 'Revoked' as const },
      { mandate: 'Revoked' as const },
      { disposition: 'Retained' as const },
    ]) {
      const ports = dependencies(option);
      expect(
        await admitRunContinuation({ owner, runId: run.binding.runId, command }, ports),
      ).toEqual({ kind: 'Rejected' });
      expect(ports.commitments.admit).not.toHaveBeenCalled();
    }
  });

  it('binds the exact verified activation to the writer and rejects a substituted receipt', async () => {
    const ports = dependencies();
    expect(await admitRunContinuation({ owner, runId: run.binding.runId, command }, ports)).toEqual(
      { kind: 'Rejected' },
    );
    const [admission] = ports.commitments.admit.mock.calls[0] ?? [];
    expect(admission).toMatchObject({
      ownerAid: owner.ownerAid,
      run,
      command,
      activation: { pointerVersion: 2, disposition: 'Activated' },
    });
    const changed = { ...command, expectedActivationReceiptSaid: `E${'q'.repeat(43)}` };
    const newPorts = dependencies();
    expect(
      await admitRunContinuation({ owner, runId: run.binding.runId, command: changed }, newPorts),
    ).toEqual({ kind: 'Rejected' });
    expect(newPorts.commitments.admit).not.toHaveBeenCalled();
  });
});

it('binds calibration recovery to the unchanged initial pointer without Governor activation', async () => {
  const ports = dependencies();
  const calibration = {
    ...run,
    binding: {
      ...run.binding,
      purpose: {
        kind: 'PreparedCompatibilityCalibration' as const,
        campaignId: 'a6b175e6-6b6a-4d34-9c31-23879b37752e',
        ordinal: 1 as const,
      },
    },
  };
  const { expectedActivePointerVersion, expectedActivationReceiptSaid, ...common } = command;
  expect(expectedActivePointerVersion).toBe(2);
  expect(expectedActivationReceiptSaid).toBeTruthy();
  const recovery = {
    ...common,
    version: 2 as const,
    kind: 'CalibrationContinuation' as const,
    expectedHarnessRevisionSaid: run.binding.initialHarnessRevisionSaid,
  };
  const initialPointer = {
    version: 1 as const,
    kind: 'Initial' as const,
    pointerVersion: 1 as const,
    taskId: run.binding.taskId,
    taskRevisionSaid: run.binding.taskRevisionSaid,
    harnessLineageId: run.binding.harnessLineageId,
    activeRevisionSaid: run.binding.initialHarnessRevisionSaid,
  };
  const current = {
    ...ports,
    runs: { findById: () => Promise.resolve({ kind: 'RunFound' as const, run: calibration }) },
    activation: { read: () => Promise.resolve({ kind: 'Read' as const, pointer: initialPointer }) },
  };
  await admitRunContinuation(
    { owner, runId: calibration.binding.runId, command: recovery },
    current,
  );
  expect(ports.commitments.admit).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ run: calibration, command: recovery, activation: initialPointer }),
  );
  ports.commitments.admit.mockClear();
  expect(
    await admitRunContinuation(
      {
        owner,
        runId: calibration.binding.runId,
        command: { ...recovery, expectedHarnessRevisionSaid: `E${'q'.repeat(43)}` },
      },
      current,
    ),
  ).toEqual({ kind: 'Rejected' });
  expect(ports.commitments.admit).not.toHaveBeenCalled();
  expect(
    await admitRunContinuation(
      { owner, runId: run.binding.runId, command: recovery },
      { ...current, runs: ports.runs },
    ),
  ).toEqual({ kind: 'Rejected' });
  expect(ports.commitments.admit).not.toHaveBeenCalled();
});
