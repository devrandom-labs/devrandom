import {
  validateExecutionBinding,
  type EvaluationExecutionBinding,
  type TrialUsage,
} from '@devrandom/domain';
import {
  bindEvaluationVerifierBundle,
  decodeEvaluationManifest,
  prepareTrialObservationEvidence,
  type EvidenceArtifact,
  type EvaluationManifest,
  type EvaluationVerifierBundle,
  type TrialObservationEvidence,
} from '@devrandom/protocol';

import type { ProtectedTrialArtifactObservation } from './observe-protected-trial-artifact.js';

/** Only trusted parent measurement over accepted trial evidence may supply usage. */
export interface VerifiedTrialUsage {
  measure(input: {
    readonly binding: EvaluationExecutionBinding;
    readonly trialEvidenceHeadSaid: string;
    readonly providerUsageEventSaids: readonly string[];
    readonly custodyEvidenceHeadSaid: string;
    readonly custodyEvidenceSequence: number;
  }): Promise<
    | {
        readonly kind: 'Verified';
        readonly trialEvidenceHeadSaid: string;
        readonly providerUsageEventSaids: readonly string[];
        readonly custodyEvidenceHeadSaid: string;
        readonly custodyEvidenceSequence: number;
        readonly usage: TrialUsage;
      }
    | { readonly kind: 'Missing' | 'Unavailable' }
  >;
}

export type MeasuredTrialObservationPreparation =
  | {
      readonly kind: 'Prepared';
      readonly evidence: TrialObservationEvidence;
      readonly artifact: EvidenceArtifact;
      readonly bytes: Uint8Array;
    }
  | {
      readonly kind: 'Incomplete';
      readonly reason: 'Manifest' | 'Binding' | 'Observation' | 'Usage';
    };

function sameStrings(first: readonly string[], second: readonly string[]): boolean {
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

/** E3 parent-only step: a protected ACK becomes a typed observation after measured usage. */
export async function prepareMeasuredTrialObservation(
  input: {
    readonly binding: EvaluationExecutionBinding;
    readonly manifest: EvaluationManifest;
    readonly verifier: EvaluationVerifierBundle;
    readonly retained: ProtectedTrialArtifactObservation;
  },
  ports: { readonly measure: VerifiedTrialUsage['measure'] },
): Promise<MeasuredTrialObservationPreparation> {
  const { binding, manifest, verifier, retained } = input;
  if (
    decodeEvaluationManifest(manifest).kind !== 'Accepted' ||
    bindEvaluationVerifierBundle(verifier, manifest).kind !== 'Bound' ||
    manifest.heldOutCaseCount !== 1
  )
    return { kind: 'Incomplete', reason: 'Manifest' };
  const phase = binding.phase;
  if (
    validateExecutionBinding(binding).kind !== 'Accepted' ||
    phase.kind !== 'Trial' ||
    phase.manifestSaid !== manifest.d ||
    binding.evaluationId !== manifest.evaluationId ||
    binding.taskId !== manifest.taskId ||
    binding.taskRevisionSaid !== manifest.taskRevisionSaid ||
    binding.originRunId !== manifest.originRunId ||
    binding.personalAgentAid !== manifest.personalAgentAid ||
    binding.taskMandateSaid !== manifest.taskMandateSaid ||
    binding.harnessRevisionSaid !==
      (phase.arm === 'H1TaskSearch' ? manifest.revisions.H1 : manifest.revisions[phase.arm]) ||
    !manifest.slots.some(
      (slot) =>
        slot.arm === phase.arm &&
        slot.repetition === phase.repetition &&
        slot.attempt === phase.attempt,
    )
  )
    return { kind: 'Incomplete', reason: 'Binding' };
  if (retained.kind !== 'Retained') return { kind: 'Incomplete', reason: 'Observation' };
  const publicIds = verifier.publicConditions.map((condition) => condition.id);
  if (
    !sameStrings(manifest.publicConditionIds, publicIds) ||
    !sameStrings(
      retained.publicCases.map((item) => item.id),
      publicIds,
    ) ||
    retained.capturedSourceSaid !== retained.frozenArtifact.sourceSaid ||
    !/^[A-Z][A-Za-z0-9_-]{43}$/u.test(retained.custodyEvidenceHeadSaid) ||
    !Number.isSafeInteger(retained.custodyEvidenceSequence) ||
    retained.custodyEvidenceSequence < 0 ||
    !sameStrings(retained.acknowledgedArtifactSaids, [
      verifier.protectedCase.stimulus.d,
      verifier.protectedCase.expected.d,
      retained.protectedObservationSaid,
    ])
  )
    return { kind: 'Incomplete', reason: 'Observation' };
  let measured: Awaited<ReturnType<VerifiedTrialUsage['measure']>>;
  try {
    measured = await ports.measure({
      binding,
      trialEvidenceHeadSaid: retained.trialEvidenceHeadSaid,
      providerUsageEventSaids: retained.providerUsageEventSaids,
      custodyEvidenceHeadSaid: retained.custodyEvidenceHeadSaid,
      custodyEvidenceSequence: retained.custodyEvidenceSequence,
    });
  } catch {
    return { kind: 'Incomplete', reason: 'Usage' };
  }
  if (
    measured.kind !== 'Verified' ||
    measured.trialEvidenceHeadSaid !== retained.trialEvidenceHeadSaid ||
    !sameStrings(measured.providerUsageEventSaids, retained.providerUsageEventSaids) ||
    measured.custodyEvidenceHeadSaid !== retained.custodyEvidenceHeadSaid ||
    measured.custodyEvidenceSequence !== retained.custodyEvidenceSequence
  )
    return { kind: 'Incomplete', reason: 'Usage' };
  const publicCases = retained.publicCases.map((item) => ({
    conditionId: item.id,
    rawObservationSaid: item.rawObservationSaid,
    verdict: item.verdict,
  }));
  const prepared = prepareTrialObservationEvidence({
    version: 1,
    kind: 'TrialObservationEvidence',
    evaluationId: manifest.evaluationId,
    manifestSaid: manifest.d,
    harnessRevisionSaid: binding.harnessRevisionSaid,
    observation: {
      slot: { arm: phase.arm, repetition: phase.repetition, attempt: phase.attempt },
      disposition: {
        kind: 'Measured',
        artifactSaid: retained.frozenArtifact.executableSaid,
        publicConditionIds: publicCases
          .filter((item) => item.verdict === 'Pass')
          .map((item) => item.conditionId),
        heldOutConditionIds:
          retained.protectedVerdict === 'Pass' ? [verifier.protectedCase.objectSaid] : [],
        usage: measured.usage,
      },
    },
    capturedSourceSaid: retained.capturedSourceSaid,
    trialEvidenceHeadSaid: retained.trialEvidenceHeadSaid,
    trialCleanupReceiptSaid: retained.trialCleanupReceiptSaid,
    publicObservations: publicCases,
    protectedObservationSaid: retained.protectedObservationSaid,
    protectedVerdict: retained.protectedVerdict,
    protectedCleanupReceiptSaid: retained.protectedCleanupReceiptSaid,
    providerUsageEventSaids: retained.providerUsageEventSaids,
  });
  return prepared.kind === 'Prepared'
    ? {
        kind: 'Prepared',
        evidence: prepared.evidence,
        artifact: prepared.artifact,
        bytes: prepared.bytes,
      }
    : { kind: 'Incomplete', reason: 'Usage' };
}
