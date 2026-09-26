import { derivePortableBehavior, reviewedPortableInstructions } from '@devrandom/domain';
import { prepareEvidenceArtifact } from '@devrandom/protocol';
import type { ExactTreatmentArtifact } from '@devrandom/runtime';
import { reviewTreatmentBytes } from './parent-successor-treatment-review.js';
/** Fixes portable component eligibility before immutable candidate branches and the comparison manifest. */
export const researchCandidateInstructions = [
  'Return exactly {C1:{configuration:{version:1,arm:"C1",instructionText:one reviewed instruction}},C2:{configuration:{version:1,arm:"C2"},implementation:{version:1,kind:"RecoveryWorkflow",trigger:"QualifiedRetainedFailure",steps:["RetrieveExperience","ReadExactSource","Replan","FreshPublicVerify"]}},C3:{configuration:{version:1,arm:"C3",formatMarker:"Current",triggerPaths:["src/lib.rs"],priority:["Failure","Contract","Edit"],maximumItems:3,maximumContextBytes:4096},implementation:{version:1,kind:"VersionedFormatContextSelection",algorithm:"ExactPublicHistoryV1"}}}.',
  `Choose C1 instructionText only from these existing reviewed public components, preserving its exact bytes: ${JSON.stringify(reviewedPortableInstructions)}.`,
  'Choose only an instruction supported by the supplied public hypothesis and evidence. If none fits, return {kind:"Rejected",reason:"NoEvidenceAppropriateInstruction"}; do not force a fit, paraphrase, or invent a replacement.',
  'Choose bounded C3 ordering/limits consistent with its reviewed algorithm. These static portability requirements apply before freezing all three candidates; they neither select a winner nor establish performance.',
  'Never include task source edits, scores, winner, authority, or protected data.',
].join(' ');

export interface ResearchCandidate {
  readonly arm: 'C1' | 'C2' | 'C3';
  readonly configuration: ExactTreatmentArtifact;
  readonly implementation?: ExactTreatmentArtifact;
}
/** Maps untrusted model JSON only into the existing bounded, parent-reviewed treatment catalogue. */
export function prepareResearchCandidates(
  value: unknown,
):
  | { readonly kind: 'Prepared'; readonly candidates: readonly ResearchCandidate[] }
  | { readonly kind: 'Rejected' } {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'C1,C2,C3'
  )
    return { kind: 'Rejected' };
  const candidates: ResearchCandidate[] = [];
  for (const arm of ['C1', 'C2', 'C3'] as const) {
    const entry: unknown = Reflect.get(value, arm);
    if (
      typeof entry !== 'object' ||
      entry === null ||
      Array.isArray(entry) ||
      Object.keys(entry).sort().join(',') !==
        (arm === 'C1' ? 'configuration' : 'configuration,implementation')
    )
      return { kind: 'Rejected' };
    const configurationBytes = Buffer.from(JSON.stringify(Reflect.get(entry, 'configuration')));
    const implementationBytes =
      arm === 'C1' ? undefined : Buffer.from(JSON.stringify(Reflect.get(entry, 'implementation')));
    if (
      !reviewTreatmentBytes(arm, configurationBytes, implementationBytes) ||
      derivePortableBehavior(
        Reflect.get(entry, 'configuration'),
        arm === 'C1' ? undefined : Reflect.get(entry, 'implementation'),
        [],
      ).kind !== 'Portable'
    )
      return { kind: 'Rejected' };
    const configuration = prepareEvidenceArtifact(configurationBytes, 'application/json');
    if (configuration.kind !== 'Prepared') return { kind: 'Rejected' };
    if (implementationBytes === undefined)
      candidates.push({
        arm,
        configuration: { artifact: configuration.artifact, bytes: configurationBytes },
      });
    else {
      const implementation = prepareEvidenceArtifact(
        implementationBytes,
        'application/octet-stream',
      );
      if (implementation.kind !== 'Prepared') return { kind: 'Rejected' };
      candidates.push({
        arm,
        configuration: { artifact: configuration.artifact, bytes: configurationBytes },
        implementation: { artifact: implementation.artifact, bytes: implementationBytes },
      });
    }
  }
  return { kind: 'Prepared', candidates };
}
