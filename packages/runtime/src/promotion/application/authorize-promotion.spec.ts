import {
  comparisonSlots,
  closeComparison,
  selectPromotion,
  type CurrentExactPromotionMandate,
  type PromotionSelectionInput,
  type TrialObservation,
} from '@devrandom/domain';
import {
  prepareEvaluationClosure,
  prepareEvaluationManifest,
  preparePromotionSelectionRecord,
  type ActivationCommitCommand,
  type ActivationCommitReceipt,
} from '@devrandom/protocol';
import { describe, expect, it } from 'vitest';

import {
  authorizePromotion,
  type PromotionAuthorizationDependencies,
  type PromotionAuthorizationInput,
} from './authorize-promotion.js';
import type { VerifiedPromotionEvidence } from './promotion-conversations.js';

const said = (letter: string) => `E${letter.repeat(43)}`;
const taskId = 'bbb13317-1c5e-4472-842e-692da01386cf';
const lineageId = '5ebf49b9-df26-4a49-9194-da868f97cf9d';
const governorAid = said('g');

const audit = {
  measurementValidity: 'Pass',
  representationalFidelity: 'Pass',
  proceduralIntegrity: 'Pass',
  authorizationAndAccess: 'Pass',
  protectedArtifactAndStateIntegrity: 'Pass',
  provenanceAndSourceAttribution: 'Pass',
  requiredSetCompleteness: 'Pass',
} as const;

function allowance() {
  return {
    providerRequests: 1,
    providerInputTokens: 1000,
    providerOutputTokens: 100,
    providerSpendMicroUsd: 100,
    runWallTimeSeconds: 10,
    toolProposals: 10,
    aggregateChildCommandTimeSeconds: 10,
    changedFiles: 2,
    changedWorktreeBytes: 2000,
    evidencePlusArtifactsPerRunBytes: 20000,
  };
}

