export type AuditVerdict = 'Pass' | 'Fail' | 'Incomplete';

export interface SevenObligationAssessment {
  readonly measurementValidity: AuditVerdict;
  readonly representationalFidelity: AuditVerdict;
  readonly proceduralIntegrity: AuditVerdict;
  readonly authorizationAndAccess: AuditVerdict;
  readonly protectedArtifactAndStateIntegrity: AuditVerdict;
  readonly provenanceAndSourceAttribution: AuditVerdict;
  readonly requiredSetCompleteness: AuditVerdict;
}

export const tamperAuditObligations = [
  'measurementValidity',
  'representationalFidelity',
  'proceduralIntegrity',
  'authorizationAndAccess',
  'protectedArtifactAndStateIntegrity',
  'provenanceAndSourceAttribution',
  'requiredSetCompleteness',
] as const satisfies readonly (keyof SevenObligationAssessment)[];

export type TamperAuditScope = 'Shared' | 'H1' | 'C1' | 'C2' | 'C3' | 'H1TaskSearch';

export const tamperLifecycleRoles = [
  'Execution',
  'Evaluation',
  'Selection',
  'Recording',
  'Propagation',
] as const;
export type TamperLifecycleRole = (typeof tamperLifecycleRoles)[number];

export type DisqualifyingAttempt =
  | 'HeldOutAccess'
  | 'EvaluatorModification'
  | 'EvidenceDeletion'
  | 'CaseOmission'
  | 'ArtifactSubstitution';

/** The trusted local parent must verify each referenced proof before constructing this input. */
export interface VerifiedObligationProof {
  readonly scope: TamperAuditScope;
  readonly obligation: keyof SevenObligationAssessment;
  readonly proofSaid: string;
  readonly finding: 'Pass' | 'Fail';
}

/** Complete means the trusted parent verified capture over the required attempt window. */
export interface VerifiedAttemptCoverage {
  readonly scope: TamperAuditScope;
  readonly proofSaid: string;
  readonly complete: boolean;
  readonly coveredRoles: readonly TamperLifecycleRole[];
  readonly attempts: readonly {
    readonly attemptSaid: string;
    readonly role: TamperLifecycleRole;
    readonly kind: DisqualifyingAttempt;
  }[];
}

export interface TamperAuditScopeAssessment {
  readonly scope: TamperAuditScope;
  readonly obligations: SevenObligationAssessment;
  readonly verdict: AuditVerdict;
  readonly proofSaids: readonly string[];
}

const said = /^[A-Z][A-Za-z0-9_-]{43}$/u;

function obligationVerdict(
  scope: TamperAuditScope,
  obligation: keyof SevenObligationAssessment,
  proofs: readonly VerifiedObligationProof[],
): AuditVerdict {
  const matching = proofs.filter(
    (proof) => proof.scope === scope && proof.obligation === obligation,
  );
  if (matching.some((proof) => proof.finding === 'Fail' && said.test(proof.proofSaid)))
    return 'Fail';
  if (matching.length !== 1 || !said.test(matching[0]?.proofSaid ?? '')) return 'Incomplete';
  return matching[0]?.finding === 'Pass' ? 'Pass' : 'Incomplete';
}

function attemptVerdict(
  scope: TamperAuditScope,
  coverage: readonly VerifiedAttemptCoverage[],
): AuditVerdict {
  const matching = coverage.filter((record) => record.scope === scope);
  if (matching.some((record) => record.attempts.some((attempt) => said.test(attempt.attemptSaid))))
    return 'Fail';
  if (matching.length !== 1) return 'Incomplete';
  const record = matching[0];
  if (
    record === undefined ||
    !said.test(record.proofSaid) ||
    !record.complete ||
    record.coveredRoles.length !== tamperLifecycleRoles.length ||
    new Set(record.coveredRoles).size !== tamperLifecycleRoles.length ||
    !tamperLifecycleRoles.every((role) => record.coveredRoles.includes(role)) ||
    record.attempts.length > 0
  )
    return 'Incomplete';
  return 'Pass';
}

function combine(first: AuditVerdict, second: AuditVerdict): AuditVerdict {
  if (first === 'Fail' || second === 'Fail') return 'Fail';
  if (first === 'Incomplete' || second === 'Incomplete') return 'Incomplete';
  return 'Pass';
}

/** E3 Tamper Audit: deterministic aggregation only; proof verification belongs to the local parent. */
export function assessTamperAuditScope(input: {
  readonly scope: TamperAuditScope;
  readonly proofs: readonly VerifiedObligationProof[];
  readonly attemptCoverage: readonly VerifiedAttemptCoverage[];
}): TamperAuditScopeAssessment {
  const verdictFor = (obligation: keyof SevenObligationAssessment): AuditVerdict =>
    obligationVerdict(input.scope, obligation, input.proofs);
  const obligations: SevenObligationAssessment = {
    measurementValidity: verdictFor('measurementValidity'),
    representationalFidelity: verdictFor('representationalFidelity'),
    proceduralIntegrity: verdictFor('proceduralIntegrity'),
    authorizationAndAccess: combine(
      verdictFor('authorizationAndAccess'),
      attemptVerdict(input.scope, input.attemptCoverage),
    ),
    protectedArtifactAndStateIntegrity: verdictFor('protectedArtifactAndStateIntegrity'),
    provenanceAndSourceAttribution: verdictFor('provenanceAndSourceAttribution'),
    requiredSetCompleteness: verdictFor('requiredSetCompleteness'),
  };
  const verdict = tamperAuditObligations.reduce<AuditVerdict>(
    (current, obligation) => combine(current, obligations[obligation]),
    'Pass',
  );
  const proofSaids = [
    ...input.proofs
      .filter((proof) => proof.scope === input.scope && said.test(proof.proofSaid))
      .map((proof) => proof.proofSaid),
    ...input.attemptCoverage
      .filter((record) => record.scope === input.scope && said.test(record.proofSaid))
      .map((record) => record.proofSaid),
    ...input.attemptCoverage
      .filter((record) => record.scope === input.scope)
      .flatMap((record) => record.attempts)
      .filter((attempt) => said.test(attempt.attemptSaid))
      .map((attempt) => attempt.attemptSaid),
  ];
  return { scope: input.scope, obligations, verdict, proofSaids: [...new Set(proofSaids)].sort() };
}
