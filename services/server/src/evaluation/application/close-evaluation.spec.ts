import { randomUUID } from 'node:crypto';

import { comparisonSlots, tamperAuditObligations, tamperLifecycleRoles } from '@devrandom/domain';
import { expect, it, vi } from 'vitest';
import {
  prepareEvaluationClosure,
  prepareEvaluationClosureEvidenceIndex,
} from '@devrandom/protocol';

import { closeEvaluation } from './close-evaluation.js';

const said = (letter: string): string => `E${letter.repeat(43)}`;

function fixture() {
  const evaluationId = randomUUID();
  let serial = 0;
  const next = () => `E${String(++serial).padStart(43, '0')}`;
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
  const index = prepareEvaluationClosureEvidenceIndex({
    version: 1,
    kind: 'EvaluationClosureEvidenceIndex',
    evaluationId,
    manifestSaid: said('M'),
    sourceInventorySaid: said('i'),
    hypothesisSaid: said('H'),
    lease: { leaseId: randomUUID(), version: 1 },
    observations: comparisonSlots().map((slot) => ({ slot, artifactSaid: next() })),
    measurements: comparisonSlots()
      .filter((slot) => slot.attempt === 1)
      .map((slot) => ({ slot, artifactSaid: next() })),
    audits: (['Shared', 'H1', 'C1', 'C2', 'C3', 'H1TaskSearch'] as const).map((scope) => ({
      scope,
      assessmentArtifactSaid: next(),
      proofs: tamperAuditObligations.map((obligation) => ({
        scope,
        obligation,
        proofSaid: next(),
        finding: 'Pass',
      })),
      attemptCoverage: {
        scope,
        proofSaid: next(),
        complete: true,
        coveredRoles: [...tamperLifecycleRoles],
        attempts: [],
      },
      obligations: Object.fromEntries(tamperAuditObligations.map((name) => [name, 'Pass'])),
      verdict: 'Pass',
    })),
    budget: {
      coverageEventSaid: next(),
      totals: Object.fromEntries(dimensions.map((name) => [name, 1])),
      anchors: dimensions.map((dimension) => ({
        dimension,
        finalDebitEventSaid: next(),
        receiptArtifactSaid: next(),
        sourceEventSaid: next(),
      })),
    },
  });
  if (index.kind !== 'Prepared') throw new Error(`index fixture invalid: ${index.reason}`);
  const [sharedAudit, h1Audit, c1Audit, c2Audit, c3Audit, searchAudit] = index.index.audits.map(
    (audit) => audit.assessmentArtifactSaid,
  );
  if (!sharedAudit || !h1Audit || !c1Audit || !c2Audit || !c3Audit || !searchAudit)
    throw new Error('audit fixture incomplete');
  const prepared = prepareEvaluationClosure({
    evaluationId,
    evidenceStreamId: randomUUID(),
    originRunId: randomUUID(),
    manifestSaid: said('M'),
    evidenceIndexSaid: index.artifact.d,
    acceptedEventCount: 2,
    acceptedHeadSaid: said('h'),
    observationSaids: index.index.observations.map((entry) => entry.artifactSaid),
    measurementSaids: index.index.measurements.map((entry) => entry.artifactSaid),
    sharedAuditSaid: sharedAudit,
    armAuditSaids: {
      H1: h1Audit,
      C1: c1Audit,
      C2: c2Audit,
      C3: c3Audit,
      H1TaskSearch: searchAudit,
    },
    protectedCustodySaid: said('p'),
    agentSealSaid: said('g'),
  });
  if (prepared.kind !== 'Prepared') throw new Error('closure fixture invalid');
  return {
    ownerAid: said('o'),
    expectedEvaluationVersion: 2,
    closure: prepared.closure,
    evidenceIndex: { artifact: index.artifact, bytes: index.bytes },
  };
}

it('reconciles exact previously signed closure after the live lease expires without another effect', async () => {
  const input = fixture();
  const verify = vi.fn(() => Promise.resolve({ kind: 'Denied' as const }));
  const close = vi.fn();
  const reconcile = vi.fn(() =>
    Promise.resolve({ kind: 'AlreadyClosed' as const, closureSaid: input.closure.d }),
  );
  expect(
    await closeEvaluation(input, {
      authority: { verify },
      closures: { reconcile, close },
    }),
  ).toEqual({ kind: 'AlreadyClosed', closureSaid: input.closure.d });
  expect(reconcile).toHaveBeenCalledWith({
    ownerAid: input.ownerAid,
    closure: input.closure,
    evidenceIndex: input.evidenceIndex,
  });
  expect(verify).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
});
