import { comparisonSlots, tamperAuditObligations, tamperLifecycleRoles } from '@devrandom/domain';
import {
  prepareEvaluationClosure,
  prepareEvaluationClosureEvidenceIndex,
  preparePromotionSelectionRecord,
} from '@devrandom/protocol';

export const said = (letter: string) => `E${letter.repeat(43)}`;
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
const evaluationId = '11111111-1111-4111-8111-111111111111';
const streamId = '33333333-3333-4333-8333-333333333333';
const originRunId = '44444444-4444-4444-8444-444444444444';
const taskId = '55555555-5555-4555-8555-555555555555';
const lineageId = '66666666-6666-4666-8666-666666666666';

export function fixture(manifestSaid = said('M')) {
  let serial = 0;
  const nextSaid = () => `E${String(++serial).padStart(43, '0')}`;
  const index = prepareEvaluationClosureEvidenceIndex({
    version: 1,
    kind: 'EvaluationClosureEvidenceIndex',
    evaluationId,
    manifestSaid,
    sourceInventorySaid: said('S'),
    hypothesisSaid: said('H'),
    lease: { leaseId: '22222222-2222-4222-8222-222222222222', version: 3 },
    observations: comparisonSlots().map((slot) => ({ slot, artifactSaid: nextSaid() })),
    measurements: comparisonSlots()
      .filter((slot) => slot.attempt === 1)
      .map((slot) => ({ slot, artifactSaid: nextSaid() })),
    audits: scopes.map((scope) => ({
      scope,
      assessmentArtifactSaid: nextSaid(),
      proofs: tamperAuditObligations.map((obligation) => ({
        scope,
        obligation,
        proofSaid: nextSaid(),
        finding: 'Pass' as const,
      })),
      attemptCoverage: {
        scope,
        proofSaid: nextSaid(),
        complete: true,
        coveredRoles: [...tamperLifecycleRoles],
        attempts: [],
      },
      obligations: Object.fromEntries(
        tamperAuditObligations.map((obligation) => [obligation, 'Pass']),
      ),
      verdict: 'Pass' as const,
    })),
    budget: {
      coverageEventSaid: said('Q'),
      totals: Object.fromEntries(dimensions.map((dimension) => [dimension, 1])),
      anchors: dimensions.map((dimension) => ({
        dimension,
        finalDebitEventSaid: nextSaid(),
        receiptArtifactSaid: nextSaid(),
        sourceEventSaid: nextSaid(),
      })),
    },
  });
  if (index.kind !== 'Prepared') throw new Error(`index fixture: ${index.reason}`);
  const [shared, h1, c1, c2, c3, search] = index.index.audits;
  if (!shared || !h1 || !c1 || !c2 || !c3 || !search) throw new Error('audit fixture missing');
  const closure = prepareEvaluationClosure({
    evaluationId,
    evidenceStreamId: streamId,
    originRunId,
    manifestSaid: index.index.manifestSaid,
    evidenceIndexSaid: index.artifact.d,
    acceptedEventCount: 42,
    acceptedHeadSaid: said('Q'),
    observationSaids: index.index.observations.map((item) => item.artifactSaid),
    measurementSaids: index.index.measurements.map((item) => item.artifactSaid),
    sharedAuditSaid: shared.assessmentArtifactSaid,
    armAuditSaids: {
      H1: h1.assessmentArtifactSaid,
      C1: c1.assessmentArtifactSaid,
      C2: c2.assessmentArtifactSaid,
      C3: c3.assessmentArtifactSaid,
      H1TaskSearch: search.assessmentArtifactSaid,
    },
    protectedCustodySaid: said('P'),
    agentSealSaid: said('A'),
  });
  if (closure.kind !== 'Prepared') throw new Error(`closure fixture: ${closure.reason}`);
  const command = {
    version: 1 as const,
    commandId: '77777777-7777-4777-8777-777777777777',
    fingerprint: `sha256:${'a'.repeat(64)}`,
    expectedEvaluationVersion: 42,
    closure: closure.closure,
    evidenceIndex: {
      artifact: index.artifact,
      bytesBase64Url: Buffer.from(index.bytes).toString('base64url'),
    },
  };
  const selection = preparePromotionSelectionRecord({
    taskId,
    taskRevisionSaid: said('T'),
    harnessLineageId: lineageId,
    expectedIncumbentRevisionSaid: said('R'),
    expectedPointerVersion: 1,
    evaluationManifestSaid: index.index.manifestSaid,
    evaluationClosureSaid: closure.closure.d,
    hypothesisSaid: index.index.hypothesisSaid,
    selection: { kind: 'RetainIncumbent' },
  });
  if (selection.kind !== 'Prepared') throw new Error(`selection fixture: ${selection.reason}`);
  return { command, selection: selection.record };
}
