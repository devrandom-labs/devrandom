import {
  comparisonSlots,
  assessTamperAuditScope,
  tamperAuditObligations,
  tamperLifecycleRoles,
  type DisqualifyingAttempt,
  type TamperLifecycleRole,
  type VerifiedObligationProof,
} from '@devrandom/domain';
import { describe, expect, it } from 'vitest';

import { prepareEvidenceArtifact } from '../evidence/evidence-artifact.js';
import {
  decodeEvaluationAuditAssessmentArtifact,
  decodeEvaluationClosureEvidenceIndex,
  prepareEvaluationAuditAssessmentArtifact,
  prepareEvaluationClosureEvidenceIndex,
} from './closure-evidence-index.js';

const said = (letter: string) => `${letter}${'a'.repeat(43)}`;
const uuid = '11111111-1111-4111-8111-111111111111';
const scopes = ['Shared', 'H1', 'C1', 'C2', 'C3', 'H1TaskSearch'] as const;
const dimensions = [
  'providerRequests',
  'providerInputTokens',
  'providerOutputTokens',
  'providerSpendMicroUsd',
  'runWallTimeSeconds',
  'toolProposals',
  'aggregateChildCommandTimeSeconds',
  'changedFiles',
  'changedWorktreeBytes',
] as const;

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Fixture incomplete');
  return value;
}

function fixture() {
  let serial = 0;
  const nextSaid = () => `E${String(++serial).padStart(43, '0')}`;
  return {
    version: 1,
    kind: 'EvaluationClosureEvidenceIndex',
    evaluationId: uuid,
    manifestSaid: said('M'),
    sourceInventorySaid: said('S'),
    hypothesisSaid: said('H'),
    lease: { leaseId: '22222222-2222-4222-8222-222222222222', version: 3 },
    observations: comparisonSlots().map((slot) => ({ slot, artifactSaid: nextSaid() })),
    measurements: comparisonSlots()
      .filter((slot) => slot.attempt === 1)
      .map((slot) => ({
        slot,
        artifactSaid: nextSaid(),
      })),
    audits: scopes.map((scope) => ({
      scope,
      assessmentArtifactSaid: nextSaid(),
      proofs: tamperAuditObligations.map((obligation) => ({
        scope,
        obligation,
        proofSaid: nextSaid(),
        finding: 'Pass',
      })),
      attemptCoverage: {
        scope,
        proofSaid: nextSaid(),
        complete: true,
        coveredRoles: [...tamperLifecycleRoles],
        attempts: [] as {
          attemptSaid: string;
          role: TamperLifecycleRole;
          kind: DisqualifyingAttempt;
        }[],
      },
      obligations: Object.fromEntries(
        tamperAuditObligations.map((obligation) => [obligation, 'Pass']),
      ),
      verdict: 'Pass',
    })),
    budget: {
      coverageEventSaid: nextSaid(),
      totals: Object.fromEntries(dimensions.map((dimension) => [dimension, 1])),
      anchors: dimensions.map((dimension) => ({
        dimension,
        finalDebitEventSaid: nextSaid(),
        receiptArtifactSaid: nextSaid(),
        sourceEventSaid: nextSaid(),
      })),
    },
  };
}