function verifiedEvidence(controlSuccesses = 0): VerifiedPromotionEvidence {
  const manifest = prepareEvaluationManifest({
    evaluationId: '81d7f67f-d2f9-4fae-87cc-ac827de6f0d1',
    taskId,
    taskRevisionSaid: said('t'),
    originRunId: '91d7f67f-d2f9-4fae-87cc-ac827de6f0d1',
    ownerAid: said('o'),
    personalAgentAid: said('a'),
    taskMandateSaid: said('d'),
    retainedCheckpointSaid: said('b'),
    retainedSealSaid: said('f'),
    policySaid: said('p'),
    revisions: { H1: said('h'), C1: said('i'), C2: said('j'), C3: said('k') },
    executionProfileSaid: said('l'),
    sourceInventorySaid: said('m'),
    verifierSaid: said('v'),
    protectedCaseArtifactSaid: said('x'),
    finalCaseArtifactSaid: said('y'),
    publicConditionIds: ['public'],
    heldOutCaseCount: 1,
    allocation: { diagnosis: allowance(), perEntry: allowance(), finalization: allowance() },
  });
  if (manifest.kind !== 'Prepared') throw new Error('manifest fixture rejected');
  const closure = prepareEvaluationClosure({
    evaluationId: manifest.manifest.evaluationId,
    evidenceStreamId: '71d7f67f-d2f9-4fae-87cc-ac827de6f0d1',
    originRunId: manifest.manifest.originRunId,
    manifestSaid: manifest.manifest.d,
    evidenceIndexSaid: said('I'),
    acceptedEventCount: 42,
    acceptedHeadSaid: said('q'),
    observationSaids: Array.from({ length: 18 }, (_, index) =>
      said(String.fromCharCode(65 + index)),
    ),
    measurementSaids: Array.from({ length: 15 }, (_, index) =>
      said(String.fromCharCode(97 + index)),
    ),
    sharedAuditSaid: said('u'),
    armAuditSaids: {
      H1: said('a'),
      C1: said('b'),
      C2: said('c'),
      C3: said('d'),
      H1TaskSearch: said('e'),
    },
    protectedCustodySaid: said('w'),
    agentSealSaid: said('z'),
  });
  if (closure.kind !== 'Prepared') throw new Error('closure fixture rejected');
  const observations: TrialObservation[] = comparisonSlots().map((slot) => {
    const control = slot.arm === 'H1' || slot.arm === 'H1TaskSearch';
    const accepted = !control || slot.repetition <= controlSuccesses;
    return {
      slot,
      disposition: {
        kind: 'Measured',
        artifactSaid: said(slot.arm === 'C2' ? String(slot.repetition) : 'r'),
        publicConditionIds: accepted ? ['public'] : [],
        heldOutConditionIds: accepted ? ['heldout'] : [],
        usage: {
          providerRequests: 1,
          inputTokens: slot.arm === 'C2' ? 100 : slot.arm === 'C1' ? 200 : 300,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          spendMicroUsd: 1,
          elapsedMilliseconds: 100,
          repeatedFailures: 0,
          unsafeProposals: 0,
          unsafePrevented: 0,
          unsafeEffects: 0,
        },
      },
    };
  });
  const comparison: PromotionSelectionInput = {
    conditions: { public: ['public'], heldOut: ['heldout'] },
    observations,
    sharedAudit: audit,
    evaluationAuthority: 'Current',
    allocation: 'WithinCeiling',
    evidence: 'Acknowledged',
    candidates: (['C1', 'C2', 'C3'] as const).map((arm) => ({
      arm,
      revisionSaid: manifest.manifest.revisions[arm],
      audit,
      budget: 'WithinCeiling',
      prohibitedAttempts: [],
      repetitions: ([1, 2, 3] as const).map((repetition) => ({
        repetition,
        artifactSaid: said(arm === 'C2' ? String(repetition) : 'r'),
        artifactBinding: 'Matched',
        tamper: 'Rejected',
      })),
    })),
  };
  const selected = selectPromotion(comparison);
  if (selected.kind === 'SelectionBlocked') throw new Error('fixture selection blocked');
  const measured = closeComparison(comparison.conditions, comparison.observations);
  if (measured.kind !== 'EvidenceOnly') throw new Error('fixture measurements blocked');
  const selection =
    selected.kind === 'RetainIncumbent'
      ? { kind: 'RetainIncumbent' as const }
      : {
          kind: 'Activate' as const,
          candidateRevisionSaid: selected.revisionSaid,
          artifactSaids: ([1, 2, 3] as const).map((repetition) => {
            const artifactSaid = measured.measurements.find(
              (entry) => entry.slot.arm === selected.arm && entry.slot.repetition === repetition,
            )?.artifactSaid;
            if (artifactSaid === undefined) throw new Error('fixture artifact absent');
            return artifactSaid;
          }),
        };
  const record = preparePromotionSelectionRecord({
    taskId,
    taskRevisionSaid: manifest.manifest.taskRevisionSaid,
    harnessLineageId: lineageId,
    expectedIncumbentRevisionSaid: manifest.manifest.revisions.H1,
    expectedPointerVersion: 1,
    evaluationManifestSaid: manifest.manifest.d,
    evaluationClosureSaid: closure.closure.d,
    hypothesisSaid: said('n'),
    selection,
  });
  if (record.kind !== 'Prepared') throw new Error('fixture selection record rejected');
  return {
    manifest: manifest.manifest,
    closure: closure.closure,
    hypothesisSaid: said('n'),
    selectionRecord: record.record,
    comparison,
  };
}

