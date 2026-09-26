import { blockRun, type Run, type RunBlockedReason } from '@devrandom/domain';
import type { PublicVerifierReceipt } from '@devrandom/protocol';
import type { EvidenceRecorder, RunSettlement } from '@devrandom/runtime';

import type { RunCheckpointing } from './verified-run-checkpoint.js';
import { evidenceSealingFailure, type RunEvidenceSealing } from './sealed-evidence-settlement.js';

/** Settle a proved block without changing the Run's purpose or earning calibration credit. */
export async function settleBlockedRun(
  input: {
    readonly run: Run;
    readonly reason: Exclude<RunBlockedReason, 'ProcessLost'>;
    readonly verifierReceipts: readonly PublicVerifierReceipt[];
    readonly outputArtifactSaids: readonly string[];
  },
  dependencies: {
    readonly evidence: EvidenceRecorder;
    readonly checkpointing: RunCheckpointing;
    readonly sealing: RunEvidenceSealing;
    now(): string;
  },
): Promise<RunSettlement> {
  const { run, reason, verifierReceipts, outputArtifactSaids } = input;
  const { evidence, checkpointing, sealing } = dependencies;
  const materialized = await checkpointing.materialize({
    run,
    verifierReceipts,
    outputArtifactSaids,
    disposition: {
      runState: {
        kind: 'Active',
        phase: { kind: 'Blocked', reason },
        verification: run.submissionVerification,
      },
      continuation:
        reason === 'HarnessCompatibilityFailure'
          ? { kind: 'LaterHarnessCompatibilityResolutionRequired' }
          : reason === 'UserInterrupted'
            ? { kind: 'LaterRuntimeRecoveryRequired' }
            : { kind: 'ExternalResolutionRequired', reason },
    },
  });
  if (materialized.kind !== 'Materialized') return { kind: 'Unavailable' };
  const blocked = blockRun(run, { reason, checkpointSaid: materialized.checkpoint.d });
  if (blocked.kind !== 'Blocked') return { kind: 'Unavailable' };
  const recorded = evidence.record({
    occurredAt: dependencies.now(),
    producer: { kind: 'RunSupervisor' },
    event: { kind: 'RunBlocked', reason, checkpointSaid: materialized.checkpoint.d },
  });
  if (recorded.kind !== 'Recorded') return { kind: 'Unavailable' };
  const sealed = await sealing.settle(evidence, materialized.checkpoint.d);
  return sealed.kind === 'Sealed'
    ? { kind: 'Settled', run: blocked.run }
    : { kind: 'EvidenceSealingFailed', failure: evidenceSealingFailure(sealed) };
}
