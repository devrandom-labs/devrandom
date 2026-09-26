/** A candidate changes one declared treatment while retaining this exact H1 context. */
export interface SuccessorFamilyBinding {
  readonly parentRevisionSaid: string;
  readonly h0Said: string;
  readonly taskRevisionSaid: string;
  readonly sourceInventorySaid: string;
  readonly executionProfileSaid: string;
}

export interface SuccessorRevisionIdentity extends SuccessorFamilyBinding {
  readonly arm: 'C1' | 'C2' | 'C3';
  readonly revisionSaid: string;
  readonly configurationArtifactSaid: string;
}

export type SuccessorFamilyAssessment =
  | {
      readonly kind: 'Complete';
      readonly revisions: { readonly C1: string; readonly C2: string; readonly C3: string };
    }
  | {
      readonly kind: 'Blocked';
      readonly reason: 'CandidateSetIncomplete' | 'BindingMismatch' | 'IdentityReused';
    };

/** Harness law checked before binding candidate identities into protected manifest M. */
export function assessSuccessorFamily(
  expected: SuccessorFamilyBinding,
  candidates: readonly SuccessorRevisionIdentity[],
): SuccessorFamilyAssessment {
  if (candidates.length !== 3 || new Set(candidates.map((candidate) => candidate.arm)).size !== 3)
    return { kind: 'Blocked', reason: 'CandidateSetIncomplete' };
  const bindings = [
    expected.parentRevisionSaid,
    expected.h0Said,
    expected.taskRevisionSaid,
    expected.sourceInventorySaid,
    expected.executionProfileSaid,
  ];
  if (
    bindings.some((value) => value.length === 0) ||
    candidates.some(
      (candidate) =>
        candidate.parentRevisionSaid !== expected.parentRevisionSaid ||
        candidate.h0Said !== expected.h0Said ||
        candidate.taskRevisionSaid !== expected.taskRevisionSaid ||
        candidate.sourceInventorySaid !== expected.sourceInventorySaid ||
        candidate.executionProfileSaid !== expected.executionProfileSaid,
    )
  )
    return { kind: 'Blocked', reason: 'BindingMismatch' };
  const revisions = candidates.map((candidate) => candidate.revisionSaid);
  const configurations = candidates.map((candidate) => candidate.configurationArtifactSaid);
  if (
    revisions.some((value) => value.length === 0) ||
    configurations.some((value) => value.length === 0) ||
    new Set(revisions).size !== 3 ||
    new Set(configurations).size !== 3 ||
    revisions.some((value) => value === expected.parentRevisionSaid)
  )
    return { kind: 'Blocked', reason: 'IdentityReused' };
  const byArm = new Map(candidates.map((candidate) => [candidate.arm, candidate.revisionSaid]));
  const C1 = byArm.get('C1');
  const C2 = byArm.get('C2');
  const C3 = byArm.get('C3');
  if (C1 === undefined || C2 === undefined || C3 === undefined)
    return { kind: 'Blocked', reason: 'CandidateSetIncomplete' };
  return { kind: 'Complete', revisions: { C1, C2, C3 } };
}
