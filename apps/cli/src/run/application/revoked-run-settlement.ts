import { revokeRunAuthority, type Run } from '@devrandom/domain';
import type { EvidenceRecorder, RunSettlement } from '@devrandom/runtime';

import type { SubmittedVerificationCustody } from './run-submissions.js';
import type { UnresolvedPublicTaskVerification } from './public-task-verification.js';
import type { RunCheckpointing } from './verified-run-checkpoint.js';
import { evidenceSealingFailure, type RunEvidenceSealing } from './sealed-evidence-settlement.js';

export async function settleRevokedRun(
  run: Run,
  dependencies: {
    readonly custody: SubmittedVerificationCustody;
    readonly verification: UnresolvedPublicTaskVerification;
    readonly checkpointing: RunCheckpointing;
    readonly sealing: RunEvidenceSealing;
    readonly evidence: EvidenceRecorder;
  },
): Promise<RunSettlement> {
  const { custody, verification, checkpointing, sealing, evidence } = dependencies;
  const transferred = custody.transferSubmittedVerification();
  if (transferred.kind === 'AlreadyTransferred') return { kind: 'Unavailable' };
  const receipts =
    transferred.kind === 'Transferred'
      ? transferred.verification.receipts
      : verification.unresolvedReceipts('RunBlocked');
  if (receipts === undefined) return { kind: 'Unavailable' };
  const materialized = await checkpointing.materialize({
    run,
    verifierReceipts: receipts,
    outputArtifactSaids:
      transferred.kind === 'Transferred' ? transferred.verification.outputArtifactSaids : [],
    disposition: {
      runState: {
        kind: 'Ended',
        outcome: { kind: 'AuthorityRevoked', mandateSaid: run.binding.taskMandateSaid },
        verification: run.submissionVerification,
      },
      continuation: { kind: 'NoContinuation' },
    },
  });
  if (materialized.kind !== 'Materialized') return { kind: 'Unavailable' };
  const revoked = revokeRunAuthority(run, {
    mandateSaid: run.binding.taskMandateSaid,
    checkpointSaid: materialized.checkpoint.d,
  });
  if (revoked.kind !== 'AuthorityRevoked') return { kind: 'Unavailable' };
  const sealed = await sealing.settle(evidence, materialized.checkpoint.d);
  return sealed.kind === 'Sealed'
    ? { kind: 'Settled', run: revoked.run }
    : { kind: 'EvidenceSealingFailed', failure: evidenceSealingFailure(sealed) };
}