describe('exact closure evidence index', () => {
  it('binds audit report bytes to the domain-law assessment and rejects reordered JSON', () => {
    const audit = required(fixture().audits[0]);
    const assessment = assessTamperAuditScope({
      scope: 'Shared',
      proofs: audit.proofs.map((proof): VerifiedObligationProof => ({ ...proof, finding: 'Pass' })),
      attemptCoverage: [audit.attemptCoverage],
    });
    const prepared = prepareEvaluationAuditAssessmentArtifact(assessment);
    expect(prepared.kind).toBe('Prepared');
    if (prepared.kind !== 'Prepared') return;
    expect(decodeEvaluationAuditAssessmentArtifact(prepared.artifact, prepared.bytes)).toEqual({
      kind: 'Accepted',
      assessment,
      artifact: prepared.artifact,
      bytes: prepared.bytes,
    });
    const reordered = new TextEncoder().encode(JSON.stringify(assessment));
    const reorderedArtifact = prepareEvidenceArtifact(reordered, 'application/json');
    expect(reorderedArtifact.kind).toBe('Prepared');
    if (reorderedArtifact.kind === 'Prepared')
      expect(
        decodeEvaluationAuditAssessmentArtifact(reorderedArtifact.artifact, reordered),
      ).toEqual({
        kind: 'Rejected',
        reason: 'NoncanonicalBytes',
      });
  });

  it('prepares canonical artifact bytes and decodes the same exact index', () => {
    const prepared = prepareEvaluationClosureEvidenceIndex(fixture());
    expect(prepared.kind).toBe('Prepared');
    if (prepared.kind !== 'Prepared') return;
    expect(prepared.artifact.mediaType).toBe('application/json');
    expect(decodeEvaluationClosureEvidenceIndex(prepared.artifact, prepared.bytes)).toEqual({
      kind: 'Accepted',
      index: prepared.index,
      artifact: prepared.artifact,
      bytes: prepared.bytes,
    });
    const noncanonical = new TextEncoder().encode(` ${new TextDecoder().decode(prepared.bytes)}`);
    const noncanonicalArtifact = prepareEvidenceArtifact(noncanonical, 'application/json');
    expect(noncanonicalArtifact.kind).toBe('Prepared');
    if (noncanonicalArtifact.kind === 'Prepared')
      expect(
        decodeEvaluationClosureEvidenceIndex(noncanonicalArtifact.artifact, noncanonical),
      ).toEqual({
        kind: 'Rejected',
        reason: 'NoncanonicalBytes',
      });
  });

  it('changes the index SAID for a substituted signed binding', () => {
    const index = fixture();
    const prepared = prepareEvaluationClosureEvidenceIndex(index);
    const changed = prepareEvaluationClosureEvidenceIndex({
      ...index,
      hypothesisSaid: said('Q'),
    });
    expect(prepared.kind).toBe('Prepared');
    expect(changed.kind).toBe('Prepared');
    if (prepared.kind !== 'Prepared' || changed.kind !== 'Prepared') return;
    expect(changed.artifact.d).not.toBe(prepared.artifact.d);
    expect(decodeEvaluationClosureEvidenceIndex(prepared.artifact, changed.bytes)).toEqual({
      kind: 'Rejected',
      reason: 'ArtifactInvalid',
    });
  });

  it('rejects schedule gaps, duplicate artifact SAIDs and missing budget dimensions', () => {
    const absent = fixture();
    expect(
      prepareEvaluationClosureEvidenceIndex({
        ...absent,
        observations: absent.observations.slice(1),
      }),
    ).toMatchObject({ kind: 'Rejected' });
    const duplicate = fixture();
    required(duplicate.measurements[1]).artifactSaid = required(
      duplicate.measurements[0],
    ).artifactSaid;
    expect(prepareEvaluationClosureEvidenceIndex(duplicate)).toMatchObject({ kind: 'Rejected' });
    const budget = fixture();
    expect(
      prepareEvaluationClosureEvidenceIndex({
        ...budget,
        budget: { ...budget.budget, anchors: budget.budget.anchors.slice(1) },
      }),
    ).toMatchObject({ kind: 'Rejected' });
  });

  it('recomputes audit verdict and requires Pass control floors and all five roles', () => {
    const forged = fixture();
    required(forged.audits[0]).verdict = 'Fail';
    expect(prepareEvaluationClosureEvidenceIndex(forged)).toMatchObject({ kind: 'Rejected' });
    const omitted = fixture();
    required(omitted.audits[0]).attemptCoverage.coveredRoles.pop();
    expect(prepareEvaluationClosureEvidenceIndex(omitted)).toMatchObject({ kind: 'Rejected' });
    const failingControl = fixture();
    required(required(failingControl.audits[1]).proofs[0]).finding = 'Fail';
    required(failingControl.audits[1]).obligations.measurementValidity = 'Fail';
    required(failingControl.audits[1]).verdict = 'Fail';
    expect(prepareEvaluationClosureEvidenceIndex(failingControl)).toMatchObject({
      kind: 'Rejected',
    });
    const failedCandidate = fixture();
    required(required(failedCandidate.audits[2]).proofs[0]).finding = 'Fail';
    required(failedCandidate.audits[2]).obligations.measurementValidity = 'Fail';
    required(failedCandidate.audits[2]).verdict = 'Fail';
    expect(prepareEvaluationClosureEvidenceIndex(failedCandidate)).toMatchObject({
      kind: 'Prepared',
    });
    const attemptedCandidate = fixture();
    required(attemptedCandidate.audits[2]).attemptCoverage.attempts.push({
      attemptSaid: said('X'),
      role: 'Execution',
      kind: 'HeldOutAccess',
    });
    required(attemptedCandidate.audits[2]).obligations.authorizationAndAccess = 'Fail';
    required(attemptedCandidate.audits[2]).verdict = 'Fail';
    expect(prepareEvaluationClosureEvidenceIndex(attemptedCandidate)).toMatchObject({
      kind: 'Prepared',
    });
    const incompleteCandidate = fixture();
    required(incompleteCandidate.audits[3]).attemptCoverage.complete = false;
    required(incompleteCandidate.audits[3]).obligations.authorizationAndAccess = 'Incomplete';
    required(incompleteCandidate.audits[3]).verdict = 'Incomplete';
    expect(prepareEvaluationClosureEvidenceIndex(incompleteCandidate)).toMatchObject({
      kind: 'Prepared',
    });
  });

  it('rejects an otherwise valid audit index above the 128 KiB artifact ceiling', () => {
    const oversized = fixture();
    let serial = 0;
    for (const position of [2, 3, 4]) {
      const audit = required(oversized.audits[position]);
      audit.attemptCoverage.attempts = Array.from({ length: 512 }, () => ({
        attemptSaid: `Z${String(++serial).padStart(43, '0')}`,
        role: 'Execution',
        kind: 'HeldOutAccess',
      }));
      audit.obligations.authorizationAndAccess = 'Fail';
      audit.verdict = 'Fail';
    }
    expect(prepareEvaluationClosureEvidenceIndex(oversized)).toEqual({
      kind: 'Rejected',
      reason: 'ArtifactTooLarge',
    });
  });
});
