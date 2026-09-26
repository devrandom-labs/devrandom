import {
  comparisonSlots,
  type CurrentExactPromotionMandate,
  type PromotionSelectionInput,
} from '@devrandom/domain';
import {
  governorAid,
  issuerAid,
  personalAgentAid,
  type LocalPromotionExchanges,
  type PreparedPromotionExchange,
  type StablePromotionExchange,
} from '@devrandom/identity';
import {
  prepareEvaluationClosure,
  prepareEvaluationManifest,
  preparePromotionSelectionRecord,
  type GovernorPromotionDecisionPayload,
  type PromotionProposalPayload,
} from '@devrandom/protocol';
import type { ExactPromotionAuthority, VerifiedPromotionEvidence } from '@devrandom/runtime';
import { describe, expect, it, vi } from 'vitest';

import {
  signifyLocalPromotionSigning,
  type LocalGovernorPromotionConfirmation,
} from './signify-local-promotion-signing.js';

const said = (letter: string) => `E${letter.repeat(43)}`;
const taskId = 'bbb13317-1c5e-4472-842e-692da01386cf';
const lineageId = '5ebf49b9-df26-4a49-9194-da868f97cf9d';
const agent = personalAgentAid('EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz');
const governor = governorAid('EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk');
const issuer = issuerAid('EHcQUn2xY9KN1yv6FP0c6-pxej14Z8JDD3IYLddg0wOh');
const audit = {
  measurementValidity: 'Pass',
  representationalFidelity: 'Pass',
  proceduralIntegrity: 'Pass',
  authorizationAndAccess: 'Pass',
  protectedArtifactAndStateIntegrity: 'Pass',
  provenanceAndSourceAttribution: 'Pass',
  requiredSetCompleteness: 'Pass',
} as const;
const allowance = {
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

function fixture() {
  const manifest = prepareEvaluationManifest({
    evaluationId: '81d7f67f-d2f9-4fae-87cc-ac827de6f0d1',
    taskId,
    taskRevisionSaid: said('t'),
    originRunId: '91d7f67f-d2f9-4fae-87cc-ac827de6f0d1',
    ownerAid: issuer,
    personalAgentAid: agent,
    taskMandateSaid: said('d'),
    retainedCheckpointSaid: said('b'),
    retainedSealSaid: said('f'),
    policySaid: said('p'),
    revisions: { H1: said('h'), C1: said('i'), C2: said('j'), C3: said('k') },
    executionProfileSaid: said('l'),
    sourceInventorySaid: said('m'),
    hypothesisSaid: said('H'),
    verifierSaid: said('v'),
    protectedCaseArtifactSaid: said('x'),
    finalCaseArtifactSaid: said('y'),
    publicConditionIds: ['public'],
    heldOutCaseCount: 1,
    allocation: { diagnosis: allowance, perEntry: allowance, finalization: allowance },
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
  const comparison: PromotionSelectionInput = {
    conditions: { public: ['public'], heldOut: ['heldout'] },
    observations: comparisonSlots().map((slot) => ({
      slot,
      disposition: {
        kind: 'Measured',
        artifactSaid: said('r'),
        publicConditionIds: ['public'],
        heldOutConditionIds: ['heldout'],
        usage: {
          providerRequests: 1,
          inputTokens: 100,
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
    })),
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
        artifactSaid: said('r'),
        artifactBinding: 'Matched',
        tamper: 'Rejected',
      })),
    })),
  };
  const selection = preparePromotionSelectionRecord({
    taskId,
    taskRevisionSaid: manifest.manifest.taskRevisionSaid,
    harnessLineageId: lineageId,
    expectedIncumbentRevisionSaid: manifest.manifest.revisions.H1,
    expectedPointerVersion: 1,
    evaluationManifestSaid: manifest.manifest.d,
    evaluationClosureSaid: closure.closure.d,
    hypothesisSaid: said('n'),
    selection: { kind: 'RetainIncumbent' },
  });
  if (selection.kind !== 'Prepared') throw new Error('selection fixture rejected');
  const evidence: VerifiedPromotionEvidence = {
    manifest: manifest.manifest,
    closure: closure.closure,
    hypothesisSaid: said('n'),
    selectionRecord: selection.record,
    comparison,
  };
  const mandate = {
    taskId,
    taskRevisionSaid: manifest.manifest.taskRevisionSaid,
    harnessLineageId: lineageId,
    evaluationManifestSaid: manifest.manifest.d,
    credential: { credentialSaid: said('A'), issuerAid: issuer, issueeAid: governor },
  } as CurrentExactPromotionMandate;
  const proposal: PromotionProposalPayload = {
    version: 1,
    kind: 'PromotionProposal',
    taskId,
    taskRevisionSaid: manifest.manifest.taskRevisionSaid,
    harnessLineageId: lineageId,
    expectedIncumbentRevisionSaid: manifest.manifest.revisions.H1,
    expectedPointerVersion: 1,
    evaluationManifestSaid: manifest.manifest.d,
    evaluationClosureSaid: closure.closure.d,
    disposition: { kind: 'RetainIncumbent', selectionEvidenceSaid: selection.record.d },
    hypothesisSaid: said('n'),
  };
  const decision: GovernorPromotionDecisionPayload = {
    version: 1,
    kind: 'GovernorPromotionDecision',
    taskId,
    taskRevisionSaid: proposal.taskRevisionSaid,
    harnessLineageId: lineageId,
    expectedIncumbentRevisionSaid: proposal.expectedIncumbentRevisionSaid,
    expectedPointerVersion: proposal.expectedPointerVersion,
    evaluationManifestSaid: proposal.evaluationManifestSaid,
    evaluationClosureSaid: proposal.evaluationClosureSaid,
    disposition: proposal.disposition,
    exactPromotionMandateSaid: mandate.credential.credentialSaid,
    agentProposalExchangeSaid: said('P'),
  };
  return { evidence, mandate, proposal, decision };
}

