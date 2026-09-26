import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';
import {
  prepareEvaluationEvidenceEvent,
  prepareEvidenceArtifact,
  type EvidenceArtifact,
  type EvaluationEvidenceEvent,
} from '@devrandom/protocol';

import { inspectParentTrialUsage } from './inspect-parent-trial-usage.js';

const said = (letter: string): string => `E${letter.repeat(43)}`;

function fixture(
  outcomeKind: 'None' | 'CapabilityNotGranted' | 'SecretDetected' = 'None',
  invalidCumulative = false,
  forgedSource = false,
  missingAcceptedUsage = false,
  mismatchedAcceptedUsage = false,
) {
  const binding = {
    kind: 'Evaluation' as const,
    evaluationId: randomUUID(),
    evaluationLeaseId: randomUUID(),
    evidenceStreamId: randomUUID(),
    originRunId: randomUUID(),
    taskId: randomUUID(),
    taskRevisionSaid: said('t'),
    personalAgentAid: said('a'),
    taskMandateSaid: said('m'),
    harnessRevisionSaid: said('h'),
    phase: {
      kind: 'Trial' as const,
      manifestSaid: said('v'),
      arm: 'H1' as const,
      repetition: 1 as const,
      attempt: 1 as const,
    },
  };
  const artifacts = new Map<string, { artifact: EvidenceArtifact; bytes: Uint8Array }>();
  const raw = (value: unknown) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const prepared = prepareEvidenceArtifact(bytes, 'application/json');
    if (prepared.kind !== 'Prepared') throw new Error(prepared.reason);
    artifacts.set(prepared.artifact.d, { artifact: prepared.artifact, bytes });
    return prepared.artifact.d;
  };
  const events: EvaluationEvidenceEvent[] = [];
  const append = (detail: unknown) => {
    const prior = events.at(-1);
    const prepared = prepareEvaluationEvidenceEvent({
      evaluationId: binding.evaluationId,
      streamId: binding.evidenceStreamId,
      originRunId: binding.originRunId,
      taskId: binding.taskId,
      taskRevisionSaid: binding.taskRevisionSaid,
      personalAgentAid: binding.personalAgentAid,
      taskMandateSaid: binding.taskMandateSaid,
      harnessRevisionSaid: binding.harnessRevisionSaid,
      phase: binding.phase,
      sequence: events.length,
      previous:
        prior === undefined ? { kind: 'Genesis' } : { kind: 'Previous', eventSaid: prior.d },
      occurredAt: '2026-09-26T10:00:00.000Z',
      detail: detail as EvaluationEvidenceEvent['detail'],
    });
    if (prepared.kind !== 'Prepared') throw new Error(prepared.reason);
    events.push(prepared.event);
    return prepared.event;
  };
  const usageEventSaid = missingAcceptedUsage
    ? said('u')
    : append({
        kind: 'UsageDebited',
        providerRequests: 1,
        inputTokens: mismatchedAcceptedUsage ? 11 : 10,
        outputTokens: 2,
        cacheReadTokens: 3,
        cacheWriteTokens: 1,
        spendMicroUsd: 7,
        elapsedMilliseconds: 0,
      }).d;
  const responseId = 'response-one';
  const exchange = raw({
    kind: 'ModelExchange',
    requestOrdinal: 0,
    usageEventSaid,
    message: {
      provider: 'concentrate',
      model: 'deepinfra/deepseek-v4-flash-0731',
      responseId,
      usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 1, totalTokens: 16 },
      content:
        outcomeKind === 'None'
          ? []
          : [{ type: 'toolCall', id: 'call-one', name: 'read_file', arguments: { path: 'src' } }],
    },
  });
  const exchangeEvent = append({ kind: 'ModelExchange', rawArtifactSaid: exchange });
  const providerReceipt = raw({
    kind: 'EvaluationProviderUsage',
    requestOrdinal: 0,
    modelExchangeEventSaid: exchangeEvent.d,
    usageEventSaid,
    provider: 'concentrate',
    model: 'deepinfra/deepseek-v4-flash-0731',
    responseId,
    inputTokens: 14,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 1,
    spendMicroUsd: 7,
  });
  append({ kind: 'ArtifactCaptured', artifactSaid: providerReceipt, custody: 'Public' });
  for (const [budget, amount] of [
    ['providerRequests', 1],
    ['providerInputTokens', 14],
    ['providerOutputTokens', 2],
    ['providerSpendMicroUsd', 7],
  ] as const)
    append({
      kind: 'EvaluationBudgetDebited',
      budget,
      amount,
      consumed: invalidCumulative && budget === 'providerOutputTokens' ? amount + 1 : amount,
      receiptArtifactSaid: providerReceipt,
      sourceEventSaid: forgedSource && budget === 'providerRequests' ? said('f') : exchangeEvent.d,
    });
  if (outcomeKind !== 'None') {
    const proposalRaw = raw({
      kind: 'ToolProposal',
      proposal: {
        toolCallId: 'call-one',
        proposalIndex: 0,
        input: { kind: 'ReadFile', path: 'src' },
      },
    });
    const proposed = append({
      kind: 'ToolProposed',
      proposalIndex: 0,
      toolCallId: 'call-one',
      inputArtifactSaid: proposalRaw,
    });
    const outcomeRaw = raw({
      kind: 'ToolOutcome',
      outcome:
        outcomeKind === 'SecretDetected'
          ? { kind: 'SecretDetected' }
          : { kind: 'Rejected', reason: 'CapabilityNotGranted' },
    });
    append({
      kind: 'ToolAuthorization',
      proposalEventSaid: proposed.d,
      disposition: 'Denied',
      receiptArtifactSaid: outcomeRaw,
    });
  }
  const cleanupReceipt = raw({ kind: 'Cleanup', confirmed: true });
  const cleanup = append({
    kind: 'ArtifactCaptured',
    artifactSaid: cleanupReceipt,
    custody: 'Public',
  });
  const wallReceipt = raw({
    kind: 'EvaluationWallElapsed',
    method: 'ParentMonotonicStartThroughCleanup',
    startedMonotonicMicroseconds: 1000,
    finishedMonotonicMicroseconds: 1_001_000,
    elapsedMilliseconds: 1000,
    debitedSeconds: 1,
    cleanupEventSaid: cleanup.d,
  });
  append({ kind: 'ArtifactCaptured', artifactSaid: wallReceipt, custody: 'Public' });
  append({
    kind: 'EvaluationBudgetDebited',
    budget: 'runWallTimeSeconds',
    amount: 1,
    consumed: 1,
    receiptArtifactSaid: wallReceipt,
    sourceEventSaid: cleanup.d,
  });
  const stopped = append({ kind: 'TrialStopped', reason: 'Completed' });
  const protectedObservationSaid = said('p');
  const custody = append({
    kind: 'ArtifactCaptured',
    artifactSaid: protectedObservationSaid,
    custody: 'ProtectedCiphertext',
  });
  const input = {
    binding,
    trialEvidenceHeadSaid: stopped.d,
    protectedObservationSaid,
    custodyEvidenceHeadSaid: custody.d,
    custodyEvidenceSequence: custody.sequence,
    providerUsageEventSaids: [usageEventSaid],
  };
  const accepted = {
    openPrefix: vi.fn(() =>
      Promise.resolve({
        kind: 'Acknowledged' as const,
        events,
        throughSequence: custody.sequence,
        headSaid: custody.d,
      }),
    ),
  };
  const receipts = {
    openPublic: vi.fn((query: { artifactSaid: string }) => {
      const found = artifacts.get(query.artifactSaid);
      return Promise.resolve(
        found === undefined ? { kind: 'Missing' as const } : { kind: 'Opened' as const, ...found },
      );
    }),
    verifyProviderUsage: vi.fn(() =>
      Promise.resolve({
        kind: 'Verified' as const,
        usageEventSaid,
        responseId,
        inputTokens: 14,
        outputTokens: 2,
        spendMicroUsd: 7,
      }),
    ),
  };
  return { input, accepted, receipts, events, artifacts };
}

