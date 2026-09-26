import { isDeepStrictEqual } from 'node:util';

import {
  assessTamperAuditScope,
  type tamperAuditObligations,
  type TamperAuditScope,
  type TamperAuditScopeAssessment,
  type VerifiedAttemptCoverage,
  type VerifiedObligationProof,
} from '@devrandom/domain';
import {
  decodeEvaluationAuditAssessmentArtifact,
  decodeEvidenceArtifact,
  type EvaluationClosureEvidenceIndex,
  type EvidenceArtifact,
} from '@devrandom/protocol';

import type { PromotionAcceptedEvidenceReading } from './open-promotion-custody.js';

type Audit = EvaluationClosureEvidenceIndex['audits'][number];
type RawProof = { readonly artifact: EvidenceArtifact; readonly bytes: Uint8Array };

/** Parent verification of a raw proof's meaning, separate from its SAID/custody. */
export interface PromotionTamperProofInspection {
  obligation(input: {
    readonly scope: TamperAuditScope;
    readonly obligation: (typeof tamperAuditObligations)[number];
    readonly proofSaid: string;
    readonly artifact: EvidenceArtifact;
    readonly bytes: Uint8Array;
  }): Promise<
    ({ readonly kind: 'Verified' } & VerifiedObligationProof) | { readonly kind: 'Unavailable' }
  >;
  coverage(input: {
    readonly scope: TamperAuditScope;
    readonly proofSaid: string;
    readonly artifact: EvidenceArtifact;
    readonly bytes: Uint8Array;
    readonly attempts: readonly ({ readonly attemptSaid: string } & RawProof)[];
  }): Promise<
    ({ readonly kind: 'Verified' } & VerifiedAttemptCoverage) | { readonly kind: 'Unavailable' }
  >;
}

const scopes = ['Shared', 'H1', 'C1', 'C2', 'C3', 'H1TaskSearch'] as const;

async function exactPublic(
  evaluationId: string,
  artifactSaid: string,
  captured: ReadonlySet<string>,
  reading: Pick<PromotionAcceptedEvidenceReading, 'openPublic'>,
): Promise<RawProof | undefined> {
  if (!captured.has(artifactSaid)) return undefined;
  const opened = await reading.openPublic({ evaluationId, artifactSaid });
  return opened.kind === 'Opened' &&
    opened.artifact.d === artifactSaid &&
    decodeEvidenceArtifact(opened.artifact, opened.bytes).kind === 'Accepted'
    ? { artifact: opened.artifact, bytes: opened.bytes }
    : undefined;
}

async function reviewScope(
  evaluationId: string,
  audit: Audit,
  captured: ReadonlySet<string>,
  reading: Pick<PromotionAcceptedEvidenceReading, 'openPublic'>,
  inspector: PromotionTamperProofInspection,
): Promise<TamperAuditScopeAssessment | undefined> {
  const proofs: VerifiedObligationProof[] = [];
  for (const claim of audit.proofs) {
    const raw = await exactPublic(evaluationId, claim.proofSaid, captured, reading);
    if (raw === undefined) return undefined;
    const inspected = await inspector.obligation({
      scope: audit.scope,
      obligation: claim.obligation,
      proofSaid: claim.proofSaid,
      ...raw,
    });
    if (
      inspected.kind !== 'Verified' ||
      inspected.scope !== audit.scope ||
      inspected.obligation !== claim.obligation ||
      inspected.proofSaid !== claim.proofSaid ||
      inspected.finding !== claim.finding
    )
      return undefined;
    proofs.push({
      scope: inspected.scope,
      obligation: inspected.obligation,
      proofSaid: inspected.proofSaid,
      finding: inspected.finding,
    });
  }
  const coverageClaim = audit.attemptCoverage;
  const rawCoverage = await exactPublic(evaluationId, coverageClaim.proofSaid, captured, reading);
  if (rawCoverage === undefined) return undefined;
  const attempts: ({ readonly attemptSaid: string } & RawProof)[] = [];
  for (const attempt of coverageClaim.attempts) {
    const raw = await exactPublic(evaluationId, attempt.attemptSaid, captured, reading);
    if (raw === undefined) return undefined;
    attempts.push({ attemptSaid: attempt.attemptSaid, ...raw });
  }
  const inspected = await inspector.coverage({
    scope: audit.scope,
    proofSaid: coverageClaim.proofSaid,
    ...rawCoverage,
    attempts,
  });
  if (inspected.kind !== 'Verified') return undefined;
  const coverage: VerifiedAttemptCoverage = {
    scope: inspected.scope,
    proofSaid: inspected.proofSaid,
    complete: inspected.complete,
    coveredRoles: inspected.coveredRoles,
    attempts: inspected.attempts,
  };
  if (!isDeepStrictEqual(coverage, coverageClaim)) return undefined;
  const assessed = assessTamperAuditScope({
    scope: audit.scope,
    proofs,
    attemptCoverage: [coverage],
  });
  if (
    !isDeepStrictEqual(assessed.obligations, audit.obligations) ||
    assessed.verdict !== audit.verdict
  )
    return undefined;
  const rawAssessment = await exactPublic(
    evaluationId,
    audit.assessmentArtifactSaid,
    captured,
    reading,
  );
  if (rawAssessment === undefined) return undefined;
  const decoded = decodeEvaluationAuditAssessmentArtifact(
    rawAssessment.artifact,
    rawAssessment.bytes,
  );
  return decoded.kind === 'Accepted' && isDeepStrictEqual(decoded.assessment, assessed)
    ? assessed
    : undefined;
}

/** Recomputes six E3 audit reports only from exact raw custody and parent-verified proofs. */
export async function reviewPromotionTamperAudit(
  input: {
    readonly evaluationId: string;
    readonly audits: EvaluationClosureEvidenceIndex['audits'];
    readonly capturedPublicArtifactSaids: ReadonlySet<string>;
  },
  ports: {
    readonly reading: Pick<PromotionAcceptedEvidenceReading, 'openPublic'>;
    readonly inspector: PromotionTamperProofInspection;
  },
): Promise<
  | { readonly kind: 'Recomputed'; readonly assessments: readonly TamperAuditScopeAssessment[] }
  | { readonly kind: 'Incomplete' }
> {
  if (
    input.audits.length !== scopes.length ||
    input.audits.some((audit, index) => audit.scope !== scopes[index])
  )
    return { kind: 'Incomplete' };
  const assessments: TamperAuditScopeAssessment[] = [];
  try {
    for (const audit of input.audits) {
      const assessed = await reviewScope(
        input.evaluationId,
        audit,
        input.capturedPublicArtifactSaids,
        ports.reading,
        ports.inspector,
      );
      if (assessed === undefined) return { kind: 'Incomplete' };
      assessments.push(assessed);
    }
  } catch {
    return { kind: 'Incomplete' };
  }
  if (
    assessments.some(
      (item) =>
        (item.scope === 'Shared' || item.scope === 'H1' || item.scope === 'H1TaskSearch') &&
        item.verdict !== 'Pass',
    )
  )
    return { kind: 'Incomplete' };
  return { kind: 'Recomputed', assessments };
}