describe('Signify local promotion signing', () => {
  it('binds separate native personal-agent and Governor exchanges to exact evidence and authority', async () => {
    const { evidence, mandate, proposal, decision } = fixture();
    const prepare = vi.fn((input: StablePromotionExchange): Promise<PreparedPromotionExchange> =>
      Promise.resolve({ exchangeSaid: input.kind === 'Proposal' ? said('P') : said('G') }),
    );
    const deliver = vi.fn(
      (
        input: StablePromotionExchange & PreparedPromotionExchange,
      ): Promise<PreparedPromotionExchange> =>
        Promise.resolve({ exchangeSaid: input.exchangeSaid }),
    );
    const exchanges: LocalPromotionExchanges = { prepare, deliver };
    const verify = vi.fn<ExactPromotionAuthority['verify']>(() =>
      Promise.resolve({ kind: 'Current', mandate }),
    );
    const confirm = vi.fn<LocalGovernorPromotionConfirmation['confirm']>(() =>
      Promise.resolve('Confirmed'),
    );
    const signers = signifyLocalPromotionSigning({
      exchanges,
      agentAid: agent,
      governorAid: governor,
      issuerAid: issuer,
      authority: { verify },
      confirm,
      now: () => 123,
    });
    expect(await signers.agent.sign(proposal)).toEqual({
      kind: 'Verified',
      exchangeSaid: said('P'),
      sourceAid: agent,
      payload: proposal,
    });
    expect(await signers.governor.sign({ decision, mandate, evidence })).toEqual({
      kind: 'Verified',
      exchangeSaid: said('G'),
      sourceAid: governor,
      payload: decision,
    });
    expect(prepare.mock.calls.map(([input]) => input.senderAlias)).toEqual([
      'devrandom-personal-agent',
      'devrandom-governor',
    ]);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('denies a changed decision, missing user confirmation, or stale exact-M authority before Governor signature', async () => {
    const { evidence, mandate, decision, proposal } = fixture();
    const prepare = vi.fn((input: StablePromotionExchange): Promise<PreparedPromotionExchange> =>
      Promise.resolve({ exchangeSaid: input.kind === 'Proposal' ? said('P') : said('G') }),
    );
    const exchanges: LocalPromotionExchanges = {
      prepare,
      deliver: (input) => Promise.resolve({ exchangeSaid: input.exchangeSaid }),
    };
    const verify = vi.fn<ExactPromotionAuthority['verify']>(() =>
      Promise.resolve({ kind: 'Current', mandate }),
    );
    const confirm = vi.fn<LocalGovernorPromotionConfirmation['confirm']>(() =>
      Promise.resolve('Confirmed'),
    );
    const signers = signifyLocalPromotionSigning({
      exchanges,
      agentAid: agent,
      governorAid: governor,
      issuerAid: issuer,
      authority: { verify },
      confirm,
      now: () => 123,
    });
    expect((await signers.agent.sign(proposal)).kind).toBe('Verified');
    prepare.mockClear();
    expect(
      await signers.governor.sign({
        decision: { ...decision, evaluationManifestSaid: said('x') },
        mandate,
        evidence,
      }),
    ).toEqual({ kind: 'Rejected' });
    expect(prepare).not.toHaveBeenCalled();
    confirm.mockResolvedValueOnce('Pending');
    expect(await signers.governor.sign({ decision, mandate, evidence })).toEqual({
      kind: 'Rejected',
    });
    expect(prepare).not.toHaveBeenCalled();
    verify.mockResolvedValueOnce({ kind: 'Invalid' });
    expect(await signers.governor.sign({ decision, mandate, evidence })).toEqual({
      kind: 'Rejected',
    });
    expect(prepare).not.toHaveBeenCalled();
  });
});
