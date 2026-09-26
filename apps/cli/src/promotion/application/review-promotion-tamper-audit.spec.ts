import {
  assessTamperAuditScope,
  tamperAuditObligations,
  tamperLifecycleRoles,
  type TamperAuditScope,
} from '@devrandom/domain';
import {
  prepareEvaluationAuditAssessmentArtifact,
  prepareEvidenceArtifact,
  type EvaluationClosureEvidenceIndex,
  type EvidenceArtifact,
} from '@devrandom/protocol';
import { expect, it } from 'vitest';

import { reviewPromotionTamperAudit } from './review-promotion-tamper-audit.js';

const scopes = ['Shared', 'H1', 'C1', 'C2', 'C3', 'H1TaskSearch'] as const;
const evaluationId = '11111111-1111-4111-8111-111111111111';

function fixture() {
  const raw = new Map<
    string,
    {
      artifact: EvidenceArtifact;
      bytes: Uint8Array;
    }
  >();
  const retained = (value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(value));
    const prepared = prepareEvidenceArtifact(bytes, 'application/json');
    if (prepared.kind !== 'Prepared') throw new Error('raw proof rejected');
    raw.set(prepared.artifact.d, { artifact: prepared.artifact, bytes });
    return prepared.artifact.d;
  };
  const audits = scopes.map((scope) => {
    const proofs = tamperAuditObligations.map((obligation) => ({
      scope,
      obligation,
      proofSaid: retained({ scope, obligation, witness: 'parent-measured' }),
      finding: 'Pass' as const,
    }));
    const attemptCoverage = {
      scope,
      proofSaid: retained({ scope, roles: tamperLifecycleRoles, window: 'complete' }),
      complete: true,
      coveredRoles: [...tamperLifecycleRoles],
      attempts: [],
    };
    const assessed = assessTamperAuditScope({ scope, proofs, attemptCoverage: [attemptCoverage] });
    const prepared = prepareEvaluationAuditAssessmentArtifact(assessed);
    if (prepared.kind !== 'Prepared') throw new Error('assessment rejected');
    raw.set(prepared.artifact.d, { artifact: prepared.artifact, bytes: prepared.bytes });
    return { ...assessed, assessmentArtifactSaid: prepared.artifact.d, proofs, attemptCoverage };
  });
  return {
    audits: audits as EvaluationClosureEvidenceIndex['audits'],
    captured: new Set(raw.keys()),
    reader: {
      openPublic: ({ artifactSaid }: { evaluationId: string; artifactSaid: string }) => {
        const found = raw.get(artifactSaid);
        return Promise.resolve(
          found === undefined
            ? { kind: 'Missing' as const }
            : { kind: 'Opened' as const, ...found },
        );
      },
    },
    inspector: {
      obligation: (input: {
        scope: TamperAuditScope;
        obligation: (typeof tamperAuditObligations)[number];
        proofSaid: string;
      }) => Promise.resolve({ kind: 'Verified' as const, ...input, finding: 'Pass' as const }),
      coverage: (input: { scope: TamperAuditScope; proofSaid: string }) =>
        Promise.resolve({
          kind: 'Verified' as const,
          scope: input.scope,
          proofSaid: input.proofSaid,
          complete: true,
          coveredRoles: [...tamperLifecycleRoles],
          attempts: [],
        }),
    },
  };
}

it('requires independently verified seven-obligation proofs and complete five-role attempt coverage for all six scopes', async () => {
  const evidence = fixture();
  expect(
    await reviewPromotionTamperAudit(
      { evaluationId, audits: evidence.audits, capturedPublicArtifactSaids: evidence.captured },
      { reading: evidence.reader, inspector: evidence.inspector },
    ),
  ).toMatchObject({
    kind: 'Recomputed',
    assessments: scopes.map((scope) => ({ scope, verdict: 'Pass' })),
  });
  expect(
    await reviewPromotionTamperAudit(
      { evaluationId, audits: evidence.audits, capturedPublicArtifactSaids: evidence.captured },
      {
        reading: evidence.reader,
        inspector: {
          ...evidence.inspector,
          coverage: () => Promise.resolve({ kind: 'Unavailable' as const }),
        },
      },
    ),
  ).toEqual({ kind: 'Incomplete' });
  const missing = new Set(evidence.captured);
  missing.delete(evidence.audits[0]?.attemptCoverage.proofSaid ?? '');
  expect(
    await reviewPromotionTamperAudit(
      { evaluationId, audits: evidence.audits, capturedPublicArtifactSaids: missing },
      { reading: evidence.reader, inspector: evidence.inspector },
    ),
  ).toEqual({ kind: 'Incomplete' });
});