function harness(controlSuccesses = 0) {
  const evidence = verifiedEvidence(controlSuccesses);
  const input: PromotionAuthorizationInput = {
    commandId: '6eb93221-1ad0-4555-9aa3-b2ff2ed541a6',
    taskId,
    taskRevisionSaid: evidence.manifest.taskRevisionSaid,
    harnessLineageId: lineageId,
    expectedIncumbentRevisionSaid: evidence.manifest.revisions.H1,
    expectedPointerVersion: 1,
    evaluationClosureSaid: evidence.closure.d,
    governorAid,
  };
  let staged: ActivationCommitCommand | undefined;
  let agentSigns = 0;
  let governorSigns = 0;
  let commits = 0;
  let routes = 0;
  let reply: ActivationCommitReceipt | undefined;
  let reading: Awaited<ReturnType<PromotionAuthorizationDependencies['evidence']['inspect']>> = {
    kind: 'Verified',
    evidence,
  };
  let authorityKind: 'Current' | 'PendingUserConfirmation' | 'Invalid' = 'Current';
  let agentSourceAid = evidence.manifest.personalAgentAid;
  let governorSourceAid = governorAid;
  let mandate = {
    credential: {
      credentialSaid: said('A'),
      issueeAid: governorAid,
      issuerAid: evidence.manifest.ownerAid,
    },
    evaluationManifestSaid: evidence.manifest.d,
    taskId,
    taskRevisionSaid: evidence.manifest.taskRevisionSaid,
    harnessLineageId: lineageId,
  } as CurrentExactPromotionMandate;
  const dependencies: PromotionAuthorizationDependencies = {
    evidence: {
      async inspect() {
        await Promise.resolve();
        return reading;
      },
    },
    authority: {
      async verify() {
        await Promise.resolve();
        return authorityKind === 'Current' ? { kind: 'Current', mandate } : { kind: authorityKind };
      },
    },
    agent: {
      async sign(payload) {
        await Promise.resolve();
        agentSigns++;
        return { kind: 'Verified', exchangeSaid: said('P'), sourceAid: agentSourceAid, payload };
      },
    },
    governor: {
      async sign({ decision }) {
        await Promise.resolve();
        governorSigns++;
        return {
          kind: 'Verified',
          exchangeSaid: said('G'),
          sourceAid: governorSourceAid,
          payload: decision,
        };
      },
    },
    commands: {
      async inspect() {
        await Promise.resolve();
        return staged === undefined ? { kind: 'Absent' } : { kind: 'Staged', command: staged };
      },
      async stage(command) {
        await Promise.resolve();
        staged = command;
        return 'Staged';
      },
    },
    hosted: {
      async commit(command) {
        await Promise.resolve();
        commits++;
        return (
          reply ?? {
            kind: 'Committed',
            decisionReceiptSaid: said('R'),
            activeRevisionSaid:
              command.disposition.kind === 'Activate'
                ? command.disposition.candidateRevisionSaid
                : command.expectedIncumbentRevisionSaid,
            pointerVersion: command.disposition.kind === 'Activate' ? 2 : 1,
            disposition: command.disposition.kind === 'Activate' ? 'Activated' : 'Retained',
          }
        );
      },
    },
    routing: {
      async activate() {
        await Promise.resolve();
        routes++;
        return 'Routed';
      },
    },
  };
  return {
    evidence,
    input,
    dependencies,
    counts: () => ({ agentSigns, governorSigns, commits, routes }),
    command: () => staged,
    setReading(value: typeof reading) {
      reading = value;
    },
    setAuthority(value: typeof authorityKind) {
      authorityKind = value;
    },
    setAgentSource(value: string) {
      agentSourceAid = value;
    },
    setGovernorSource(value: string) {
      governorSourceAid = value;
    },
    setReply(value: ActivationCommitReceipt) {
      reply = value;
    },
    setMandateTask(value: string) {
      mandate = { ...mandate, taskId: value };
    },
  };
}

