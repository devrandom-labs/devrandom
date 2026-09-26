import { isDeepStrictEqual } from 'node:util';

import { type EvaluationExecutionBinding, validateExecutionBinding } from '@devrandom/domain';
import {
  decodeComparisonMeasurementEvidence,
  decodeEvaluationAuditAssessmentArtifact,
  decodeEvaluationManifest,
  decodeTrialObservationEvidence,
  type evaluationClosureCommandSchema,
  type EvaluationClosureEvidenceIndex,
  type EvaluationEvidenceEvent,
  type EvaluationManifest,
  type EvidenceArtifact,
  type PromotionSelectionRecord,
} from '@devrandom/protocol';
import type Type from 'typebox';

export type PromotionClosureCommand = Type.Static<typeof evaluationClosureCommandSchema>;

export type StagedPromotionCustody =
  | {
      readonly kind: 'Staged';
      readonly closureCommand: PromotionClosureCommand;
      readonly index: EvaluationClosureEvidenceIndex;
      readonly selectionRecord?: PromotionSelectionRecord;
    }
  | { readonly kind: 'Absent' | 'Unavailable' };

export interface PromotionEvidenceStagingReading {
  inspect(closureSaid: string): Promise<StagedPromotionCustody>;
}

export interface PromotionClosureAcceptance {
  closeEvidence(
    command: PromotionClosureCommand,
  ): Promise<
    | { readonly kind: 'Closed' | 'AlreadyClosed'; readonly closureSaid: string }
    | { readonly kind: string }
  >;
}

export interface PromotionAcceptedEvidenceReading {
  openPrefix(input: {
    readonly binding: EvaluationExecutionBinding;
    readonly throughSequence: number;
    readonly headSaid: string;
  }): Promise<
    | { readonly kind: 'Acknowledged'; readonly events: readonly EvaluationEvidenceEvent[] }
    | { readonly kind: 'Missing' | 'Unavailable' }
  >;
  openPublic(input: {
    readonly evaluationId: string;
    readonly artifactSaid: string;
  }): Promise<
    | { readonly kind: 'Opened'; readonly artifact: EvidenceArtifact; readonly bytes: Uint8Array }
    | { readonly kind: 'Missing' | 'Unavailable' }
  >;
}

/** Reopens hosted custody only. This is not a correctness, audit, or selection verdict. */
export async function openPromotionCustody(
  input: {
    readonly closureSaid: string;
    readonly manifest: EvaluationManifest;
    readonly terminalBinding: EvaluationExecutionBinding;
  },
  staging: PromotionEvidenceStagingReading,
  hostedClosure: PromotionClosureAcceptance,
  hostedEvidence: PromotionAcceptedEvidenceReading,
): Promise<
  | {
      readonly kind: 'CustodyOpened';
      readonly closureSaid: string;
      readonly manifestSaid: string;
      readonly hypothesisSaid: string;
      readonly observationSaids: readonly string[];
      readonly measurementSaids: readonly string[];
      readonly auditSaids: readonly string[];
      readonly selectionRecord?: PromotionSelectionRecord;
    }
  | { readonly kind: 'Missing' | 'Unavailable' }
