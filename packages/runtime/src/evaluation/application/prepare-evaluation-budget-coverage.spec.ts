import type { EvaluationExecutionBinding } from '@devrandom/domain';
import {
  prepareEvaluationEvidenceEvent,
  prepareEvaluationProviderUsageReceipt,
  prepareEvidenceArtifact,
  type EvaluationEvidenceEvent,
  type EvidenceArtifact,
} from '@devrandom/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
  prepareEvaluationBudgetCoverage,
  type EvaluationBudgetCoverageDependencies,
} from './prepare-evaluation-budget-coverage.js';

const said = (character: string): string => `E${character.repeat(43)}`;
const id = (digit: string): string =>
  `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const binding = {
  kind: 'Evaluation' as const,
  evaluationId: id('1'),
  evidenceStreamId: id('2'),
  originRunId: id('3'),
  taskId: id('4'),
  taskRevisionSaid: said('t'),
  personalAgentAid: said('a'),
  taskMandateSaid: said('m'),
  harnessRevisionSaid: said('h'),
  evaluationLeaseId: id('5'),
  phase: {
    kind: 'Trial' as const,
    manifestSaid: said('v'),
    arm: 'H1' as const,
    repetition: 1 as const,
    attempt: 1 as const,
  },
};
const reserved = {
  providerRequests: 10,
  providerInputTokens: 100,
  providerOutputTokens: 100,
  providerSpendMicroUsd: 100,
  runWallTimeSeconds: 100,
  toolProposals: 100,
  aggregateChildCommandTimeSeconds: 100,
  changedFiles: 100,
  changedWorktreeBytes: 100,
  evidencePlusArtifactsPerRunBytes: 65536,
};

function event(
  sequence: number,
  previous: EvaluationEvidenceEvent | undefined,
  detail: unknown,
  context: { readonly phase: unknown; readonly harnessRevisionSaid: string } = binding,
) {
  const prepared = prepareEvaluationEvidenceEvent({
    evaluationId: binding.evaluationId,
    streamId: binding.evidenceStreamId,
    originRunId: binding.originRunId,
    taskId: binding.taskId,
    taskRevisionSaid: binding.taskRevisionSaid,
    personalAgentAid: binding.personalAgentAid,
    taskMandateSaid: binding.taskMandateSaid,
    harnessRevisionSaid: context.harnessRevisionSaid,
    phase: context.phase,
    sequence,
    previous:
      previous === undefined ? { kind: 'Genesis' } : { kind: 'Previous', eventSaid: previous.d },
    occurredAt: '2026-09-26T05:00:00.000Z',
    detail,
  });
  if (prepared.kind !== 'Prepared') throw new Error(`fixture event: ${prepared.reason}`);
  return prepared.event;
}

function fixture(
  trialBinding: EvaluationExecutionBinding = binding,
  previousEvents: readonly EvaluationEvidenceEvent[] = [],
  provisionalSubmission: boolean | 'OtherTool' = false,
) {
  const artifacts = new Map<string, { artifact: EvidenceArtifact; bytes: Uint8Array }>();
  const raw = (value: unknown): string => {
    const bytes = Buffer.from(JSON.stringify(value));
    const prepared = prepareEvidenceArtifact(bytes, 'application/json');
    if (prepared.kind !== 'Prepared') throw new Error('fixture raw artifact rejected');
    artifacts.set(prepared.artifact.d, { artifact: prepared.artifact, bytes });
    return prepared.artifact.d;
  };
  const events: EvaluationEvidenceEvent[] = [...previousEvents];
  const append = (detail: unknown) => {
    const prepared = event(events.length, events.at(-1), detail, trialBinding);
    const previous =
      prepared.detail.kind === 'EvaluationBudgetDebited'
        ? previousEvents
            .filter(
              (item) =>
                item.detail.kind === 'EvaluationBudgetDebited' &&
                prepared.detail.kind === 'EvaluationBudgetDebited' &&
                item.detail.budget === prepared.detail.budget,
            )
            .at(-1)
        : undefined;
    const next =
      prepared.detail.kind === 'EvaluationBudgetDebited' &&
      previous?.detail.kind === 'EvaluationBudgetDebited'
        ? event(
            events.length,
            events.at(-1),
            { ...prepared.detail, consumed: prepared.detail.consumed + previous.detail.consumed },
            trialBinding,
          )
        : prepared;
    events.push(next);
    return next;
  };
  const cleanSourceSaid = raw({
    kind: 'SourceManifest',
    files: [{ path: 'src/lib.rs', bytes: 6 }],
  });
  append({ kind: 'SourceRead', sourceSaid: cleanSourceSaid, rawArtifactSaid: cleanSourceSaid });
  const message = {
    provider: 'concentrate',
    model: 'fixture',
    responseId: 'response-1',
    usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 },
  };
  const exchangeRaw = raw({ kind: 'ModelExchange', requestOrdinal: 0, message });
  const exchange = append({ kind: 'ModelExchange', rawArtifactSaid: exchangeRaw });
  const providerReport = raw({
    type: 'response.completed',
    response: {
      id: 'response-1',
      cost: { total: 0.000007 },
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    },
  });
  append({ kind: 'ArtifactCaptured', artifactSaid: providerReport, custody: 'Public' });
  const preparedProviderReceipt = prepareEvaluationProviderUsageReceipt({
    evaluationId: trialBinding.evaluationId,
    streamId: trialBinding.evidenceStreamId,
    harnessRevisionSaid: trialBinding.harnessRevisionSaid,
    phase: trialBinding.phase,
    requestOrdinal: 0,
    modelExchangeEventSaid: exchange.d,
    provider: 'concentrate',
    model: 'fixture',
    responseId: 'response-1',
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 12,
    spendMicroUsd: 7,
    providerReportArtifactSaid: providerReport,
  });
  if (preparedProviderReceipt.kind !== 'Prepared') throw new Error('provider receipt fixture');
  const providerReceipt = preparedProviderReceipt.artifact.d;
  artifacts.set(providerReceipt, {
    artifact: preparedProviderReceipt.artifact,
    bytes: preparedProviderReceipt.bytes,
  });
  append({ kind: 'ArtifactCaptured', artifactSaid: providerReceipt, custody: 'Public' });
  const usageEventSaid = append({
    kind: 'ProviderUsageVerified',
    modelExchangeEventSaid: exchange.d,
    receiptArtifactSaid: providerReceipt,
    providerReportArtifactSaid: providerReport,
    requestOrdinal: 0,
  }).d;
  for (const [budget, amount] of [
    ['providerRequests', 1],
    ['providerInputTokens', 10],
    ['providerOutputTokens', 2],
    ['providerSpendMicroUsd', 7],
  ] as const)
    append({
      kind: 'EvaluationBudgetDebited',
      budget,
      amount,
      consumed: amount,
      receiptArtifactSaid: providerReceipt,
      sourceEventSaid: exchange.d,
    });
  const toolInputSaid = raw(
    provisionalSubmission
      ? {
          kind: 'ToolProposal',
          proposal: {
            toolCallId: 'tool-1',
            proposalIndex: 0,
            input: {
              kind: provisionalSubmission === 'OtherTool' ? 'ReadFile' : 'SubmitResult',
              artifactSaids: [],
            },
          },
        }
      : { kind: 'ToolProposal', name: 'write_file' },
  );
  const proposal = append({
    kind: 'ToolProposed',
    proposalIndex: 0,
    toolCallId: 'tool-1',
    inputArtifactSaid: toolInputSaid,
  });
  const toolReceipt = raw(
    provisionalSubmission
      ? { kind: 'C2ProvisionalSubmissionAuthorized', proposalEventSaid: proposal.d }
      : {
          kind: 'EvaluationToolElapsed',
          proposalEventSaid: proposal.d,
          toolCallId: 'tool-1',
          proposalIndex: 0,
          toolName: 'write_file',
          startedMonotonicMicroseconds: 1000,
          finishedMonotonicMicroseconds: 2000,
          elapsedMilliseconds: 1,
          outcomeKind: 'Completed',
          childCommandDuration: 'NotApplicable',
        },
  );
  append({ kind: 'ArtifactCaptured', artifactSaid: toolReceipt, custody: 'Public' });
  append({
    kind: 'EvaluationBudgetDebited',
    budget: 'toolProposals',
    amount: 1,
    consumed: 1,
    receiptArtifactSaid: toolReceipt,
    sourceEventSaid: proposal.d,
  });
  const stoppedSourceSaid = raw({
    kind: 'SourceManifest',
    files: [{ path: 'src/lib.rs', bytes: 7 }],
  });
  const stoppedSource = append({
    kind: 'ArtifactCaptured',
    artifactSaid: stoppedSourceSaid,
    custody: 'Public',
  });
  const sourceReceipt = raw({
    kind: 'EvaluationSourceChanges',
    beforeSourceSaid: cleanSourceSaid,
    afterSourceSaid: stoppedSourceSaid,
    changedByteRule: 'MaxPrePostLengthPerChangedPath',
    changedFiles: 1,
    changedWorktreeBytes: 7,
    paths: ['src/lib.rs'],
  });
  append({ kind: 'ArtifactCaptured', artifactSaid: sourceReceipt, custody: 'Public' });
  append({
    kind: 'EvaluationBudgetDebited',
    budget: 'changedFiles',
    amount: 1,
    consumed: 1,
    receiptArtifactSaid: sourceReceipt,
    sourceEventSaid: stoppedSource.d,
  });
  append({
    kind: 'EvaluationBudgetDebited',
    budget: 'changedWorktreeBytes',
    amount: 7,
    consumed: 7,
    receiptArtifactSaid: sourceReceipt,
    sourceEventSaid: stoppedSource.d,
  });
  const cleanupReceipt = raw({ kind: 'Cleanup', confirmed: true });
  const cleanup = append({
    kind: 'ArtifactCaptured',
    artifactSaid: cleanupReceipt,
    custody: 'Public',
  });
  const zeroChildReceipt = raw({
    kind: 'EvaluationChildCommands',
    ...(previousEvents.length === 0 ? {} : { phase: trialBinding.phase }),
    method: 'NoNativeCommandToolEffect',
    debitedSeconds: 0,
  });
  append({ kind: 'ArtifactCaptured', artifactSaid: zeroChildReceipt, custody: 'Public' });
  append({
    kind: 'EvaluationBudgetDebited',
    budget: 'aggregateChildCommandTimeSeconds',
    amount: 0,
    consumed: 0,
    receiptArtifactSaid: zeroChildReceipt,
    sourceEventSaid: cleanup.d,
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
  const wallDebitIndex = events.length;
  append({
    kind: 'EvaluationBudgetDebited',
    budget: 'runWallTimeSeconds',
    amount: 1,
    consumed: 1,
    receiptArtifactSaid: wallReceipt,
    sourceEventSaid: cleanup.d,
  });
  append({ kind: 'TrialStopped', reason: 'Completed' });
  const open = vi.fn().mockImplementation(() =>
    Promise.resolve({
      kind: 'Acknowledged' as const,
      events,
      throughSequence: events.length - 1,
      headSaid: events.at(-1)?.d,
    }),
  );
  const openPublic = vi
    .fn()
    .mockImplementation((input: { artifactSaid: string }) =>
      Promise.resolve(
        artifacts.has(input.artifactSaid)
          ? { kind: 'Opened' as const, ...artifacts.get(input.artifactSaid) }
          : { kind: 'Missing' as const },
      ),
    );
  const verifyProviderUsage = vi.fn().mockResolvedValue({
    kind: 'Verified',
    usageEventSaid,
    responseId: 'response-1',
    inputTokens: 10,
    outputTokens: 2,
    spendMicroUsd: 7,
  });
  const dependencies: EvaluationBudgetCoverageDependencies = {
    accepted: { open },
    receipts: { openPublic, verifyProviderUsage },
  };
  const input = { binding: trialBinding, reserved, occurredAt: '2026-09-26T05:01:00.000Z' };
  const rechain = (start: number, replacement?: unknown) => {
    for (let index = start; index < events.length; index += 1) {
      const prior = events[index - 1];
      const existing = events[index];
      if (existing === undefined) throw new Error('fixture event missing');
      events[index] = event(
        index,
        prior,
        index === start && replacement !== undefined ? replacement : existing.detail,
      );
    }
  };
  return {
    events,
    artifacts,
    dependencies,
    input,
    open,
    openPublic,
    verifyProviderUsage,
    rechain,
    wallDebitIndex,
    wallReceipt,
    providerReceipt,
    usageEventSaid,
    toolReceipt,
    exchange,
    cleanup,
  };
}

describe('trusted parent Evaluation budget coverage', () => {
  it.each([50, 51, 256])(
    'covers an accepted reservation of %i calls within the supported Evaluation ceiling',
    async (providerRequests) => {
      const given = fixture();
      const result = await prepareEvaluationBudgetCoverage(
        { ...given.input, reserved: { ...given.input.reserved, providerRequests } },
        given.dependencies,
      );
      expect(result.kind).toBe('Prepared');
    },
  );
  it.each([0, 257])(
    'rejects reservation %i when below measured use or above the supported outer ceiling',
    async (providerRequests) => {
      const given = fixture();
      expect(
        await prepareEvaluationBudgetCoverage(
          { ...given.input, reserved: { ...given.input.reserved, providerRequests } },
          given.dependencies,
        ),
      ).toEqual({ kind: 'Incomplete', frontier: 'Reservation' });
    },
  );

  it('prepares coverage for an acknowledged, measured nine-dimension prefix', async () => {
    const given = fixture();
    const phase = given.input.binding.phase;
    if (phase.kind !== 'Trial') throw new Error('expected trial fixture');
    const decodedInput = {
      ...given.input,
      binding: {
        ...given.input.binding,
        phase: {
          attempt: phase.attempt,
          repetition: phase.repetition,
          arm: phase.arm,
          manifestSaid: phase.manifestSaid,
          kind: phase.kind,
        },
      },
    };
    const result = await prepareEvaluationBudgetCoverage(decodedInput, given.dependencies);
    expect(result).toMatchObject({
      kind: 'Prepared',
      event: {
        detail: {
          kind: 'EvaluationBudgetCovered',
          throughSequence: given.events.length - 1,
          throughHeadSaid: given.events.at(-1)?.d,
          totals: {
            providerRequests: 1,
            providerInputTokens: 10,
            providerOutputTokens: 2,
            providerSpendMicroUsd: 7,
            runWallTimeSeconds: 1,
            toolProposals: 1,
            aggregateChildCommandTimeSeconds: 0,
            changedFiles: 1,
            changedWorktreeBytes: 7,
          },
          providerUsageEventSaids: [given.usageEventSaid],
        },
      },
    });
    expect(given.verifyProviderUsage).toHaveBeenCalledWith({
      usageEventSaid: given.usageEventSaid,
    });
  });

  it('fails closed for missing dimensions, nonmonotonic cursors, and chain gaps', async () => {
    const missing = fixture();
    missing.events.splice(missing.wallDebitIndex, 1);
    missing.rechain(missing.wallDebitIndex);
    expect(
      await prepareEvaluationBudgetCoverage(missing.input, missing.dependencies),
    ).toMatchObject({
      kind: 'Incomplete',
      frontier: 'MissingDimension',
    });
    const cursor = fixture();
    const debit = cursor.events[cursor.wallDebitIndex];
    if (debit?.detail.kind !== 'EvaluationBudgetDebited') throw new Error('fixture debit missing');
    cursor.rechain(cursor.wallDebitIndex, { ...debit.detail, consumed: 2 });
    expect(await prepareEvaluationBudgetCoverage(cursor.input, cursor.dependencies)).toMatchObject({
      kind: 'Incomplete',
      frontier: 'DebitSequence',
    });
    const gap = fixture();
    gap.events.splice(2, 1);
    expect(await prepareEvaluationBudgetCoverage(gap.input, gap.dependencies)).toMatchObject({
      kind: 'Incomplete',
      frontier: 'EventChain',
    });
    const unfinished = fixture();
    const nextPhase = {
      kind: 'Trial' as const,
      manifestSaid: said('v'),
      arm: 'C1' as const,
      repetition: 1 as const,
      attempt: 1 as const,
    };
    const next = event(
      unfinished.events.length,
      unfinished.events.at(-1),
      {
        kind: 'ToolProposed',
        proposalIndex: 0,
        toolCallId: 'next-tool',
        inputArtifactSaid: said('z'),
      },
      { phase: nextPhase, harnessRevisionSaid: said('j') },
    );
    unfinished.events.push(next);
    expect(
      await prepareEvaluationBudgetCoverage(
        {
          ...unfinished.input,
          binding: { ...binding, harnessRevisionSaid: said('j'), phase: nextPhase },
        },
        unfinished.dependencies,
      ),
    ).toMatchObject({ kind: 'Incomplete', frontier: 'MissingDimension' });
  });

  it('rejects forged source and receipt reuse across measurement kinds', async () => {
    const forged = fixture();
    const debit = forged.events[forged.wallDebitIndex];
    if (debit?.detail.kind !== 'EvaluationBudgetDebited') throw new Error('fixture debit missing');
    forged.rechain(forged.wallDebitIndex, { ...debit.detail, sourceEventSaid: forged.exchange.d });
    expect(await prepareEvaluationBudgetCoverage(forged.input, forged.dependencies)).toMatchObject({
      kind: 'Incomplete',
      frontier: 'ReceiptAuthority',
    });
    const duplicate = fixture();
    const wall = duplicate.events[duplicate.wallDebitIndex];
    if (wall?.detail.kind !== 'EvaluationBudgetDebited') throw new Error('fixture debit missing');
    duplicate.rechain(duplicate.wallDebitIndex, {
      ...wall.detail,
      receiptArtifactSaid: duplicate.providerReceipt,
    });
    expect(
      await prepareEvaluationBudgetCoverage(duplicate.input, duplicate.dependencies),
    ).toMatchObject({
      kind: 'Incomplete',
      frontier: 'ReceiptAuthority',
    });
    const tampered = fixture();
    const stored = tampered.artifacts.get(tampered.wallReceipt);
    if (stored === undefined) throw new Error('fixture receipt missing');
    tampered.artifacts.set(tampered.wallReceipt, {
      artifact: stored.artifact,
      bytes: Buffer.from('{"kind":"EvaluationWallElapsed","debitedSeconds":0}'),
    });
    expect(
      await prepareEvaluationBudgetCoverage(tampered.input, tampered.dependencies),
    ).toMatchObject({ kind: 'Incomplete', frontier: 'ReceiptCustody' });
  });

  it('rejects missing provider authority and a mismatched hosted through-head', async () => {
    const missingUsage = fixture();
    missingUsage.verifyProviderUsage.mockResolvedValue({ kind: 'Missing' });
    expect(
      await prepareEvaluationBudgetCoverage(missingUsage.input, missingUsage.dependencies),
    ).toMatchObject({
      kind: 'Incomplete',
      frontier: 'ProviderUsage',
    });
    const wrongHead = fixture();
    wrongHead.open.mockResolvedValue({
      kind: 'Acknowledged',
      events: wrongHead.events,
      throughSequence: wrongHead.events.length - 1,
      headSaid: said('z'),
    });
    expect(
      await prepareEvaluationBudgetCoverage(wrongHead.input, wrongHead.dependencies),
    ).toMatchObject({
      kind: 'Incomplete',
      frontier: 'ThroughHead',
    });
  });
});

it('binds diagnosis elapsed receipts to the authenticated Research usage event and recomputes duration', async () => {
  const given = fixture();
  const usage = given.events.find((item) => item.detail.kind === 'ProviderUsageVerified');
  if (usage === undefined) throw new Error('fixture');
  const context = {
    harnessRevisionSaid: binding.harnessRevisionSaid,
    phase: { kind: 'Research' as const, policySaid: said('p'), role: 'DiagnosticRefiner' as const },
  };
  const source = event(0, undefined, usage.detail, context);
  const receipt = {
    version: 1,
    kind: 'EvaluationResearchElapsed',
    method: 'ParentMonotonicResearch',
    evaluationId: binding.evaluationId,
    streamId: binding.evidenceStreamId,
    harnessRevisionSaid: context.harnessRevisionSaid,
    phase: context.phase,
    usageEventSaid: source.d,
    startedMonotonicMicroseconds: 1000,
    finishedMonotonicMicroseconds: 2000,
    elapsedMilliseconds: 1,
    debitedSeconds: 1,
  };
  const check = async (value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(value));
    const prepared = prepareEvidenceArtifact(bytes, 'application/json');
    if (prepared.kind !== 'Prepared') throw new Error('fixture');
    given.artifacts.set(prepared.artifact.d, { artifact: prepared.artifact, bytes });
    const captured = event(
      1,
      source,
      { kind: 'ArtifactCaptured', artifactSaid: prepared.artifact.d, custody: 'Public' },
      context,
    );
    const debit = event(
      2,
      captured,
      {
        kind: 'EvaluationBudgetDebited',
        budget: 'runWallTimeSeconds',
        amount: 1,
        consumed: 1,
        receiptArtifactSaid: prepared.artifact.d,
        sourceEventSaid: source.d,
      },
      context,
    );
    given.open.mockResolvedValue({
      kind: 'Acknowledged',
      events: [source, captured, debit],
      throughSequence: 2,
      headSaid: debit.d,
    });
    return prepareEvaluationBudgetCoverage(
      { ...given.input, binding: { ...binding, ...context } },
      given.dependencies,
    );
  };
  expect(await check(receipt)).toMatchObject({ kind: 'Incomplete', frontier: 'MissingDimension' });
  expect(await check({ ...receipt, elapsedMilliseconds: 0 })).toMatchObject({
    kind: 'Incomplete',
    frontier: 'ReceiptAuthority',
  });
  expect(await check({ ...receipt, usageEventSaid: said('z') })).toMatchObject({
    kind: 'Incomplete',
    frontier: 'ReceiptAuthority',
  });
  expect(await check({ ...receipt, phase: binding.phase })).toMatchObject({
    kind: 'Incomplete',
    frontier: 'ReceiptAuthority',
  });
});

it('keeps zero native-command evidence scoped to its own phase', async () => {
  const given = fixture();
  const context = {
    harnessRevisionSaid: binding.harnessRevisionSaid,
    phase: { kind: 'Research' as const, policySaid: said('p'), role: 'CandidateWorker' as const },
  };
  const append = (detail: unknown) => {
    const next = event(given.events.length, given.events.at(-1), detail, context);
    given.events.push(next);
    return next;
  };
  const proposal = append({
    kind: 'ToolProposed',
    proposalIndex: 0,
    toolCallId: 'research-test',
    inputArtifactSaid: said('i'),
  });
  const bytes = Buffer.from(
    JSON.stringify({
      kind: 'EvaluationToolElapsed',
      proposalEventSaid: proposal.d,
      toolCallId: 'research-test',
      proposalIndex: 0,
      toolName: 'run_tests',
      outcomeKind: 'Completed',
      childCommandDuration: 'GatewayRoundTripUpperBound',
      startedMonotonicMicroseconds: 1,
      finishedMonotonicMicroseconds: 1001,
      elapsedMilliseconds: 1,
      childCommandDebitedSeconds: 1,
    }),
  );
  const raw = prepareEvidenceArtifact(bytes, 'application/json');
  if (raw.kind !== 'Prepared') throw new Error('fixture');
  given.artifacts.set(raw.artifact.d, { artifact: raw.artifact, bytes });
  append({ kind: 'ArtifactCaptured', artifactSaid: raw.artifact.d, custody: 'Public' });
  append({
    kind: 'EvaluationBudgetDebited',
    budget: 'toolProposals',
    amount: 1,
    consumed: 2,
    receiptArtifactSaid: raw.artifact.d,
    sourceEventSaid: proposal.d,
  });
  append({
    kind: 'EvaluationBudgetDebited',
    budget: 'aggregateChildCommandTimeSeconds',
    amount: 1,
    consumed: 1,
    receiptArtifactSaid: raw.artifact.d,
    sourceEventSaid: proposal.d,
  });
  expect(
    await prepareEvaluationBudgetCoverage(
      { ...given.input, binding: { ...binding, ...context } },
      given.dependencies,
    ),
  ).toMatchObject({ kind: 'Prepared' });
});

for (const malformed of [false, true]) {
  it(`independently checks research preparation interval arithmetic (malformed=${String(malformed)})`, async () => {
    const given = fixture();
    const context = {
      harnessRevisionSaid: binding.harnessRevisionSaid,
      phase: { kind: 'Research' as const, policySaid: said('p'), role: 'CandidateWorker' as const },
    };
    const append = (detail: unknown) => {
      const next = event(given.events.length, given.events.at(-1), detail, context);
      given.events.push(next);
      return next;
    };
    const raw = (value: unknown) => {
      const bytes = Buffer.from(JSON.stringify(value));
      const prepared = prepareEvidenceArtifact(bytes, 'application/json');
      if (prepared.kind !== 'Prepared') throw new Error('fixture');
      given.artifacts.set(prepared.artifact.d, { artifact: prepared.artifact, bytes });
      append({ kind: 'ArtifactCaptured', artifactSaid: prepared.artifact.d, custody: 'Public' });
      return prepared.artifact.d;
    };
    raw({
      kind: 'ResearchPreparationOpened',
      evaluationId: binding.evaluationId,
      startedMonotonicMicroseconds: 1000,
    });
    const opened = given.events.at(-1);
    if (opened === undefined) throw new Error('fixture');
    raw({ kind: 'ResearchPreparation' });
    const source = given.events.at(-1);
    if (source === undefined) throw new Error('fixture');
    const receipt = raw({
      kind: 'EvaluationResearchPreparationElapsed',
      method: 'ParentMonotonicPreparationLessInferenceIntervals',
      fromSequence: opened.sequence,
      openedEventSaid: opened.d,
      throughSequence: source.sequence,
      throughHeadSaid: source.d,
      inferenceWallReceiptSaids: [],
      startedMonotonicMicroseconds: 1000,
      finishedMonotonicMicroseconds: 3000,
      elapsedMilliseconds: malformed ? 1 : 2,
      debitedSeconds: 1,
    });
    append({
      kind: 'EvaluationBudgetDebited',
      budget: 'runWallTimeSeconds',
      amount: 1,
      consumed: 2,
      receiptArtifactSaid: receipt,
      sourceEventSaid: source.d,
    });
    expect(
      await prepareEvaluationBudgetCoverage(
        { ...given.input, binding: { ...binding, ...context } },
        given.dependencies,
      ),
    ).toMatchObject(
      malformed ? { kind: 'Incomplete', frontier: 'ReceiptAuthority' } : { kind: 'Prepared' },
    );
  });
  it(`replays native research cleanup instead of trusting elapsed claims (malformed=${String(malformed)})`, async () => {
    const given = fixture();
    const context = {
      harnessRevisionSaid: binding.harnessRevisionSaid,
      phase: { kind: 'Research' as const, policySaid: said('p'), role: 'CandidateWorker' as const },
    };
    const append = (detail: unknown) => {
      const next = event(given.events.length, given.events.at(-1), detail, context);
      given.events.push(next);
      return next;
    };
    const raw = (value: unknown) => {
      const bytes = Buffer.from(JSON.stringify(value));
      const prepared = prepareEvidenceArtifact(bytes, 'application/json');
      if (prepared.kind !== 'Prepared') throw new Error('fixture');
      given.artifacts.set(prepared.artifact.d, { artifact: prepared.artifact, bytes });
      append({ kind: 'ArtifactCaptured', artifactSaid: prepared.artifact.d, custody: 'Public' });
      return prepared.artifact.d;
    };
    const buildReceiptSaid = raw({ exitCode: 0 });
    const buildCleanupReceiptSaid = raw({ buildReceiptSaid, stopped: true });
    const rawObservationSaid = raw({ exitCode: 0, stdout: 'actual observation' });
    const cleanupReceiptSaid = raw({ rawObservationSaid, stopped: !malformed });
    const replayArtifactSaid = raw({
      kind: 'SuccessorPublicReplay',
      buildReceiptSaid,
      buildCleanupReceiptSaid,
      observations: [{ rawObservationSaid, cleanupReceiptSaid }],
    });
    const source = given.events.at(-1);
    if (source === undefined) throw new Error('fixture');
    const receipt = raw({
      kind: 'EvaluationResearchNativeElapsed',
      method: 'ParentReplayRoundTripUpperBound',
      replayArtifactSaid,
      startedMonotonicMicroseconds: 1000,
      finishedMonotonicMicroseconds: 3000,
      elapsedMilliseconds: 2,
      childCommandDebitedSeconds: 1,
    });
    append({
      kind: 'EvaluationBudgetDebited',
      budget: 'aggregateChildCommandTimeSeconds',
      amount: 1,
      consumed: 1,
      receiptArtifactSaid: receipt,
      sourceEventSaid: source.d,
    });
    expect(
      await prepareEvaluationBudgetCoverage(
        { ...given.input, binding: { ...binding, ...context } },
        given.dependencies,
      ),
    ).toMatchObject(
      malformed ? { kind: 'Incomplete', frontier: 'ReceiptAuthority' } : { kind: 'Prepared' },
    );
  });
}

for (const operation of ['Build', 'PublicObservation', 'ProtectedObservation'] as const) {
  for (const stopped of [true, false])
    it(`independently accounts ${operation} finalization native time with stopped=${String(stopped)}`, async () => {
      const given = fixture();
      if (!stopped) given.events.pop();
      const append = (detail: unknown) => {
        const next = event(given.events.length, given.events.at(-1), detail);
        given.events.push(next);
        return next;
      };
      const raw = (value: unknown) => {
        const bytes = Buffer.from(JSON.stringify(value));
        const prepared = prepareEvidenceArtifact(bytes, 'application/json');
        if (prepared.kind !== 'Prepared') throw new Error('fixture');
        given.artifacts.set(prepared.artifact.d, { artifact: prepared.artifact, bytes });
        append({ kind: 'ArtifactCaptured', artifactSaid: prepared.artifact.d, custody: 'Public' });
        return prepared.artifact.d;
      };
      const rawReceiptSaid =
        operation === 'ProtectedObservation' ? said('x') : raw({ exitCode: 1 });
      const cleanupReceiptSaid = raw(
        operation === 'Build'
          ? { buildReceiptSaid: rawReceiptSaid, stopped: true }
          : { rawObservationSaid: rawReceiptSaid, stopped: true },
      );
      const source = given.events.at(-1);
      if (source === undefined) throw new Error('fixture');
      const receipt = raw({
        kind: 'EvaluationFinalizationNativeElapsed',
        method: 'ParentNativeRoundTripUpperBound',
        operation,
        rawReceiptSaid,
        cleanupReceiptSaid,
        startedMonotonicMicroseconds: 1000,
        finishedMonotonicMicroseconds: 3000,
        elapsedMilliseconds: 2,
        childCommandDebitedSeconds: 1,
      });
      append({
        kind: 'EvaluationBudgetDebited',
        budget: 'aggregateChildCommandTimeSeconds',
        amount: 1,
        consumed: 1,
        receiptArtifactSaid: receipt,
        sourceEventSaid: source.d,
      });
      expect(await prepareEvaluationBudgetCoverage(given.input, given.dependencies)).toMatchObject(
        stopped ? { kind: 'Prepared' } : { kind: 'Incomplete', frontier: 'ReceiptAuthority' },
      );
      if (stopped) {
        raw({
          kind: 'ParentAuditOperation',
          operation: {
            kind: 'ProtectedGrading',
            buildCleanupReceiptSaid: cleanupReceiptSaid,
            publicCleanupReceiptSaids: [said('u')],
            cleanupReceiptSaid: said('v'),
          },
        });
        expect(
          await prepareEvaluationBudgetCoverage(given.input, given.dependencies),
        ).toMatchObject({ kind: 'Incomplete', frontier: 'MissingDimension' });
      }
    });
}

it('charges equal source measurements separately for two independently completed trial phases', async () => {
  const first = fixture();
  const second = fixture({ ...binding, phase: { ...binding.phase, repetition: 2 } }, first.events);
  for (const [said, raw] of first.artifacts) second.artifacts.set(said, raw);
  second.verifyProviderUsage.mockImplementation((input: { usageEventSaid: string }) =>
    Promise.resolve({
      kind: 'Verified',
      usageEventSaid: input.usageEventSaid,
      responseId: 'response-1',
      inputTokens: 10,
      outputTokens: 2,
      spendMicroUsd: 7,
    }),
  );
  expect(await prepareEvaluationBudgetCoverage(second.input, second.dependencies)).toMatchObject({
    kind: 'Prepared',
    event: {
      detail: { totals: { changedFiles: 2, changedWorktreeBytes: 14, providerRequests: 2 } },
    },
  });
});

it('rejects consuming the same source receipt against a second source event within one trial', async () => {
  const given = fixture();
  const debit = given.events.find(
    (item) =>
      item.detail.kind === 'EvaluationBudgetDebited' && item.detail.budget === 'changedFiles',
  );
  if (debit?.detail.kind !== 'EvaluationBudgetDebited') throw new Error('source debit fixture');
  const sourceEventSaid = debit.detail.sourceEventSaid;
  const source = given.events.find((item) => item.d === sourceEventSaid);
  if (source === undefined) throw new Error('source fixture');
  const repeated = event(given.events.length, given.events.at(-1), source.detail);
  given.events.push(repeated);
  given.events.push(
    event(given.events.length, repeated, {
      ...debit.detail,
      sourceEventSaid: repeated.d,
      consumed: debit.detail.consumed + debit.detail.amount,
    }),
  );
  expect(await prepareEvaluationBudgetCoverage(given.input, given.dependencies)).toEqual({
    kind: 'Incomplete',
    frontier: 'ReceiptAuthority',
  });
});

for (const arm of ['C2', 'H1'] as const) {
  it(`counts the actual C2 provisional submit proposal only in its bound arm (${arm})`, async () => {
    const given = fixture({ ...binding, phase: { ...binding.phase, arm } }, [], true);
    expect(await prepareEvaluationBudgetCoverage(given.input, given.dependencies)).toMatchObject(
      arm === 'C2'
        ? { kind: 'Prepared', event: { detail: { totals: { toolProposals: 1 } } } }
        : { kind: 'Incomplete', frontier: 'ReceiptAuthority' },
    );
  });
}

it('does not use a C2 provisional submission receipt to account for another tool', async () => {
  const given = fixture({ ...binding, phase: { ...binding.phase, arm: 'C2' } }, [], 'OtherTool');
  expect(await prepareEvaluationBudgetCoverage(given.input, given.dependencies)).toMatchObject({
    kind: 'Incomplete',
    frontier: 'ReceiptAuthority',
  });
});

it('rejects a second debit of the same C2 provisional proposal', async () => {
  const context = { ...binding, phase: { ...binding.phase, arm: 'C2' as const } };
  const given = fixture(context, [], true);
  const debit = given.events.find(
    (item) =>
      item.detail.kind === 'EvaluationBudgetDebited' && item.detail.budget === 'toolProposals',
  );
  if (debit?.detail.kind !== 'EvaluationBudgetDebited') throw new Error('proposal debit fixture');
  given.events.push(
    event(given.events.length, given.events.at(-1), { ...debit.detail, consumed: 2 }, context),
  );
  expect(await prepareEvaluationBudgetCoverage(given.input, given.dependencies)).toMatchObject({
    kind: 'Incomplete',
    frontier: 'ReceiptAuthority',
  });
});
