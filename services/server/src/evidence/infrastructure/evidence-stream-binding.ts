import { createEvidenceStream, type EvidenceStream, type Run } from '@devrandom/domain';

export function currentEvidenceStream(run: Run): EvidenceStream | undefined {
  // A successor stream must be durably created with its remaining per-Run byte ceiling
  // in the same transaction as the replacement lease. Never synthesize a fresh quota.
  if (run.lease.kind !== 'Held' || run.currentExecution !== undefined) {
    return undefined;
  }
  const created = createEvidenceStream({
    streamId: run.binding.evidenceStreamId,
    runId: run.binding.runId,
    ownerAid: run.binding.ownerAid,
    taskId: run.binding.taskId,
    taskRevisionSaid: run.binding.taskRevisionSaid,
    incarnationId: run.lease.incarnationId,
    harnessRevisionSaid: run.binding.initialHarnessRevisionSaid,
    personalAgentAid: run.binding.personalAgentAid,
    taskMandateSaid: run.binding.taskMandateSaid,
    combinedByteCeiling: run.binding.budget.evidencePlusArtifactsPerRunBytes,
  });
  return created.kind === 'Created' ? created.stream : undefined;
}
