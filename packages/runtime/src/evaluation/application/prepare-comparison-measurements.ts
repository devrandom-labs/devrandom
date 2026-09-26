import { closeComparison, comparisonSlots } from '@devrandom/domain';
import {
  bindEvaluationVerifierBundle,
  decodeEvaluationManifest,
  decodeTrialObservationEvidence,
  prepareComparisonMeasurementEvidence,
  type ComparisonMeasurementEvidence,
  type EvidenceArtifact,
  type EvaluationManifest,
  type EvaluationVerifierBundle,
  type TrialObservationEvidence,
} from '@devrandom/protocol';

interface RawObservation {
  readonly artifact: EvidenceArtifact;
  readonly bytes: Uint8Array;
}

export type ComparisonMeasurementPreparation =
  | {
      readonly kind: 'Prepared';
      readonly observations: readonly TrialObservationEvidence[];
      readonly measurements: readonly {
        readonly evidence: ComparisonMeasurementEvidence;
        readonly artifact: EvidenceArtifact;
        readonly bytes: Uint8Array;
      }[];
    }
  | {
      readonly kind: 'Incomplete';
      readonly reason: 'Manifest' | 'RequiredSet' | 'Binding' | 'Comparison';
    };

function sameSlot(
  first: { readonly arm: string; readonly repetition: number; readonly attempt: number },
  second: typeof first,
): boolean {
  return (
    first.arm === second.arm &&
    first.repetition === second.repetition &&
    first.attempt === second.attempt
  );
}

function sameStrings(first: readonly string[], second: readonly string[]): boolean {
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

/** The trusted parent derives all fifteen descriptive records from eighteen exact trial records. */
export function prepareComparisonMeasurements(input: {
  readonly manifest: EvaluationManifest;
  readonly verifier: EvaluationVerifierBundle;
  readonly observations: readonly RawObservation[];
}): ComparisonMeasurementPreparation {
  const { manifest, verifier } = input;
  if (
    decodeEvaluationManifest(manifest).kind !== 'Accepted' ||
    bindEvaluationVerifierBundle(verifier, manifest).kind !== 'Bound' ||
    manifest.heldOutCaseCount !== 1 ||
    !sameStrings(
      manifest.publicConditionIds,
      verifier.publicConditions.map((item) => item.id),
    )
  )
    return { kind: 'Incomplete', reason: 'Manifest' };
  const schedule = comparisonSlots();
  if (input.observations.length !== schedule.length)
    return { kind: 'Incomplete', reason: 'RequiredSet' };
  const decoded = input.observations.map((item) =>
    decodeTrialObservationEvidence(item.artifact, item.bytes),
  );
  if (decoded.some((item) => item.kind !== 'Accepted'))
    return { kind: 'Incomplete', reason: 'Binding' };
  const records = decoded.flatMap((item) => (item.kind === 'Accepted' ? [item] : []));
  if (
    records.length !== schedule.length ||
    new Set(records.map((item) => item.artifact.d)).size !== schedule.length
  )
    return { kind: 'Incomplete', reason: 'RequiredSet' };
  for (const [position, record] of records.entries()) {
    const required = schedule[position];
    const evidence = record.evidence;
    if (required === undefined) return { kind: 'Incomplete', reason: 'RequiredSet' };
    const revision =
      required.arm === 'H1TaskSearch' ? manifest.revisions.H1 : manifest.revisions[required.arm];
    if (
      evidence.evaluationId !== manifest.evaluationId ||
      evidence.manifestSaid !== manifest.d ||
      evidence.harnessRevisionSaid !== revision ||
      !sameSlot(evidence.observation.slot, required) ||
      !sameStrings(
        evidence.publicObservations.map((item) => item.conditionId),
        manifest.publicConditionIds,
      ) ||
      !evidence.observation.disposition.heldOutConditionIds.every(
        (id) => id === verifier.protectedCase.objectSaid,
      )
    )
      return { kind: 'Incomplete', reason: 'Binding' };
  }
  const comparison = closeComparison(
    { public: manifest.publicConditionIds, heldOut: [verifier.protectedCase.objectSaid] },
    records.map((item) => item.evidence.observation),
  );
  if (comparison.kind !== 'EvidenceOnly') return { kind: 'Incomplete', reason: 'Comparison' };
  const measurements: {
    evidence: ComparisonMeasurementEvidence;
    artifact: EvidenceArtifact;
    bytes: Uint8Array;
  }[] = [];
  for (const measurement of comparison.measurements) {
    const references = records.filter(
      (item) =>
        item.evidence.observation.slot.arm === measurement.slot.arm &&
        item.evidence.observation.slot.repetition === measurement.slot.repetition,
    );
    if (references.length !== (measurement.slot.arm === 'H1TaskSearch' ? 2 : 1))
      return { kind: 'Incomplete', reason: 'RequiredSet' };
    const revision =
      measurement.slot.arm === 'H1TaskSearch'
        ? manifest.revisions.H1
        : manifest.revisions[measurement.slot.arm];
    const prepared = prepareComparisonMeasurementEvidence({
      version: 1,
      kind: 'ComparisonMeasurementEvidence',
      evaluationId: manifest.evaluationId,
      manifestSaid: manifest.d,
      harnessRevisionSaid: revision,
      measurement,
      sourceObservationSaids: references.map((item) => item.artifact.d),
    });
    if (prepared.kind !== 'Prepared') return { kind: 'Incomplete', reason: 'Comparison' };
    measurements.push({
      evidence: prepared.evidence,
      artifact: prepared.artifact,
      bytes: prepared.bytes,
    });
  }
  return { kind: 'Prepared', observations: records.map((item) => item.evidence), measurements };
}
