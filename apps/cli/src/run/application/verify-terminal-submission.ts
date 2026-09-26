import type { Run } from '@devrandom/domain';
import { decodeRunTerminalVerification } from '@devrandom/protocol';
import type { RunPredecessorCustody } from './run-predecessor-custody.js';

/** Inspect the already sealed proof; verification retries never run another case or writer. */
export function verifyTerminalSubmission(
  run: Run,
  custody: RunPredecessorCustody,
):
  | {
      readonly kind: 'Verified';
      readonly runId: string;
      readonly receiptArtifactSaid: string;
      readonly submittedSourceSaid: string;
      readonly verificationSourceSaid: string;
      readonly manifestSaid: string;
      readonly terminalCaseArtifactSaid: string;
    }
  | { readonly kind: 'Rejected' } {
  if (
    run.lifecycle.kind !== 'Ended' ||
    run.lifecycle.outcome.kind !== 'Submitted' ||
    run.submissionVerification.kind !== 'Accepted' ||
    run.currentExecution === undefined ||
    custody.stream.seal.kind !== 'Sealed' ||
    custody.checkpoint.d !== run.lifecycle.outcome.checkpointSaid ||
    custody.checkpoint.runState.kind !== 'Ended' ||
    custody.checkpoint.runState.outcome.kind !== 'Submitted' ||
    custody.checkpoint.runState.verification.kind !== 'Accepted'
  )
    return { kind: 'Rejected' };
  for (const { artifact, bytes } of custody.artifacts) {
    if (!custody.checkpoint.outputArtifactSaids.includes(artifact.d)) continue;
    const decoded = decodeRunTerminalVerification(artifact, bytes);
    if (decoded.kind !== 'Accepted') continue;
    const receipt = decoded.receipt;
    if (
      receipt.runId !== run.binding.runId ||
      receipt.taskRevisionSaid !== run.binding.taskRevisionSaid ||
      receipt.harnessRevisionSaid !== run.currentExecution.harnessRevisionSaid ||
      receipt.segmentSaid !== run.currentExecution.segmentSaid ||
      receipt.verdict !== 'Pass' ||
      !custody.events.some(
        (event) =>
          event.event.kind === 'ResultSubmitted' &&
          event.event.artifactSaids.includes(receipt.submittedSourceSaid),
      ) ||
      !custody.events.some(
        (event) =>
          event.producer.kind === 'ProtectedTaskVerifier' &&
          event.event.kind === 'Observation' &&
          event.event.artifactSaid === artifact.d,
      )
    )
      return { kind: 'Rejected' };
    return {
      kind: 'Verified',
      runId: run.binding.runId,
      receiptArtifactSaid: artifact.d,
      submittedSourceSaid: receipt.submittedSourceSaid,
      verificationSourceSaid: receipt.verificationSourceSaid,
      manifestSaid: receipt.manifestSaid,
      terminalCaseArtifactSaid: receipt.terminalCaseArtifactSaid,
    };
  }
  return { kind: 'Rejected' };
}
