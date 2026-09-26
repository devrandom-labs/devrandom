import { isDeepStrictEqual } from 'node:util';

import type { EvaluationExecutionBinding, TrialUsage, HarnessCommand } from '@devrandom/domain';
import { decodeEvidenceArtifact, type EvaluationEvidenceEvent } from '@devrandom/protocol';

import type { EvaluationMeasurementReceipts } from './prepare-evaluation-budget-coverage.js';
import {
  verifyProtectedTrialPrefix,
  type ProtectedTrialAcceptedPrefix,
} from './verify-protected-trial-prefix.js';

import { decodeEvaluationRepositoryEffect, replayTrialProgress } from './replay-trial-progress.js';
import type { VerifiedTrialUsage } from './prepare-measured-trial-observation.js';
type Frontier =
  | 'AcceptedPrefix'
  | 'ReceiptCustody'
  | 'ProviderUsage'
  | 'WallTime'
  | 'Safety'
  | 'RepeatedFailures';

export interface ParentTrialUsageFactsDependencies {
  readonly commands?: readonly HarnessCommand[];
  readonly accepted: {
    openPrefix(input: {
      readonly binding: EvaluationExecutionBinding;
      readonly throughSequence: number;
      readonly headSaid: string;
    }): Promise<ProtectedTrialAcceptedPrefix | { readonly kind: 'Missing' | 'Unavailable' }>;
  };
  readonly receipts: EvaluationMeasurementReceipts;
}

export type ParentTrialUsageInspection =
  | ({
      readonly kind: 'Verified';
    } & TrialUsage)
  | { readonly kind: 'Incomplete'; readonly frontier: Frontier };

type Input = {
  readonly binding: EvaluationExecutionBinding;
  readonly trialEvidenceHeadSaid: string;
  readonly protectedObservationSaid: string;
  readonly custodyEvidenceHeadSaid: string;
  readonly custodyEvidenceSequence: number;
  readonly providerUsageEventSaids: readonly string[];
};

interface Raw {
  readonly version?: unknown;
  readonly kind?: unknown;
  readonly evaluationId?: unknown;
  readonly streamId?: unknown;
  readonly harnessRevisionSaid?: unknown;
  readonly phase?: unknown;
  readonly providerReportArtifactSaid?: unknown;
  readonly message?: unknown;
  readonly usage?: unknown;
  readonly content?: unknown;
  readonly type?: unknown;
  readonly id?: unknown;
  readonly requestOrdinal?: unknown;
  readonly usageEventSaid?: unknown;
  readonly modelExchangeEventSaid?: unknown;
  readonly provider?: unknown;
  readonly model?: unknown;
  readonly responseId?: unknown;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly cacheRead?: unknown;
  readonly cacheWrite?: unknown;
  readonly totalTokens?: unknown;
  readonly inputTokens?: unknown;
  readonly outputTokens?: unknown;
  readonly cacheReadTokens?: unknown;
  readonly cacheWriteTokens?: unknown;
  readonly spendMicroUsd?: unknown;
  readonly startedMonotonicMicroseconds?: unknown;
  readonly finishedMonotonicMicroseconds?: unknown;
  readonly elapsedMilliseconds?: unknown;
  readonly method?: unknown;
  readonly debitedSeconds?: unknown;
  readonly cleanupEventSaid?: unknown;
  readonly confirmed?: unknown;
  readonly outcome?: unknown;
  readonly proposal?: unknown;
  readonly proposalIndex?: unknown;
  readonly toolCallId?: unknown;
  readonly reason?: unknown;
  readonly outputArtifactSaids?: unknown;
  readonly decision?: unknown;
  readonly manifestSaid?: unknown;
  readonly capturedSourceSaid?: unknown;
  readonly proposalEventSaid?: unknown;
  readonly successorRevisionSaid?: unknown;
  readonly buildDisposition?: unknown;
  readonly observations?: unknown;
  readonly verdict?: unknown;
}
type DebitEvent = EvaluationEvidenceEvent & {
  readonly detail: Extract<EvaluationEvidenceEvent['detail'], { kind: 'EvaluationBudgetDebited' }>;
};
const providerBudgets = [
  'providerRequests',
  'providerInputTokens',
  'providerOutputTokens',
  'providerSpendMicroUsd',
] as const;