> {
  const staged = await staging.inspect(input.closureSaid);
  if (staged.kind !== 'Staged')
    return { kind: staged.kind === 'Absent' ? 'Missing' : 'Unavailable' };
  const { closureCommand, index, selectionRecord } = staged;
  const { closure } = closureCommand;
  const manifest = decodeEvaluationManifest(input.manifest);
  const binding = input.terminalBinding;
  if (
    manifest.kind !== 'Accepted' ||
    validateExecutionBinding(binding).kind !== 'Accepted' ||
    closure.d !== input.closureSaid ||
    closure.manifestSaid !== input.manifest.d ||
    closure.evaluationId !== input.manifest.evaluationId ||
    closure.evidenceStreamId !== binding.evidenceStreamId ||
    closure.originRunId !== binding.originRunId ||
    binding.evaluationId !== input.manifest.evaluationId ||
    binding.taskId !== input.manifest.taskId ||
    binding.taskRevisionSaid !== input.manifest.taskRevisionSaid ||
    binding.personalAgentAid !== input.manifest.personalAgentAid ||
    binding.taskMandateSaid !== input.manifest.taskMandateSaid ||
    binding.evaluationLeaseId !== index.lease.leaseId ||
    binding.phase.kind !== 'Trial' ||
    binding.phase.manifestSaid !== input.manifest.d ||
    binding.phase.arm !== 'H1TaskSearch' ||
    binding.phase.repetition !== 3 ||
    binding.phase.attempt !== 2 ||
    binding.harnessRevisionSaid !== input.manifest.revisions.H1 ||
    index.hypothesisSaid !== input.manifest.hypothesisSaid ||
    index.sourceInventorySaid !== input.manifest.sourceInventorySaid ||
    (selectionRecord !== undefined &&
      (selectionRecord.taskId !== input.manifest.taskId ||
        selectionRecord.taskRevisionSaid !== input.manifest.taskRevisionSaid ||
        selectionRecord.hypothesisSaid !== input.manifest.hypothesisSaid))
  )
    return { kind: 'Missing' };

  const accepted = await hostedClosure.closeEvidence(closureCommand);
  if (
    (accepted.kind !== 'Closed' && accepted.kind !== 'AlreadyClosed') ||
    !('closureSaid' in accepted) ||
    accepted.closureSaid !== closure.d
  )
    return { kind: accepted.kind === 'Unavailable' ? 'Unavailable' : 'Missing' };
  const prefix = await hostedEvidence.openPrefix({
    binding,
    throughSequence: closure.acceptedEventCount - 1,
    headSaid: closure.acceptedHeadSaid,
  });
  if (prefix.kind !== 'Acknowledged')
    return { kind: prefix.kind === 'Unavailable' ? 'Unavailable' : 'Missing' };
  if (
    prefix.events.length !== closure.acceptedEventCount ||
    prefix.events.at(-1)?.d !== closure.acceptedHeadSaid ||
    prefix.events.at(-1)?.detail.kind !== 'EvaluationBudgetCovered' ||
    prefix.events.at(-1)?.d !== index.budget.coverageEventSaid
  )
    return { kind: 'Missing' };

  const captured = new Set(
    prefix.events
      .filter(
        (event) => event.detail.kind === 'ArtifactCaptured' && event.detail.custody === 'Public',
      )
      .map((event) =>
        event.detail.kind === 'ArtifactCaptured' ? event.detail.artifactSaid : undefined,
      ),
  );
  const expectedRevision = (arm: string): string =>
    arm === 'H1TaskSearch'
      ? input.manifest.revisions.H1
      : input.manifest.revisions[arm as keyof typeof input.manifest.revisions];
  for (const item of index.observations) {
    if (!captured.has(item.artifactSaid)) return { kind: 'Missing' };
    const opened = await hostedEvidence.openPublic({
      evaluationId: closure.evaluationId,
      artifactSaid: item.artifactSaid,
    });
    if (opened.kind !== 'Opened')
      return { kind: opened.kind === 'Unavailable' ? 'Unavailable' : 'Missing' };
    const decoded = decodeTrialObservationEvidence(opened.artifact, opened.bytes);
    if (
      decoded.kind !== 'Accepted' ||
      decoded.evidence.evaluationId !== closure.evaluationId ||
      decoded.evidence.manifestSaid !== input.manifest.d ||
      decoded.evidence.harnessRevisionSaid !== expectedRevision(item.slot.arm) ||
      !isDeepStrictEqual(decoded.evidence.observation.slot, item.slot)
    )
      return { kind: 'Missing' };
  }
  for (const item of index.measurements) {
    if (!captured.has(item.artifactSaid)) return { kind: 'Missing' };
    const opened = await hostedEvidence.openPublic({
      evaluationId: closure.evaluationId,
      artifactSaid: item.artifactSaid,
    });
    if (opened.kind !== 'Opened')
      return { kind: opened.kind === 'Unavailable' ? 'Unavailable' : 'Missing' };
    const decoded = decodeComparisonMeasurementEvidence(opened.artifact, opened.bytes);
    if (
      decoded.kind !== 'Accepted' ||
      decoded.evidence.evaluationId !== closure.evaluationId ||
      decoded.evidence.manifestSaid !== input.manifest.d ||
      decoded.evidence.harnessRevisionSaid !== expectedRevision(item.slot.arm) ||
      !isDeepStrictEqual(decoded.evidence.measurement.slot, item.slot) ||
      decoded.evidence.sourceObservationSaids.some(
        (said) => !closure.observationSaids.includes(said),
      )
    )
      return { kind: 'Missing' };
  }
  for (const audit of index.audits) {
    if (!captured.has(audit.assessmentArtifactSaid)) return { kind: 'Missing' };
    const opened = await hostedEvidence.openPublic({
      evaluationId: closure.evaluationId,
      artifactSaid: audit.assessmentArtifactSaid,
    });
    if (opened.kind !== 'Opened')
      return { kind: opened.kind === 'Unavailable' ? 'Unavailable' : 'Missing' };
    const decoded = decodeEvaluationAuditAssessmentArtifact(opened.artifact, opened.bytes);
    if (
      decoded.kind !== 'Accepted' ||
      decoded.assessment.scope !== audit.scope ||
      decoded.assessment.verdict !== audit.verdict ||
      !isDeepStrictEqual(decoded.assessment.obligations, audit.obligations)
    )
      return { kind: 'Missing' };
  }
  return {
    kind: 'CustodyOpened',
    closureSaid: closure.d,
    manifestSaid: input.manifest.d,
    hypothesisSaid: index.hypothesisSaid,
    observationSaids: closure.observationSaids,
    measurementSaids: closure.measurementSaids,
    auditSaids: index.audits.map((audit) => audit.assessmentArtifactSaid),
    ...(selectionRecord === undefined ? {} : { selectionRecord }),
  };
}
