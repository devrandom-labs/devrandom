import { describe, expect, it } from 'vitest';
import { assessRuntimeRecoveryBatch } from './runtime-recovery-reconciliation.js';
import { runtimeRecoveryFixture } from '../test/runtime-recovery-fixture.js';

describe('expired startup-only runtime recovery', () => {
  it('rejects over-ceiling consumed wall time even when remaining is clamped to zero', () => {
    expect(assessRuntimeRecoveryBatch(runtimeRecoveryFixture(273)).kind).toBe('Rejected');
  });
  it('admits truthful ProcessLost bookkeeping and rejects new execution or altered inherited accounting', () => {
    const input = runtimeRecoveryFixture();
    expect(
      input.predecessorCheckpoint.verifierReceipts.every(
        (receipt) =>
          receipt.outcome.kind === 'Unresolved' && receipt.outcome.reason === 'RunBlocked',
      ),
    ).toBe(true);
    expect(assessRuntimeRecoveryBatch(input)).toEqual({ kind: 'Accepted', phase: 'Checkpoint' });
    const predecessor = input.predecessorCheckpoint;
    if (predecessor.version !== 1) throw new Error('expected ordinary checkpoint');
    for (const replacement of [
      { ...predecessor, verifierReceipts: [] },
      { ...predecessor, outputArtifactSaids: [] },
      {
        ...predecessor,
        repository: { ...predecessor.repository, baseTree: 'f'.repeat(40) },
      },
    ]) {
      expect(
        assessRuntimeRecoveryBatch({ ...input, predecessorCheckpoint: replacement }).kind,
      ).toBe('Rejected');
    }
    expect(
      assessRuntimeRecoveryBatch({
        ...input,
        receivedAt: input.run.lease.kind === 'Held' ? input.run.lease.acquiredAt : '',
      }).kind,
    ).toBe('Rejected');
    expect(
      assessRuntimeRecoveryBatch({
        ...input,
        expected: { ...input.expected, chainHeadSaid: `E${'x'.repeat(43)}` },
      }).kind,
    ).toBe('Rejected');
    expect(
      assessRuntimeRecoveryBatch({ ...input, acceptedEvents: input.acceptedEvents.slice(0, 3) })
        .kind,
    ).toBe('Rejected');
    expect(
      assessRuntimeRecoveryBatch({
        ...input,
        run: { ...input.run, consumedBudget: { ...input.run.consumedBudget, providerRequests: 1 } },
      }).kind,
    ).toBe('Rejected');
  });
});