describe('parent-observed trial usage facts', () => {
  it('derives provider/cache/wall and mediated safety subset but leaves repeated failures unresolved', async () => {
    const given = fixture();
    const inspected = await inspectParentTrialUsage(given.input, given);
    expect(inspected).toEqual({
      kind: 'ObservedSubset',
      providerRequests: 1,
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 1,
      spendMicroUsd: 7,
      elapsedMilliseconds: 1000,
      unsafeProposals: 0,
      unsafePrevented: 0,
      unsafeEffects: 0,
      unresolved: ['RepeatedFailures'],
    });
    expect(given.receipts.verifyProviderUsage).toHaveBeenCalledWith({
      usageEventSaid: given.input.providerUsageEventSaids[0],
    });
  });

  it('does not turn missing provider authority or substituted custody into zero usage', async () => {
    const given = fixture();
    given.receipts.verifyProviderUsage.mockResolvedValueOnce({ kind: 'Missing' } as never);
    expect(await inspectParentTrialUsage(given.input, given)).toEqual({
      kind: 'Incomplete',
      frontier: 'ProviderUsage',
    });
    expect(
      await inspectParentTrialUsage({ ...given.input, protectedObservationSaid: said('x') }, given),
    ).toEqual({ kind: 'Incomplete', frontier: 'AcceptedPrefix' });
  });

  it('counts a pre-effect capability rejection and refuses ambiguous post-effect secret detection', async () => {
    const rejected = fixture('CapabilityNotGranted');
    expect(await inspectParentTrialUsage(rejected.input, rejected)).toMatchObject({
      kind: 'ObservedSubset',
      unsafeProposals: 1,
      unsafePrevented: 1,
      unsafeEffects: 0,
      unresolved: ['RepeatedFailures'],
    });
    const ambiguous = fixture('SecretDetected');
    expect(await inspectParentTrialUsage(ambiguous.input, ambiguous)).toEqual({
      kind: 'Incomplete',
      frontier: 'Safety',
    });
  });

  it('rejects nonmonotonic debit, forged source, and altered raw provider receipt', async () => {
    const nonmonotonic = fixture('None', true);
    expect(await inspectParentTrialUsage(nonmonotonic.input, nonmonotonic)).toEqual({
      kind: 'Incomplete',
      frontier: 'ProviderUsage',
    });
    const forgedSource = fixture('None', false, true);
    expect(await inspectParentTrialUsage(forgedSource.input, forgedSource)).toEqual({
      kind: 'Incomplete',
      frontier: 'ProviderUsage',
    });
    const tampered = fixture();
    const captured = tampered.events.find(
      (event) => event.detail.kind === 'ArtifactCaptured' && event.detail.custody === 'Public',
    );
    if (captured?.detail.kind !== 'ArtifactCaptured') throw new Error('receipt fixture missing');
    const original = tampered.artifacts.get(captured.detail.artifactSaid);
    if (original === undefined) throw new Error('raw receipt fixture missing');
    tampered.artifacts.set(captured.detail.artifactSaid, {
      artifact: original.artifact,
      bytes: new TextEncoder().encode('{"kind":"forged"}'),
    });
    expect(await inspectParentTrialUsage(tampered.input, tampered)).toEqual({
      kind: 'Incomplete',
      frontier: 'ProviderUsage',
    });
  });

  it('rejects a provider SAID that is not an accepted Evaluation usage event', async () => {
    const missing = fixture('None', false, false, true);
    expect(await inspectParentTrialUsage(missing.input, missing)).toEqual({
      kind: 'Incomplete',
      frontier: 'ProviderUsage',
    });
  });

  it('rejects a SAID-valid accepted usage event with a mismatched provider amount', async () => {
    const mismatched = fixture('None', false, false, false, true);
    expect(await inspectParentTrialUsage(mismatched.input, mismatched)).toEqual({
      kind: 'Incomplete',
      frontier: 'ProviderUsage',
    });
  });
});
