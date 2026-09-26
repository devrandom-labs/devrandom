import { describe, expect, it } from 'vitest';

import {
  assessTamperAuditScope,
  tamperAuditObligations,
  tamperLifecycleRoles,
  type TamperAuditScope,
  type VerifiedObligationProof,
} from './assessment.js';

const said = (character: string): string => `E${character.repeat(43)}`;
const scope: TamperAuditScope = 'C1';
const proofs: readonly VerifiedObligationProof[] = tamperAuditObligations.map(
  (obligation, index) => ({
    scope,
    obligation,
    proofSaid: said(String.fromCharCode(97 + index)),
    finding: 'Pass',
  }),
);

describe('trusted-parent seven-obligation tamper assessment', () => {
  it('marks every missing obligation incomplete rather than treating absence as a pass', () => {
    const assessment = assessTamperAuditScope({ scope, proofs: [], attemptCoverage: [] });
    expect(assessment.verdict).toBe('Incomplete');
    expect(Object.values(assessment.obligations)).toEqual(Array(7).fill('Incomplete'));
    expect(assessment.proofSaids).toEqual([]);
  });

  it('requires an explicit complete attempt-capture proof even when the attempt log is empty', () => {
    const absent = assessTamperAuditScope({ scope, proofs, attemptCoverage: [] });
    expect(absent.obligations.authorizationAndAccess).toBe('Incomplete');
    expect(absent.verdict).toBe('Incomplete');
    const incomplete = assessTamperAuditScope({
      scope,
      proofs,
      attemptCoverage: [
        {
          scope,
          proofSaid: said('x'),
          complete: false,
          coveredRoles: tamperLifecycleRoles,
          attempts: [],
        },
      ],
    });
    expect(incomplete.obligations.authorizationAndAccess).toBe('Incomplete');
    const complete = assessTamperAuditScope({
      scope,
      proofs,
      attemptCoverage: [
        {
          scope,
          proofSaid: said('x'),
          complete: true,
          coveredRoles: tamperLifecycleRoles,
          attempts: [],
        },
      ],
    });
    expect(complete.verdict).toBe('Pass');
    expect(Object.values(complete.obligations)).toEqual(Array(7).fill('Pass'));
    expect([...tamperAuditObligations].sort()).toEqual(Object.keys(complete.obligations).sort());
    expect(complete.proofSaids).toContain(said('x'));
  });

  it('requires capture across all five distinct lifecycle roles', () => {
    const missingPropagation = assessTamperAuditScope({
      scope,
      proofs,
      attemptCoverage: [
        {
          scope,
          proofSaid: said('x'),
          complete: true,
          coveredRoles: ['Execution', 'Evaluation', 'Selection', 'Recording'],
          attempts: [],
        },
      ],
    });
    expect(missingPropagation.obligations.authorizationAndAccess).toBe('Incomplete');
    const duplicateRole = assessTamperAuditScope({
      scope,
      proofs,
      attemptCoverage: [
        {
          scope,
          proofSaid: said('x'),
          complete: true,
          coveredRoles: ['Execution', 'Evaluation', 'Selection', 'Recording', 'Recording'],
          attempts: [],
        },
      ],
    });
    expect(duplicateRole.obligations.authorizationAndAccess).toBe('Incomplete');
  });

  it('fails the access obligation for a blocked unsafe attempt and preserves its proof', () => {
    const assessment = assessTamperAuditScope({
      scope,
      proofs,
      attemptCoverage: [
        {
          scope,
          proofSaid: said('x'),
          complete: true,
          coveredRoles: tamperLifecycleRoles,
          attempts: [{ attemptSaid: said('z'), role: 'Execution', kind: 'HeldOutAccess' }],
        },
      ],
    });
    expect(assessment.obligations.authorizationAndAccess).toBe('Fail');
    expect(assessment.verdict).toBe('Fail');
    expect(assessment.proofSaids).toContain(said('z'));
    const incompleteCapture = assessTamperAuditScope({
      scope,
      proofs,
      attemptCoverage: [
        {
          scope,
          proofSaid: 'not-a-said',
          complete: false,
          coveredRoles: tamperLifecycleRoles,
          attempts: [{ attemptSaid: said('z'), role: 'Execution', kind: 'HeldOutAccess' }],
        },
      ],
    });
    expect(incompleteCapture.verdict).toBe('Fail');
    expect(incompleteCapture.proofSaids).toContain(said('z'));
  });

  it('does not borrow another arm or shared proof and does not choose among duplicates', () => {
    const wrongScope = assessTamperAuditScope({
      scope,
      proofs: proofs.map((proof) => ({ ...proof, scope: 'Shared' })),
      attemptCoverage: [
        {
          scope: 'Shared',
          proofSaid: said('x'),
          complete: true,
          coveredRoles: tamperLifecycleRoles,
          attempts: [],
        },
      ],
    });
    expect(wrongScope.verdict).toBe('Incomplete');
    const firstProof = proofs[0];
    if (firstProof === undefined) throw new Error('test proof missing');
    const duplicate = assessTamperAuditScope({
      scope,
      proofs: [...proofs, firstProof],
      attemptCoverage: [
        {
          scope,
          proofSaid: said('x'),
          complete: true,
          coveredRoles: tamperLifecycleRoles,
          attempts: [],
        },
        {
          scope,
          proofSaid: said('y'),
          complete: true,
          coveredRoles: tamperLifecycleRoles,
          attempts: [],
        },
      ],
    });
    expect(duplicate.obligations.measurementValidity).toBe('Incomplete');
    expect(duplicate.obligations.authorizationAndAccess).toBe('Incomplete');
    expect(duplicate.verdict).toBe('Incomplete');
  });

  it('keeps a witnessed failure distinct from unavailable proof', () => {
    const failed = assessTamperAuditScope({
      scope,
      proofs: [
        ...proofs.filter((proof) => proof.obligation !== 'proceduralIntegrity'),
        {
          scope,
          obligation: 'proceduralIntegrity',
          proofSaid: said('q'),
          finding: 'Fail',
        },
      ],
      attemptCoverage: [
        {
          scope,
          proofSaid: said('x'),
          complete: true,
          coveredRoles: tamperLifecycleRoles,
          attempts: [],
        },
      ],
    });
    expect(failed.obligations.proceduralIntegrity).toBe('Fail');
    expect(failed.verdict).toBe('Fail');
    const missing = assessTamperAuditScope({
      scope,
      proofs: proofs.filter((proof) => proof.obligation !== 'proceduralIntegrity'),
      attemptCoverage: [
        {
          scope,
          proofSaid: said('x'),
          complete: true,
          coveredRoles: tamperLifecycleRoles,
          attempts: [],
        },
      ],
    });
    expect(missing.obligations.proceduralIntegrity).toBe('Incomplete');
    expect(missing.verdict).toBe('Incomplete');
  });

  it('assesses shared procedure proof independently of candidate-arm proof', () => {
    const sharedProofs = proofs.map((proof) => ({ ...proof, scope: 'Shared' as const }));
    const shared = assessTamperAuditScope({
      scope: 'Shared',
      proofs: sharedProofs,
      attemptCoverage: [
        {
          scope: 'Shared',
          proofSaid: said('x'),
          complete: true,
          coveredRoles: tamperLifecycleRoles,
          attempts: [],
        },
      ],
    });
    expect(shared.verdict).toBe('Pass');
    const arm = assessTamperAuditScope({
      scope,
      proofs: sharedProofs,
      attemptCoverage: [
        {
          scope: 'Shared',
          proofSaid: said('x'),
          complete: true,
          coveredRoles: tamperLifecycleRoles,
          attempts: [],
        },
      ],
    });
    expect(arm.verdict).toBe('Incomplete');
  });
});