describe('local governed promotion', () => {
  it('cannot sign or commit without complete real E3 evidence and exact M binding', async () => {
    const caseOne = harness();
    caseOne.setReading({ kind: 'Incomplete' });
    expect(await authorizePromotion(caseOne.input, caseOne.dependencies)).toEqual({
      kind: 'Blocked',
      reason: 'EvidenceIncomplete',
    });
    expect(caseOne.counts()).toEqual({ agentSigns: 0, governorSigns: 0, commits: 0, routes: 0 });
    const caseTwo = harness();
    caseTwo.setReading({
      kind: 'Verified',
      evidence: {
        ...caseTwo.evidence,
        closure: { ...caseTwo.evidence.closure, manifestSaid: said('X') },
      },
    });
    expect(await authorizePromotion(caseTwo.input, caseTwo.dependencies)).toEqual({
      kind: 'Blocked',
      reason: 'EvidenceInvalid',
    });
    expect(caseTwo.counts().commits).toBe(0);
  });

  it('recomputes selection from complete observations and rejects a substituted signed record', async () => {
    const test = harness();
    const alternate = preparePromotionSelectionRecord({
      taskId: test.input.taskId,
      taskRevisionSaid: test.input.taskRevisionSaid,
      harnessLineageId: test.input.harnessLineageId,
      expectedIncumbentRevisionSaid: test.input.expectedIncumbentRevisionSaid,
      expectedPointerVersion: test.input.expectedPointerVersion,
      evaluationManifestSaid: test.evidence.manifest.d,
      evaluationClosureSaid: test.evidence.closure.d,
      hypothesisSaid: said('n'),
      selection: { kind: 'RetainIncumbent' },
    });
    if (alternate.kind !== 'Prepared') throw new Error('substitution fixture rejected');
    test.setReading({
      kind: 'Verified',
      evidence: { ...test.evidence, selectionRecord: alternate.record },
    });
    expect(await authorizePromotion(test.input, test.dependencies)).toEqual({
      kind: 'Blocked',
      reason: 'EvidenceInvalid',
    });
    expect(test.counts()).toEqual({ agentSigns: 0, governorSigns: 0, commits: 0, routes: 0 });
  });

  it('waits for explicit current exact-M user authority before any signing', async () => {
    const test = harness();
    test.setAuthority('PendingUserConfirmation');
    expect(await authorizePromotion(test.input, test.dependencies)).toEqual({
      kind: 'Blocked',
      reason: 'UserConfirmationPending',
    });
    expect(test.counts()).toEqual({ agentSigns: 0, governorSigns: 0, commits: 0, routes: 0 });
    const wrongTask = harness();
    wrongTask.setMandateTask('0e79dc08-c58f-455b-ae0d-ac68682aa754');
    expect(await authorizePromotion(wrongTask.input, wrongTask.dependencies)).toEqual({
      kind: 'Blocked',
      reason: 'AuthorityUnavailable',
    });
    expect(wrongTask.counts().agentSigns).toBe(0);
  });

  it('rejects a proposal or decision signed by the wrong principal', async () => {
    const wrongAgent = harness();
    wrongAgent.setAgentSource(governorAid);
    expect(await authorizePromotion(wrongAgent.input, wrongAgent.dependencies)).toEqual({
      kind: 'Blocked',
      reason: 'SignatureInvalid',
    });
    expect(wrongAgent.counts().governorSigns).toBe(0);
    const wrongGovernor = harness();
    wrongGovernor.setGovernorSource(wrongGovernor.evidence.manifest.personalAgentAid);
    expect(await authorizePromotion(wrongGovernor.input, wrongGovernor.dependencies)).toEqual({
      kind: 'Blocked',
      reason: 'SignatureInvalid',
    });
    expect(wrongGovernor.counts().commits).toBe(0);
  });

  it('stages one signed exact command and routes H2 only after a matching CAS receipt', async () => {
    const test = harness();
    const result = await authorizePromotion(test.input, test.dependencies);
    expect(result).toEqual({
      kind: 'Activated',
      revisionSaid: test.evidence.manifest.revisions.C2,
      receiptSaid: said('R'),
    });
    expect(test.counts()).toEqual({ agentSigns: 1, governorSigns: 1, commits: 1, routes: 1 });
    expect(test.command()).toMatchObject({
      evaluationManifestSaid: test.evidence.manifest.d,
      evaluationClosureSaid: test.evidence.closure.d,
      disposition: { kind: 'Activate', candidateRevisionSaid: test.evidence.manifest.revisions.C2 },
    });
  });

  it('leaves routing untouched on an uncertain commit and retries exact staged bytes', async () => {
    const test = harness();
    test.setReply({ kind: 'Unavailable' });
    expect(await authorizePromotion(test.input, test.dependencies)).toEqual({
      kind: 'CommitUncertain',
    });
    const first = test.command();
    expect(test.counts().routes).toBe(0);
    test.setReply({
      kind: 'AlreadyCommitted',
      decisionReceiptSaid: said('R'),
      activeRevisionSaid: test.evidence.manifest.revisions.C2,
      pointerVersion: 2,
      disposition: 'Activated',
    });
    expect(await authorizePromotion(test.input, test.dependencies)).toMatchObject({
      kind: 'Activated',
    });
    expect(test.command()).toEqual(first);
    expect(test.counts()).toEqual({ agentSigns: 1, governorSigns: 1, commits: 2, routes: 1 });
  });

  it('treats a mismatched hosted receipt as uncertain and never routes it', async () => {
    const test = harness();
    test.setReply({
      kind: 'Committed',
      decisionReceiptSaid: said('R'),
      activeRevisionSaid: said('W'),
      pointerVersion: 2,
      disposition: 'Activated',
    });
    expect(await authorizePromotion(test.input, test.dependencies)).toEqual({
      kind: 'CommitUncertain',
    });
    expect(test.counts().routes).toBe(0);
  });

  it('records a signed H1 retention without routing a successor', async () => {
    const test = harness(2);
    expect(await authorizePromotion(test.input, test.dependencies)).toEqual({
      kind: 'Retained',
      receiptSaid: said('R'),
    });
    expect(test.command()?.disposition).toEqual({
      kind: 'RetainIncumbent',
      selectionEvidenceSaid: test.evidence.selectionRecord.d,
    });
    expect(test.counts()).toEqual({ agentSigns: 1, governorSigns: 1, commits: 1, routes: 0 });
  });
});