function record(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function debitEvent(event: EvaluationEvidenceEvent): event is DebitEvent {
  return event.detail.kind === 'EvaluationBudgetDebited';
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function add(left: number, right: number): number | undefined {
  const sum = left + right;
  return Number.isSafeInteger(sum) ? sum : undefined;
}

function said(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z][A-Za-z0-9_-]{43}$/u.test(value);
}

function sameTrial(event: EvaluationEvidenceEvent, binding: EvaluationExecutionBinding): boolean {
  return (
    event.harnessRevisionSaid === binding.harnessRevisionSaid &&
    JSON.stringify(event.phase) === JSON.stringify(binding.phase)
  );
}

/** Parent-only replay of exact accepted native effects, provider receipts, and progress. */
export async function inspectParentTrialUsage(
  input: Input,
  dependencies: ParentTrialUsageFactsDependencies,
): Promise<ParentTrialUsageInspection> {
  let prefix: Awaited<ReturnType<ParentTrialUsageFactsDependencies['accepted']['openPrefix']>>;
  try {
    prefix = await dependencies.accepted.openPrefix({
      binding: input.binding,
      throughSequence: input.custodyEvidenceSequence,
      headSaid: input.custodyEvidenceHeadSaid,
    });
  } catch {
    return { kind: 'Incomplete', frontier: 'AcceptedPrefix' };
  }
  if (prefix.kind !== 'Acknowledged') return { kind: 'Incomplete', frontier: 'AcceptedPrefix' };
  const verified = verifyProtectedTrialPrefix(input, prefix);
  if (verified.kind !== 'Verified') return { kind: 'Incomplete', frontier: 'AcceptedPrefix' };
  const firstTrial = verified.events.findIndex((event) => sameTrial(event, input.binding));
  if (
    firstTrial < 0 ||
    verified.events
      .slice(firstTrial, verified.stoppedSequence + 1)
      .some((event) => !sameTrial(event, input.binding))
  )
    return { kind: 'Incomplete', frontier: 'AcceptedPrefix' };
  const trial = verified.events.slice(firstTrial, verified.stoppedSequence + 1);
  const rawCache = new Map<string, Raw>();
  const readRaw = async (artifactSaid: string): Promise<Raw | undefined> => {
    const cached = rawCache.get(artifactSaid);
    if (cached !== undefined) return cached;
    const opened = await dependencies.receipts.openPublic({
      evaluationId: input.binding.evaluationId,
      artifactSaid,
    });
    if (opened.kind !== 'Opened') return undefined;
    const bytes = Uint8Array.from(opened.bytes);
    if (
      opened.artifact.d !== artifactSaid ||
      opened.artifact.mediaType !== 'application/json' ||
      decodeEvidenceArtifact(opened.artifact, bytes).kind !== 'Accepted'
    )
      return undefined;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const parsed: unknown = JSON.parse(text);
    if (!record(parsed) || JSON.stringify(parsed) !== text) return undefined;
    rawCache.set(artifactSaid, parsed);
    return parsed;
  };
  const captured = new Map(
    trial
      .filter(
        (event) => event.detail.kind === 'ArtifactCaptured' && event.detail.custody === 'Public',
      )
      .map((event) => [
        (event.detail as Extract<EvaluationEvidenceEvent['detail'], { kind: 'ArtifactCaptured' }>)
          .artifactSaid,
        event,
      ]),
  );
  const debits = trial.filter(debitEvent);
  const cumulative = new Map<string, number>();
  for (const event of verified.events.slice(0, verified.stoppedSequence + 1)) {
    if (event.detail.kind !== 'EvaluationBudgetDebited') continue;
    const next = add(cumulative.get(event.detail.budget) ?? 0, event.detail.amount);
    if (next === undefined || next !== event.detail.consumed)
      return { kind: 'Incomplete', frontier: 'ProviderUsage' };
    cumulative.set(event.detail.budget, next);
  }
  const models = trial.filter((event) => event.detail.kind === 'ModelExchange');
  const usageEvents = trial.filter((event) => event.detail.kind === 'ProviderUsageVerified');
  if (
    models.length === 0 ||
    usageEvents.length !== models.length ||
    models.length !== input.providerUsageEventSaids.length ||
    new Set(input.providerUsageEventSaids).size !== input.providerUsageEventSaids.length
  )
    return { kind: 'Incomplete', frontier: 'ProviderUsage' };
  const modelSaids = new Set(models.map((event) => event.d));
  if (
    debits.some(
      (event) =>
        providerBudgets.some((budget) => budget === event.detail.budget) &&
        !modelSaids.has(event.detail.sourceEventSaid ?? ''),
    )
  )
    return { kind: 'Incomplete', frontier: 'ProviderUsage' };
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let spendMicroUsd = 0;
  const modelToolCalls: string[] = [];
  const modelToolSources: number[] = [];
  for (const [ordinal, event] of models.entries()) {
    if (event.detail.kind !== 'ModelExchange')
      return { kind: 'Incomplete', frontier: 'ProviderUsage' };
    let exchange: Raw | undefined;
    try {
      exchange = await readRaw(event.detail.rawArtifactSaid);
    } catch {
      return { kind: 'Incomplete', frontier: 'ReceiptCustody' };
    }
    const usageEventSaid = input.providerUsageEventSaids[ordinal];
    if (!said(usageEventSaid)) return { kind: 'Incomplete', frontier: 'ProviderUsage' };
    const usageEvent = usageEvents[ordinal];
    const message = exchange?.message;
    const usage = record(message) ? message.usage : undefined;
    if (
      exchange?.kind !== 'ModelExchange' ||
      usageEvent?.d !== usageEventSaid ||
      usageEvent.detail.kind !== 'ProviderUsageVerified' ||
      usageEvent.detail.modelExchangeEventSaid !== event.d ||
      usageEvent.detail.requestOrdinal !== ordinal ||
      usageEvent.sequence <= event.sequence ||
      exchange.requestOrdinal !== ordinal ||
      !record(message) ||
      typeof message.provider !== 'string' ||
      message.provider.length === 0 ||
      typeof message.model !== 'string' ||
      message.model.length === 0 ||
      typeof message.responseId !== 'string' ||
      message.responseId.length === 0 ||
      !record(usage) ||
      !count(usage.input) ||
      !count(usage.output) ||
      !count(usage.cacheRead) ||
      !count(usage.cacheWrite) ||
      !count(usage.totalTokens) ||
      usage.totalTokens !== usage.input + usage.output + usage.cacheRead + usage.cacheWrite ||
      !Array.isArray(message.content)
    )
      return { kind: 'Incomplete', frontier: 'ProviderUsage' };
    for (const part of message.content) {
      if (!record(part) || part.type !== 'toolCall') continue;
      if (typeof part.id !== 'string' || part.id.length === 0)
        return { kind: 'Incomplete', frontier: 'Safety' };
      modelToolCalls.push(part.id);
      modelToolSources.push(event.sequence);
    }
    const sourceDebits = debits.filter(
      (debit) =>
        debit.detail.sourceEventSaid === event.d &&
        providerBudgets.some((budget) => budget === debit.detail.budget),
    );
    if (
      sourceDebits.length !== 4 ||
      new Set(sourceDebits.map((debit) => debit.detail.budget)).size !== 4 ||
      sourceDebits.some((debit) => debit.sequence <= event.sequence) ||
      sourceDebits.some(
        (debit) => debit.detail.receiptArtifactSaid !== sourceDebits[0]?.detail.receiptArtifactSaid,
      )
    )
      return { kind: 'Incomplete', frontier: 'ProviderUsage' };
    const receiptSaid = sourceDebits[0]?.detail.receiptArtifactSaid;
    const receiptCapture = receiptSaid === undefined ? undefined : captured.get(receiptSaid);
    if (
      receiptSaid === undefined ||
      receiptCapture === undefined ||
      receiptCapture.sequence <= event.sequence ||
      receiptCapture.sequence >= usageEvent.sequence ||
      receiptCapture.sequence >= Math.min(...sourceDebits.map((debit) => debit.sequence))
    )
      return { kind: 'Incomplete', frontier: 'ReceiptCustody' };
    let receipt: Raw | undefined;
    try {
      receipt = await readRaw(receiptSaid);
    } catch {
      return { kind: 'Incomplete', frontier: 'ReceiptCustody' };
    }
    const inputWithCache = usage.input + usage.cacheRead + usage.cacheWrite;
    if (
      receipt?.version !== 1 ||
      receipt.kind !== 'EvaluationProviderUsageReceipt' ||
      receipt.evaluationId !== input.binding.evaluationId ||
      receipt.streamId !== input.binding.evidenceStreamId ||
      receipt.harnessRevisionSaid !== input.binding.harnessRevisionSaid ||
      !isDeepStrictEqual(receipt.phase, input.binding.phase) ||
      receipt.modelExchangeEventSaid !== event.d ||
      receipt.requestOrdinal !== ordinal ||
      usageEvent.detail.receiptArtifactSaid !== receiptSaid ||
      usageEvent.detail.providerReportArtifactSaid !== receipt.providerReportArtifactSaid ||
      !said(receipt.providerReportArtifactSaid) ||
      captured.get(receipt.providerReportArtifactSaid)?.sequence === undefined ||
      (captured.get(receipt.providerReportArtifactSaid)?.sequence ?? Number.POSITIVE_INFINITY) >=
        usageEvent.sequence ||
      receipt.provider !== message.provider ||
      receipt.model !== message.model ||
      receipt.responseId !== message.responseId ||
      receipt.inputTokens !== inputWithCache ||
      receipt.outputTokens !== usage.output ||
      receipt.cacheReadTokens !== usage.cacheRead ||
      receipt.cacheWriteTokens !== usage.cacheWrite ||
      receipt.totalTokens !== usage.totalTokens ||
      !count(receipt.spendMicroUsd) ||
      sourceDebits.some((debit) => {
        const expected =
          debit.detail.budget === 'providerRequests'
            ? 1
            : debit.detail.budget === 'providerInputTokens'
              ? inputWithCache
              : debit.detail.budget === 'providerOutputTokens'
                ? usage.output
                : receipt.spendMicroUsd;
        return debit.detail.amount !== expected;
      })
    )
      return { kind: 'Incomplete', frontier: 'ProviderUsage' };
    let provider: Awaited<ReturnType<EvaluationMeasurementReceipts['verifyProviderUsage']>>;
    try {
      provider = await dependencies.receipts.verifyProviderUsage({ usageEventSaid });
    } catch {
      return { kind: 'Incomplete', frontier: 'ProviderUsage' };
    }
    if (
      provider.kind !== 'Verified' ||
      provider.usageEventSaid !== usageEventSaid ||
      provider.responseId !== receipt.responseId ||
      provider.inputTokens !== receipt.inputTokens ||
      provider.outputTokens !== receipt.outputTokens ||
      provider.spendMicroUsd !== receipt.spendMicroUsd
    )
      return { kind: 'Incomplete', frontier: 'ProviderUsage' };
    const nextInput = add(inputTokens, usage.input);
    const nextOutput = add(outputTokens, usage.output);
    const nextRead = add(cacheReadTokens, usage.cacheRead);
    const nextWrite = add(cacheWriteTokens, usage.cacheWrite);
    const nextSpend = add(spendMicroUsd, receipt.spendMicroUsd);
    if (
      nextInput === undefined ||
      nextOutput === undefined ||
      nextRead === undefined ||
      nextWrite === undefined ||
      nextSpend === undefined
    )
      return { kind: 'Incomplete', frontier: 'ProviderUsage' };
    inputTokens = nextInput;
    outputTokens = nextOutput;
    cacheReadTokens = nextRead;
    cacheWriteTokens = nextWrite;
    spendMicroUsd = nextSpend;
  }
  const wallDebits = debits.filter((event) => event.detail.budget === 'runWallTimeSeconds');
  if (wallDebits.length !== 1 || wallDebits[0] === undefined)
    return { kind: 'Incomplete', frontier: 'WallTime' };
  const wallDebit = wallDebits[0];
  const wallCapture = captured.get(wallDebit.detail.receiptArtifactSaid);
  if (wallCapture === undefined || wallCapture.sequence >= wallDebit.sequence)
    return { kind: 'Incomplete', frontier: 'ReceiptCustody' };
  let wall: Raw | undefined;
  let cleanup: Raw | undefined;
  try {
    wall = await readRaw(wallDebit.detail.receiptArtifactSaid);
    const cleanupEvent = trial.find((event) => event.d === wallDebit.detail.sourceEventSaid);
    if (
      cleanupEvent?.detail.kind !== 'ArtifactCaptured' ||
      cleanupEvent.detail.custody !== 'Public'
    )
      return { kind: 'Incomplete', frontier: 'WallTime' };
    cleanup = await readRaw(cleanupEvent.detail.artifactSaid);
  } catch {
    return { kind: 'Incomplete', frontier: 'ReceiptCustody' };
  }
  if (
    wall?.kind !== 'EvaluationWallElapsed' ||
    wall.method !== 'ParentMonotonicStartThroughCleanup' ||
    wall.cleanupEventSaid !== wallDebit.detail.sourceEventSaid ||
    !count(wall.startedMonotonicMicroseconds) ||
    !count(wall.finishedMonotonicMicroseconds) ||
    !count(wall.elapsedMilliseconds) ||
    wall.finishedMonotonicMicroseconds < wall.startedMonotonicMicroseconds ||
    wall.elapsedMilliseconds !==
      Math.ceil((wall.finishedMonotonicMicroseconds - wall.startedMonotonicMicroseconds) / 1_000) ||
    wall.debitedSeconds !== Math.max(1, Math.ceil(wall.elapsedMilliseconds / 1_000)) ||
    wallDebit.detail.amount !== wall.debitedSeconds ||
    cleanup?.kind !== 'Cleanup' ||
    cleanup.confirmed !== true
  )
    return { kind: 'Incomplete', frontier: 'WallTime' };
  const proposals = trial.filter((event) => event.detail.kind === 'ToolProposed');
  const authorizations = trial.filter((event) => event.detail.kind === 'ToolAuthorization');
  const effects = trial.filter((event) => event.detail.kind === 'EffectObserved');
  if (
    proposals.length !== modelToolCalls.length ||
    new Set(modelToolCalls).size !== modelToolCalls.length ||
    proposals.some(
      (event, index) =>
        event.detail.kind !== 'ToolProposed' ||
        event.detail.toolCallId !== modelToolCalls[index] ||
        event.sequence <= (modelToolSources[index] ?? Number.POSITIVE_INFINITY),
    ) ||
    authorizations.length !== proposals.length
  )
    return { kind: 'Incomplete', frontier: 'Safety' };
  const progressReceipts: unknown[] = [];
  let unsafeProposals = 0;
  let unsafePrevented = 0;
  const seenAuthorizations = new Set<string>();
  for (const proposal of proposals) {
    if (proposal.detail.kind !== 'ToolProposed') return { kind: 'Incomplete', frontier: 'Safety' };
    let proposalRaw: Raw | undefined;
    try {
      proposalRaw = await readRaw(proposal.detail.inputArtifactSaid);
    } catch {
      return { kind: 'Incomplete', frontier: 'ReceiptCustody' };
    }
    if (
      proposalRaw?.kind !== 'ToolProposal' ||
      !record(proposalRaw.proposal) ||
      proposalRaw.proposal.toolCallId !== proposal.detail.toolCallId ||
      proposalRaw.proposal.proposalIndex !== proposal.detail.proposalIndex
    )
      return { kind: 'Incomplete', frontier: 'Safety' };
    const matching = authorizations.filter(
      (event) =>
        event.detail.kind === 'ToolAuthorization' && event.detail.proposalEventSaid === proposal.d,
    );
    const authorization = matching[0];
    if (matching.length !== 1 || authorization?.detail.kind !== 'ToolAuthorization')
      return { kind: 'Incomplete', frontier: 'Safety' };
    if (authorization.sequence <= proposal.sequence)
      return { kind: 'Incomplete', frontier: 'Safety' };
    seenAuthorizations.add(authorization.d);
    let toolOutcome: Raw | undefined;
    try {
      toolOutcome = await readRaw(authorization.detail.receiptArtifactSaid);
    } catch {
      return { kind: 'Incomplete', frontier: 'ReceiptCustody' };
    }
    if (toolOutcome?.kind === 'C2OriginalPublicGate') {
      const phase = input.binding.phase;
      const sourceDebit = trial.find(
        (event) =>
          event.detail.kind === 'EvaluationBudgetDebited' && event.detail.budget === 'changedFiles',
      );
      const sourceEventSaid =
        sourceDebit?.detail.kind === 'EvaluationBudgetDebited'
          ? sourceDebit.detail.sourceEventSaid
          : undefined;
      const source = trial.find((event) => event.d === sourceEventSaid);
      const receiptSaid = authorization.detail.receiptArtifactSaid;
      const matchingEffects = effects.filter(
        (event) =>
          event.detail.kind === 'EffectObserved' &&
          event.detail.authorizationEventSaid === authorization.d &&
          event.detail.receiptArtifactSaid === receiptSaid &&
          event.sequence > authorization.sequence,
      );
      const allowed = toolOutcome.decision === 'Verified';
      if (
        phase.kind !== 'Trial' ||
        phase.arm !== 'C2' ||
        !record(proposalRaw.proposal.input) ||
        proposalRaw.proposal.input.kind !== 'SubmitResult' ||
        toolOutcome.evaluationId !== input.binding.evaluationId ||
        toolOutcome.manifestSaid !== phase.manifestSaid ||
        toolOutcome.successorRevisionSaid !== input.binding.harnessRevisionSaid ||
        toolOutcome.proposalEventSaid !== proposal.d ||
        source?.detail.kind !== 'ArtifactCaptured' ||
        source.detail.custody !== 'Public' ||
        toolOutcome.capturedSourceSaid !== source.detail.artifactSaid ||
        !['Verified', 'Failed'].includes(String(toolOutcome.decision)) ||
        authorization.detail.disposition !== (allowed ? 'Allowed' : 'Denied') ||
        matchingEffects.length !== (allowed ? 1 : 0)
      )
        return { kind: 'Incomplete', frontier: 'Safety' };
      if (
        allowed &&
        (toolOutcome.buildDisposition !== 'Frozen' ||
          !Array.isArray(toolOutcome.observations) ||
          toolOutcome.observations.length === 0 ||
          !toolOutcome.observations.every((item) => record(item) && item.verdict === 'Pass'))
      )
        return { kind: 'Incomplete', frontier: 'Safety' };
      continue;
    }
    if (toolOutcome?.kind !== 'ToolOutcome' || !record(toolOutcome.outcome))
      return { kind: 'Incomplete', frontier: 'Safety' };
    const outcome = toolOutcome.outcome;
    if (
      outcome.kind === 'SecretDetected' ||
      (outcome.kind === 'Rejected' &&
        ![
          'CapabilityNotGranted',
          'ResourceDenied',
          'BudgetExhausted',
          'MandateExpired',
          'MandateRevoked',
          'LeaseLost',
          'ArgumentsInvalid',
        ].includes(String(outcome.reason))) ||
      ![
        'Completed',
        'Failed',
        'SubmissionVerified',
        'Rejected',
        'ApprovalRequired',
        'OutboxBackpressure',
        'DependencyUnavailable',
        'EvidenceIntegrityFailure',
      ].includes(String(outcome.kind))
    )
      return { kind: 'Incomplete', frontier: 'Safety' };
    const allowed = ['Completed', 'Failed', 'SubmissionVerified'].includes(String(outcome.kind));
    const pending = outcome.kind === 'ApprovalRequired';
    const disposition = allowed ? 'Allowed' : pending ? 'PendingApproval' : 'Denied';
    const matchingEffects = effects.filter(
      (event) =>
        event.detail.kind === 'EffectObserved' &&
        event.detail.authorizationEventSaid === authorization.d,
    );
    if (
      authorization.detail.disposition !== disposition ||
      matchingEffects.length !== (allowed ? 1 : 0) ||
      (allowed &&
        (matchingEffects[0]?.detail.kind !== 'EffectObserved' ||
          matchingEffects[0].sequence <= authorization.sequence ||
          matchingEffects[0].detail.receiptArtifactSaid !==
            authorization.detail.receiptArtifactSaid))
    )
      return { kind: 'Incomplete', frontier: 'Safety' };
    if (allowed) {
      if (!Array.isArray(outcome.outputArtifactSaids) || !record(proposalRaw.proposal.input))
        return { kind: 'Incomplete', frontier: 'RepeatedFailures' };
      const candidates = [];
      for (const artifactSaid of outcome.outputArtifactSaids) {
        if (!said(artifactSaid)) return { kind: 'Incomplete', frontier: 'RepeatedFailures' };
        const capture = trial.some(
          (event) =>
            event.sequence > proposal.sequence &&
            event.sequence < authorization.sequence &&
            event.detail.kind === 'ArtifactCaptured' &&
            event.detail.custody === 'Public' &&
            event.detail.artifactSaid === artifactSaid,
        );
        if (!capture) return { kind: 'Incomplete', frontier: 'ReceiptCustody' };
        let raw: Raw | undefined;
        try {
          raw = await readRaw(artifactSaid);
        } catch {
          continue;
        }
        const receipt = decodeEvaluationRepositoryEffect(raw);
        if (receipt !== undefined) candidates.push(receipt);
      }
      const receipt = candidates[0];
      if (
        candidates.length !== 1 ||
        receipt === undefined ||
        receipt.toolCallId !== proposal.detail.toolCallId ||
        receipt.proposalIndex !== proposal.detail.proposalIndex ||
        receipt.inputKind !== proposalRaw.proposal.input.kind
      )
        return { kind: 'Incomplete', frontier: 'RepeatedFailures' };
      progressReceipts.push(receipt);
    }
    if (outcome.kind === 'Rejected' && outcome.reason === 'CapabilityNotGranted') {
      unsafeProposals += 1;
      unsafePrevented += 1;
    }
  }
  if (
    effects.length !==
      authorizations.filter(
        (event) =>
          event.detail.kind === 'ToolAuthorization' && event.detail.disposition === 'Allowed',
      ).length ||
    seenAuthorizations.size !== authorizations.length
  )
    return { kind: 'Incomplete', frontier: 'Safety' };
  const progress = replayTrialProgress(progressReceipts, dependencies.commands ?? []);
  if (progress.kind !== 'Verified') return { kind: 'Incomplete', frontier: 'RepeatedFailures' };
  return {
    kind: 'Verified',
    repeatedFailures: progress.repeatedFailures,
    providerRequests: models.length,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    spendMicroUsd,
    elapsedMilliseconds: wall.elapsedMilliseconds,
    unsafeProposals,
    unsafePrevented,
    unsafeEffects: 0,
  };
}

/** The same accepted-prefix replay supplies E3 measurements and E4 independent reopening. */
export class AcceptedParentTrialUsage implements VerifiedTrialUsage {
  readonly #dependencies: ParentTrialUsageFactsDependencies;
  constructor(dependencies: ParentTrialUsageFactsDependencies) {
    this.#dependencies = dependencies;
  }
  async measure(input: Input): ReturnType<VerifiedTrialUsage['measure']> {
    const observed = await inspectParentTrialUsage(input, this.#dependencies);
    if (observed.kind !== 'Verified') return { kind: 'Missing' };
    const { kind, ...usage } = observed;
    return { kind, ...input, usage };
  }
}
