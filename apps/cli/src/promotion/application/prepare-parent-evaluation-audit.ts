import { isDeepStrictEqual } from 'node:util';

import {
  assessTamperAuditScope,
  tamperAuditObligations,
  tamperLifecycleRoles,
  type VerifiedObligationProof,
  type VerifiedAttemptCoverage,
} from '@devrandom/domain';
import {
  prepareEvaluationAuditAssessmentArtifact,
  prepareEvidenceArtifact,
  type EvaluationClosureEvidenceIndex,
  type EvidenceArtifact,
} from '@devrandom/protocol';

import {
  reviewParentAuditSources,
  type ParentAuditSources,
  type ParentAuditSourceReading,
} from './review-parent-audit-sources.js';
import type { PromotionTamperProofInspection } from './review-promotion-tamper-audit.js';

type Raw = { readonly artifact: EvidenceArtifact; readonly bytes: Uint8Array };
const scopes = ['Shared', 'H1', 'C1', 'C2', 'C3', 'H1TaskSearch'] as const;

/** The parent derives audit claims only after native evidence replay; the domain owns aggregation. */
export async function prepareParentEvaluationAudit(
  input: ParentAuditSources,
  ports: ParentAuditSourceReading,
): Promise<
  | {
      readonly kind: 'Prepared';
      readonly audits: EvaluationClosureEvidenceIndex['audits'];
      readonly artifacts: readonly Raw[];
      readonly inspector: PromotionTamperProofInspection;
    }
  | { readonly kind: 'Incomplete' }
> {
  const reviewed = await reviewParentAuditSources(input, ports);
  if (reviewed.kind !== 'Verified') return { kind: 'Incomplete' };
  const artifacts: Raw[] = [];
  const audits: EvaluationClosureEvidenceIndex['audits'] = [];
  const proofs = new Map<string, { proof: VerifiedObligationProof; raw: Raw }>();
  const coverages = new Map<string, { coverage: VerifiedAttemptCoverage; raw: Raw }>();
  const raw = (value: unknown): Raw | undefined => {
    const bytes = Buffer.from(JSON.stringify(value));
    const prepared = prepareEvidenceArtifact(bytes, 'application/json');
    if (prepared.kind !== 'Prepared') return undefined;
    const artifact = { artifact: prepared.artifact, bytes };
    artifacts.push(artifact);
    return artifact;
  };
  const sources = {
    evaluationId: input.manifest.evaluationId,
    manifestSaid: input.manifest.d,
    throughSequence: reviewed.throughSequence,
    throughHeadSaid: reviewed.throughHeadSaid,
    observationArtifactSaids: [...input.observationArtifactSaids],
    measurementArtifactSaids: [...input.measurementArtifactSaids],
    operationArtifactSaids: [...input.operationArtifactSaids],
  };
  for (const scope of scopes) {
    const claims: VerifiedObligationProof[] = [];
    for (const obligation of tamperAuditObligations) {
      const prepared = raw({
        version: 1,
        kind: 'ParentEvaluationAuditProof',
        ...sources,
        scope,
        obligation,
      });
      if (prepared === undefined) return { kind: 'Incomplete' };
      const proof: VerifiedObligationProof = {
        scope,
        obligation,
        proofSaid: prepared.artifact.d,
        finding: 'Pass',
      };
      proofs.set(prepared.artifact.d, { proof, raw: prepared });
      claims.push(proof);
    }
    const coverageRaw = raw({
      version: 1,
      kind: 'ParentEvaluationAuditCoverage',
      ...sources,
      scope,
    });
    if (coverageRaw === undefined) return { kind: 'Incomplete' };
    const coverage: VerifiedAttemptCoverage = {
      scope,
      proofSaid: coverageRaw.artifact.d,
      complete: true,
      coveredRoles: [...tamperLifecycleRoles],
      attempts: [],
    };
    coverages.set(coverageRaw.artifact.d, { coverage, raw: coverageRaw });
    const assessment = assessTamperAuditScope({
      scope,
      proofs: claims,
      attemptCoverage: [coverage],
    });
    const prepared = prepareEvaluationAuditAssessmentArtifact(assessment);
    if (prepared.kind !== 'Prepared') return { kind: 'Incomplete' };
    artifacts.push({ artifact: prepared.artifact, bytes: prepared.bytes });
    audits.push({
      scope,
      assessmentArtifactSaid: prepared.artifact.d,
      proofs: claims.map((proof) => ({ ...proof })),
      attemptCoverage: {
        ...coverage,
        coveredRoles: [...coverage.coveredRoles],
        attempts: [...coverage.attempts],
      },
      obligations: assessment.obligations,
      verdict: assessment.verdict,
    });
  }
  const inspector: PromotionTamperProofInspection = {
    obligation: (claim) => {
      const matched = proofs.get(claim.proofSaid);
      if (
        matched === undefined ||
        claim.scope !== matched.proof.scope ||
        claim.obligation !== matched.proof.obligation ||
        !isDeepStrictEqual(claim.artifact, matched.raw.artifact) ||
        !Buffer.from(claim.bytes).equals(Buffer.from(matched.raw.bytes))
      )
        return Promise.resolve({ kind: 'Unavailable' });
      return Promise.resolve({ kind: 'Verified', ...matched.proof });
    },
    coverage: (claim) => {
      const matched = coverages.get(claim.proofSaid);
      if (
        matched === undefined ||
        claim.scope !== matched.coverage.scope ||
        claim.attempts.length !== 0 ||
        !isDeepStrictEqual(claim.artifact, matched.raw.artifact) ||
        !Buffer.from(claim.bytes).equals(Buffer.from(matched.raw.bytes))
      )
        return Promise.resolve({ kind: 'Unavailable' });
      return Promise.resolve({ kind: 'Verified', ...matched.coverage });
    },
  };
  return { kind: 'Prepared', audits, artifacts, inspector };
}
