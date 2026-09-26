import { prepareEvidenceArtifact } from '@devrandom/protocol';
import type { ExactTreatmentArtifact } from '@devrandom/runtime';
import { reviewTreatmentBytes } from './parent-successor-treatment-review.js';
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
    if (!reviewTreatmentBytes(arm, configurationBytes, implementationBytes))
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
