import { isDeepStrictEqual } from 'node:util';

import {
  taskEvaluationBudgetCeilings,
  validateExecutionBinding,
  type EvaluationAllowance,
  type EvaluationExecutionBinding,
} from '@devrandom/domain';
import {
  decodeEvidenceArtifact,
  decodeEvaluationEvidenceEvent,
  decodeEvaluationProviderUsageReceipt,
  prepareEvaluationEvidenceEvent,
  type EvidenceArtifact,
  type EvaluationEvidenceEvent,
} from '@devrandom/protocol';

import {
  measureFinalizationElapsed,
  measureResearchPreparationElapsed,
  type CodingElapsedInterval,
} from './finalization-elapsed.js';

/** Authenticated exact-read view of the hosted Evaluation stream, through its acknowledged head. */
export interface EvaluationAcceptedPrefix {
  open(binding: EvaluationExecutionBinding): Promise<
    | {
        readonly kind: 'Acknowledged';
        readonly events: readonly EvaluationEvidenceEvent[];
        readonly throughSequence: number;
        readonly headSaid: string;
      }
    | { readonly kind: 'Missing' | 'Unavailable' }
  >;
}

/** Parent-only raw custody and verified provider usage; worker assertions never satisfy this port. */
export interface EvaluationMeasurementReceipts {
  openPublic(input: {
    readonly evaluationId: string;
    readonly artifactSaid: string;
  }): Promise<
    | { readonly kind: 'Opened'; readonly artifact: EvidenceArtifact; readonly bytes: Uint8Array }
    | { readonly kind: 'Missing' | 'Unavailable' }
  >;
  verifyProviderUsage(input: { readonly usageEventSaid: string }): Promise<
    | {
        readonly kind: 'Verified';
        readonly usageEventSaid: string;
        readonly responseId: string;
        readonly inputTokens: number;
        readonly outputTokens: number;
        readonly spendMicroUsd: number;
      }
    | { readonly kind: 'Missing' | 'Unavailable' }
  >;
}

export interface EvaluationBudgetCoverageDependencies {
  readonly accepted: EvaluationAcceptedPrefix;
  readonly receipts: EvaluationMeasurementReceipts;
}

export interface EvaluationBudgetCoverageInput {
  readonly binding: EvaluationExecutionBinding;
  readonly reserved: EvaluationAllowance;
  readonly occurredAt: string;
}

export type EvaluationBudgetCoveragePreparation =
  | { readonly kind: 'Prepared'; readonly event: EvaluationEvidenceEvent }
  | {
      readonly kind: 'Incomplete';
      readonly frontier:
        | 'AcceptedPrefix'
        | 'EventChain'
        | 'ThroughHead'
        | 'ReceiptCustody'
        | 'ReceiptAuthority'
        | 'DebitSequence'
        | 'MissingDimension'
        | 'ProviderUsage'
        | 'Reservation';
    };

const budgets = [
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
type Budget = (typeof budgets)[number];
type Debit = Extract<EvaluationEvidenceEvent['detail'], { kind: 'EvaluationBudgetDebited' }>;
type Frontier = Extract<EvaluationBudgetCoveragePreparation, { kind: 'Incomplete' }>['frontier'];
const providerBudgets = [
  'providerRequests',
  'providerInputTokens',
  'providerOutputTokens',
  'providerSpendMicroUsd',
] as const;
const nativeTools = new Set(['run_formatter', 'run_static_analysis', 'run_tests']);

function incomplete(frontier: Frontier): EvaluationBudgetCoveragePreparation {
  return { kind: 'Incomplete', frontier };
}

interface UntrustedMeasurement {
  readonly version?: unknown;
  readonly fromSequence?: unknown;
  readonly openedEventSaid?: unknown;
  readonly researchPreparationReceiptSaid?: unknown;
  readonly inferenceWallReceiptSaids?: unknown;
  readonly replayArtifactSaid?: unknown;
  readonly rawReceiptSaid?: unknown;
  readonly operation?: unknown;
  readonly buildReceiptSaid?: unknown;
  readonly buildCleanupReceiptSaid?: unknown;
  readonly observations?: unknown;
  readonly cleanupReceiptSaid?: unknown;
  readonly publicCleanupReceiptSaids?: unknown;
  readonly rawObservationSaid?: unknown;
  readonly stopped?: unknown;
  readonly exitCode?: unknown;
  readonly codingWallReceiptSaids?: unknown;
  readonly throughSequence?: unknown;
  readonly throughHeadSaid?: unknown;
  readonly kind?: unknown;
  readonly evaluationId?: unknown;
  readonly streamId?: unknown;
  readonly harnessRevisionSaid?: unknown;
  readonly phase?: unknown;
  readonly providerReportArtifactSaid?: unknown;
  readonly modelExchangeEventSaid?: unknown;
  readonly proposalEventSaid?: unknown;
  readonly proposal?: unknown;
  readonly toolCallId?: unknown;
  readonly proposalIndex?: unknown;
  readonly toolName?: unknown;
  readonly outcomeKind?: unknown;
  readonly childCommandDuration?: unknown;
  readonly childCommandDebitedSeconds?: unknown;
  readonly startedMonotonicMicroseconds?: unknown;
  readonly finishedMonotonicMicroseconds?: unknown;
  readonly elapsedMilliseconds?: unknown;
  readonly afterSourceSaid?: unknown;
  readonly beforeSourceSaid?: unknown;
  readonly changedByteRule?: unknown;
  readonly changedFiles?: unknown;
  readonly changedWorktreeBytes?: unknown;
  readonly paths?: unknown;
  readonly method?: unknown;
  readonly debitedSeconds?: unknown;
  readonly cleanupEventSaid?: unknown;
  readonly requestOrdinal?: unknown;
  readonly usageEventSaid?: unknown;
  readonly responseId?: unknown;
  readonly provider?: unknown;
  readonly model?: unknown;
  readonly inputTokens?: unknown;
  readonly outputTokens?: unknown;
  readonly cacheReadTokens?: unknown;
  readonly cacheWriteTokens?: unknown;
  readonly spendMicroUsd?: unknown;
  readonly message?: unknown;
  readonly usage?: unknown;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly cacheRead?: unknown;
  readonly cacheWrite?: unknown;
  readonly totalTokens?: unknown;
  readonly confirmed?: unknown;
}

function record(value: unknown): value is UntrustedMeasurement {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0;
}

function said(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z][A-Za-z0-9_-]{43}$/u.test(value);
}

function budgetName(value: unknown): value is Budget {
  return budgets.some((name) => name === value);
}

function samePhase(left: EvaluationEvidenceEvent, right: EvaluationEvidenceEvent): boolean {
  return (
    left.harnessRevisionSaid === right.harnessRevisionSaid &&
    isDeepStrictEqual(left.phase, right.phase)
  );
}

function phaseKey(event: EvaluationEvidenceEvent): string {
  const phase = event.phase;
  return JSON.stringify([
    event.harnessRevisionSaid,
    ...(phase.kind === 'Trial'
      ? [phase.kind, phase.manifestSaid, phase.arm, phase.repetition, phase.attempt]
      : [phase.kind, phase.policySaid, phase.role]),
  ]);
}

function sourceMatches(
  budget: Budget,
  source: EvaluationEvidenceEvent,
  receipt: UntrustedMeasurement,
  known: ReadonlyMap<string, EvaluationEvidenceEvent>,
): boolean {
  if (providerBudgets.some((name) => name === budget))
    return (
      source.detail.kind === 'ModelExchange' &&
      receipt.kind === 'EvaluationProviderUsageReceipt' &&
      receipt.modelExchangeEventSaid === source.d
    );
  if (budget === 'toolProposals' && receipt.kind === 'C2ProvisionalSubmissionAuthorized')
    return (
      source.phase.kind === 'Trial' &&
      source.phase.arm === 'C2' &&
      source.detail.kind === 'ToolProposed' &&
      receipt.proposalEventSaid === source.d
    );
  if (budget === 'toolProposals')
    return (
      source.detail.kind === 'ToolProposed' &&
      receipt.kind === 'EvaluationToolElapsed' &&
      receipt.proposalEventSaid === source.d &&
      receipt.toolCallId === source.detail.toolCallId &&
      receipt.proposalIndex === source.detail.proposalIndex
    );
  if (budget === 'aggregateChildCommandTimeSeconds') {
    if (receipt.kind === 'EvaluationFinalizationNativeElapsed')
      return (
        source.phase.kind === 'Trial' &&
        source.detail.kind === 'ArtifactCaptured' &&
        receipt.method === 'ParentNativeRoundTripUpperBound' &&
        receipt.cleanupReceiptSaid === source.detail.artifactSaid
      );
    if (receipt.kind === 'EvaluationResearchNativeElapsed')
      return (
        source.phase.kind === 'Research' &&
        source.detail.kind === 'ArtifactCaptured' &&
        receipt.method === 'ParentReplayRoundTripUpperBound' &&
        receipt.replayArtifactSaid === source.detail.artifactSaid
      );
    if (receipt.kind === 'EvaluationToolElapsed')
      return (
        source.detail.kind === 'ToolProposed' &&
        receipt.proposalEventSaid === source.d &&
        receipt.toolCallId === source.detail.toolCallId &&
        receipt.proposalIndex === source.detail.proposalIndex
      );
    return (
      source.detail.kind === 'ArtifactCaptured' &&
      receipt.kind === 'EvaluationChildCommands' &&
      receipt.method === 'NoNativeCommandToolEffect' &&
      receipt.debitedSeconds === 0
    );
  }
  if (budget === 'changedFiles' || budget === 'changedWorktreeBytes') {
    const latestSourceRead = [...known.values()]
      .filter(
        (event) =>
          event.detail.kind === 'SourceRead' &&
          event.sequence < source.sequence &&
          samePhase(event, source),
      )
      .at(-1);
    return (
      source.detail.kind === 'ArtifactCaptured' &&
      receipt.kind === 'EvaluationSourceChanges' &&
      receipt.afterSourceSaid === source.detail.artifactSaid &&
      receipt.changedByteRule === 'MaxPrePostLengthPerChangedPath' &&
      latestSourceRead?.detail.kind === 'SourceRead' &&
      latestSourceRead.detail.sourceSaid === receipt.beforeSourceSaid
    );
  }
  if (receipt.kind === 'EvaluationResearchPreparationElapsed')
    return (
      source.phase.kind === 'Research' &&
      source.detail.kind === 'ArtifactCaptured' &&
      receipt.method === 'ParentMonotonicPreparationLessInferenceIntervals' &&
      receipt.throughSequence === source.sequence &&
      receipt.throughHeadSaid === source.d
    );
  if (receipt.kind === 'EvaluationResearchElapsed')
    return (
      source.phase.kind === 'Research' &&
      source.detail.kind === 'ProviderUsageVerified' &&
      receipt.method === 'ParentMonotonicResearch' &&
      receipt.usageEventSaid === source.d &&
      receipt.evaluationId === source.evaluationId &&
      receipt.streamId === source.streamId &&
      receipt.harnessRevisionSaid === source.harnessRevisionSaid &&
      isDeepStrictEqual(receipt.phase, source.phase)
    );
  if (receipt.kind === 'EvaluationFinalizationElapsed')
    return (
      source.detail.kind === 'ArtifactCaptured' &&
      receipt.method === 'ParentMonotonicComparisonLessCodingIntervals' &&
      receipt.throughSequence === source.sequence &&
      receipt.throughHeadSaid === source.d
    );
  return (
    source.detail.kind === 'ArtifactCaptured' &&
    receipt.kind === 'EvaluationWallElapsed' &&
    receipt.method === 'ParentMonotonicStartThroughCleanup' &&
    receipt.cleanupEventSaid === source.d
  );
}

function measuredAmount(budget: Budget, receipt: UntrustedMeasurement): number | undefined {
  switch (budget) {
    case 'providerRequests':
      return 1;
    case 'providerInputTokens':
      return safeCount(receipt.inputTokens) ? receipt.inputTokens : undefined;
    case 'providerOutputTokens':
      return safeCount(receipt.outputTokens) ? receipt.outputTokens : undefined;
    case 'providerSpendMicroUsd':
      return safeCount(receipt.spendMicroUsd) ? receipt.spendMicroUsd : undefined;
    case 'toolProposals':
      return 1;
    case 'changedFiles':
      return safeCount(receipt.changedFiles) ? receipt.changedFiles : undefined;
    case 'changedWorktreeBytes':
      return safeCount(receipt.changedWorktreeBytes) ? receipt.changedWorktreeBytes : undefined;
    case 'runWallTimeSeconds':
      return safeCount(receipt.debitedSeconds) ? receipt.debitedSeconds : undefined;
    case 'aggregateChildCommandTimeSeconds':
      return safeCount(receipt.childCommandDebitedSeconds)
        ? receipt.childCommandDebitedSeconds
        : receipt.kind === 'EvaluationChildCommands' && receipt.debitedSeconds === 0
          ? 0
          : undefined;
  }
}

function validElapsed(receipt: UntrustedMeasurement): boolean {
  if (
    !safeCount(receipt.startedMonotonicMicroseconds) ||
    !safeCount(receipt.finishedMonotonicMicroseconds) ||
    !safeCount(receipt.elapsedMilliseconds)
  )
    return false;
  return (
    receipt.finishedMonotonicMicroseconds >= receipt.startedMonotonicMicroseconds &&
    receipt.elapsedMilliseconds ===
      Math.ceil(
        (receipt.finishedMonotonicMicroseconds - receipt.startedMonotonicMicroseconds) / 1_000,
      )
  );
}

function validMeasurement(budget: Budget, receipt: UntrustedMeasurement, amount: number): boolean {
  if (measuredAmount(budget, receipt) !== amount) return false;
  if (budget === 'toolProposals' && receipt.kind === 'C2ProvisionalSubmissionAuthorized')
    return amount === 1;
  if (
    budget === 'toolProposals' ||
    (budget === 'aggregateChildCommandTimeSeconds' && receipt.kind === 'EvaluationToolElapsed')
  ) {
    if (
      !validElapsed(receipt) ||
      !safeCount(receipt.elapsedMilliseconds) ||
      typeof receipt.toolName !== 'string'
    )
      return false;
    if (budget === 'aggregateChildCommandTimeSeconds') {
      if (!nativeTools.has(receipt.toolName)) return false;
      if (receipt.childCommandDuration === 'NotExecuted')
        return (
          amount === 0 && receipt.outcomeKind !== 'Completed' && receipt.outcomeKind !== 'Failed'
        );
      if (receipt.childCommandDuration !== 'GatewayRoundTripUpperBound') return false;
      return (
        (receipt.outcomeKind === 'Completed' || receipt.outcomeKind === 'Failed') &&
        amount === Math.max(1, Math.ceil(receipt.elapsedMilliseconds / 1_000))
      );
    }
    return true;
  }
  if (
    budget === 'aggregateChildCommandTimeSeconds' &&
    (receipt.kind === 'EvaluationResearchNativeElapsed' ||
      receipt.kind === 'EvaluationFinalizationNativeElapsed')
  )
    return (
      validElapsed(receipt) &&
      safeCount(receipt.elapsedMilliseconds) &&
      amount === Math.max(1, Math.ceil(receipt.elapsedMilliseconds / 1000))
    );
  if (
    budget === 'runWallTimeSeconds' &&
    (receipt.kind === 'EvaluationFinalizationElapsed' ||
      receipt.kind === 'EvaluationResearchPreparationElapsed')
  )
    return (
      safeCount(receipt.elapsedMilliseconds) &&
      amount === Math.max(1, Math.ceil(receipt.elapsedMilliseconds / 1000))
    );
  if (budget === 'runWallTimeSeconds')
    return (
      validElapsed(receipt) &&
      safeCount(receipt.elapsedMilliseconds) &&
      amount === Math.max(1, Math.ceil(receipt.elapsedMilliseconds / 1_000))
    );
  if (budget === 'changedFiles' || budget === 'changedWorktreeBytes')
    return (
      Array.isArray(receipt.paths) &&
      receipt.paths.every((path) => typeof path === 'string' && path.length > 0) &&
      new Set(receipt.paths).size === receipt.paths.length &&
      receipt.changedFiles === receipt.paths.length
    );
  return true;
}

function matchingIdentity(
  event: EvaluationEvidenceEvent,
  binding: EvaluationExecutionBinding,
): boolean {
  return (
    event.evaluationId === binding.evaluationId &&
    event.streamId === binding.evidenceStreamId &&
    event.originRunId === binding.originRunId &&
    event.taskId === binding.taskId &&
    event.taskRevisionSaid === binding.taskRevisionSaid &&
    event.personalAgentAid === binding.personalAgentAid &&
    event.taskMandateSaid === binding.taskMandateSaid
  );
}

/** Prepares the coverage event only; the trusted parent must append and obtain hosted ACK. */
export async function prepareEvaluationBudgetCoverage(
  input: EvaluationBudgetCoverageInput,
  dependencies: EvaluationBudgetCoverageDependencies,
): Promise<EvaluationBudgetCoveragePreparation> {
  if (
    validateExecutionBinding(input.binding).kind !== 'Accepted' ||
    budgets.some(
      (budget) =>
        !safeCount(input.reserved[budget]) ||
        input.reserved[budget] > taskEvaluationBudgetCeilings[budget],
    )
  )
    return incomplete('Reservation');
  let prefix: Awaited<ReturnType<EvaluationAcceptedPrefix['open']>>;
  try {
    prefix = await dependencies.accepted.open(input.binding);
  } catch {
    return incomplete('AcceptedPrefix');
  }
  if (prefix.kind !== 'Acknowledged' || prefix.events.length === 0 || prefix.events.length > 10_000)
    return incomplete('AcceptedPrefix');
  let events: readonly EvaluationEvidenceEvent[];
  try {
    events = structuredClone(prefix.events);
  } catch {
    return incomplete('AcceptedPrefix');
  }
  const head = events.at(-1);
  if (
    head === undefined ||
    prefix.throughSequence !== events.length - 1 ||
    prefix.headSaid !== head.d
  )
    return incomplete('ThroughHead');
  const prior = new Map<string, EvaluationEvidenceEvent>();
  for (const [index, event] of events.entries()) {
    const predecessor = events[index - 1];
    if (
      decodeEvaluationEvidenceEvent(event).kind !== 'Accepted' ||
      event.sequence !== index ||
      !matchingIdentity(event, input.binding) ||
      (index === 0
        ? event.previous.kind !== 'Genesis'
        : event.previous.kind !== 'Previous' || event.previous.eventSaid !== predecessor?.d) ||
      event.detail.kind === 'EvaluationBudgetCovered'
    )
      return incomplete('EventChain');
    prior.set(event.d, event);
  }
  if (
    head.harnessRevisionSaid !== input.binding.harnessRevisionSaid ||
    !isDeepStrictEqual(head.phase, input.binding.phase)
  )
    return incomplete('EventChain');
  const totals = Object.fromEntries(budgets.map((budget) => [budget, 0])) as Record<Budget, number>;
  const seen = new Set<Budget>();
  const captured = new Map<string, EvaluationEvidenceEvent>();
  const receiptSource = new Map<string, string>();
  const groupReceipt = new Map<string, string>();
  const sourceBudgets = new Map<string, Set<Budget>>();
  const nativeProposals = new Set<string>();
  const finalizationCleanups = new Set<string>();
  const trialPhases = new Set<string>();
  const completedTrialPhases = new Set<string>();
  const phaseBudgets = new Map<string, Set<Budget>>();
  const measurementCache = new Map<string, UntrustedMeasurement>();
  const providerUsage = new Map<string, string>();
  const providerOrdinalByPhase = new Map<string, number>();
  const orderedUsage: string[] = [];
  const nativeCommandPhases = new Set<string>();
  const noNativeCommandPhases = new Set<string>();
  const researchElapsedUsage = new Set<string>();
  let lastPreparationReceiptSaid: string | undefined;
  const readRaw = async (artifactSaid: string): Promise<UntrustedMeasurement | undefined> => {
    const cached = measurementCache.get(artifactSaid);
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
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!record(parsed) || JSON.stringify(parsed) !== Buffer.from(bytes).toString('utf8'))
      return undefined;
    measurementCache.set(artifactSaid, parsed);
    return parsed;
  };
  for (const event of events) {
    if (event.phase.kind === 'Trial') trialPhases.add(phaseKey(event));
    if (event.detail.kind === 'TrialStopped') {
      if (event.detail.reason !== 'Completed') return incomplete('MissingDimension');
      completedTrialPhases.add(phaseKey(event));
    }
    if (event.detail.kind === 'ArtifactCaptured' && event.detail.custody === 'Public')
      captured.set(event.detail.artifactSaid, event);
    if (event.detail.kind !== 'EvaluationBudgetDebited') continue;
    const debit: Debit = event.detail;
    const budget = debit.budget;
    if (!budgetName(budget)) return incomplete('DebitSequence');
    const source =
      debit.sourceEventSaid === undefined ? undefined : prior.get(debit.sourceEventSaid);
    if (source === undefined || source.sequence >= event.sequence || !samePhase(source, event))
      return incomplete('ReceiptAuthority');
    const capture = captured.get(debit.receiptArtifactSaid);
    if (capture === undefined || !samePhase(capture, event)) return incomplete('ReceiptCustody');
    let receipt: UntrustedMeasurement | undefined;
    try {
      receipt = await readRaw(debit.receiptArtifactSaid);
    } catch {
      return incomplete('ReceiptCustody');
    }
    if (receipt === undefined) return incomplete('ReceiptCustody');
    if (
      !sourceMatches(budget, source, receipt, prior) ||
      !validMeasurement(budget, receipt, debit.amount)
    )
      return incomplete('ReceiptAuthority');
    if (receipt.kind === 'C2ProvisionalSubmissionAuthorized') {
      if (budget !== 'toolProposals' || source.detail.kind !== 'ToolProposed')
        return incomplete('ReceiptAuthority');
      let proposal: UntrustedMeasurement | undefined;
      try {
        proposal = await readRaw(source.detail.inputArtifactSaid);
      } catch {
        return incomplete('ReceiptCustody');
      }
      if (
        proposal?.kind !== 'ToolProposal' ||
        !record(proposal.proposal) ||
        proposal.proposal.toolCallId !== source.detail.toolCallId ||
        proposal.proposal.proposalIndex !== source.detail.proposalIndex ||
        !record(proposal.proposal.input) ||
        proposal.proposal.input.kind !== 'SubmitResult'
      )
        return incomplete('ReceiptAuthority');
    }
    const groupKind = providerBudgets.some((name) => name === budget)
      ? 'Provider'
      : budget === 'toolProposals' ||
          (budget === 'aggregateChildCommandTimeSeconds' &&
            receipt.kind === 'EvaluationToolElapsed')
        ? 'Tool'
        : budget === 'changedFiles' || budget === 'changedWorktreeBytes'
          ? 'Source'
          : budget === 'runWallTimeSeconds'
            ? 'Wall'
            : 'NoCommands';
    const groupKey = `${source.d}/${groupKind}`;
    const groupedReceipt = groupReceipt.get(groupKey);
    if (groupedReceipt !== undefined && groupedReceipt !== debit.receiptArtifactSaid)
      return incomplete('ReceiptAuthority');
    groupReceipt.set(groupKey, debit.receiptArtifactSaid);
    // Equal source manifests can legitimately recur in independently executed trials.
    // The source event, phase-local captures and manifest replay still bind each debit.
    const receiptConsumption =
      groupKind === 'Source'
        ? `${debit.receiptArtifactSaid}/${phaseKey(event)}`
        : debit.receiptArtifactSaid;
    const previousSource = receiptSource.get(receiptConsumption);
    if (previousSource !== undefined && previousSource !== source.d)
      return incomplete('ReceiptAuthority');
    receiptSource.set(receiptConsumption, source.d);
    const group = sourceBudgets.get(source.d) ?? new Set<Budget>();
    if (group.has(budget)) return incomplete('ReceiptAuthority');
    group.add(budget);
    sourceBudgets.set(source.d, group);
    const next = totals[budget] + debit.amount;
    if (!Number.isSafeInteger(next) || next > input.reserved[budget])
      return incomplete('Reservation');
    if (debit.consumed !== next) return incomplete('DebitSequence');
    totals[budget] = next;
    seen.add(budget);
    const phase = phaseBudgets.get(phaseKey(event)) ?? new Set<Budget>();
    phase.add(budget);
    phaseBudgets.set(phaseKey(event), phase);
    if (budget === 'aggregateChildCommandTimeSeconds' && receipt.kind === 'EvaluationToolElapsed')
      nativeCommandPhases.add(phaseKey(event));
    if (budget === 'aggregateChildCommandTimeSeconds' && receipt.kind === 'EvaluationChildCommands')
      noNativeCommandPhases.add(phaseKey(event));
    if (budget === 'runWallTimeSeconds' && receipt.kind === 'EvaluationResearchElapsed')
      researchElapsedUsage.add(source.d);
    if (
      budget === 'toolProposals' &&
      typeof receipt.toolName === 'string' &&
      nativeTools.has(receipt.toolName)
    )
      nativeProposals.add(source.d);
    if (budget === 'changedFiles' || budget === 'changedWorktreeBytes') {
      if (!said(receipt.beforeSourceSaid) || !said(receipt.afterSourceSaid))
        return incomplete('ReceiptAuthority');
      try {
        if (
          (await readRaw(receipt.beforeSourceSaid)) === undefined ||
          (await readRaw(receipt.afterSourceSaid)) === undefined
        )
          return incomplete('ReceiptCustody');
      } catch {
        return incomplete('ReceiptCustody');
      }
    }
    if (
      budget === 'aggregateChildCommandTimeSeconds' &&
      receipt.kind === 'EvaluationFinalizationNativeElapsed'
    ) {
      if (
        !said(receipt.rawReceiptSaid) ||
        !said(receipt.cleanupReceiptSaid) ||
        !events.some(
          (item) =>
            item.sequence < source.sequence &&
            item.detail.kind === 'TrialStopped' &&
            phaseKey(item) === phaseKey(source),
        )
      )
        return incomplete('ReceiptAuthority');
      finalizationCleanups.add(`${phaseKey(source)}:${receipt.cleanupReceiptSaid}`);
      const cleanup = await readRaw(receipt.cleanupReceiptSaid);
      if (cleanup?.stopped !== true) return incomplete('ReceiptAuthority');
      if (receipt.operation === 'Build') {
        const raw = await readRaw(receipt.rawReceiptSaid);
        if (cleanup.buildReceiptSaid !== receipt.rawReceiptSaid || !safeCount(raw?.exitCode))
          return incomplete('ReceiptAuthority');
      } else if (
        receipt.operation === 'PublicObservation' ||
        receipt.operation === 'ProtectedObservation'
      ) {
        if (cleanup.rawObservationSaid !== receipt.rawReceiptSaid)
          return incomplete('ReceiptAuthority');
        if (
          receipt.operation === 'PublicObservation' &&
          (await readRaw(receipt.rawReceiptSaid)) === undefined
        )
          return incomplete('ReceiptCustody');
      } else return incomplete('ReceiptAuthority');
    }
    if (
      budget === 'aggregateChildCommandTimeSeconds' &&
      receipt.kind === 'EvaluationResearchNativeElapsed'
    ) {
      if (source.detail.kind !== 'ArtifactCaptured') return incomplete('ReceiptAuthority');
      const replay = await readRaw(source.detail.artifactSaid);
      if (
        replay?.kind !== 'SuccessorPublicReplay' ||
        !said(replay.buildReceiptSaid) ||
        !said(replay.buildCleanupReceiptSaid) ||
        !Array.isArray(replay.observations) ||
        replay.observations.length === 0 ||
        replay.observations.length > 64
      )
        return incomplete('ReceiptAuthority');
      const build = await readRaw(replay.buildReceiptSaid);
      const closed = await readRaw(replay.buildCleanupReceiptSaid);
      if (
        build?.exitCode !== 0 ||
        closed?.buildReceiptSaid !== replay.buildReceiptSaid ||
        closed.stopped !== true
      )
        return incomplete('ReceiptAuthority');
      for (const observation of replay.observations) {
        if (
          !record(observation) ||
          !said(observation.rawObservationSaid) ||
          !said(observation.cleanupReceiptSaid)
        )
          return incomplete('ReceiptAuthority');
        const raw = await readRaw(observation.rawObservationSaid);
        const cleanup = await readRaw(observation.cleanupReceiptSaid);
        if (
          raw === undefined ||
          cleanup?.rawObservationSaid !== observation.rawObservationSaid ||
          cleanup.stopped !== true
        )
          return incomplete('ReceiptAuthority');
      }
    }
    if (
      budget === 'runWallTimeSeconds' &&
      receipt.kind === 'EvaluationResearchPreparationElapsed'
    ) {
      if (
        !safeCount(receipt.fromSequence) ||
        receipt.fromSequence > source.sequence ||
        !safeCount(receipt.startedMonotonicMicroseconds) ||
        !safeCount(receipt.finishedMonotonicMicroseconds)
      )
        return incomplete('ReceiptAuthority');
      if (!said(receipt.openedEventSaid)) return incomplete('ReceiptAuthority');
      const opening = events.find((item) => item.d === receipt.openedEventSaid);
      if (
        opening === undefined ||
        opening.sequence < receipt.fromSequence ||
        opening.sequence >= source.sequence ||
        opening.phase.kind !== 'Research' ||
        opening.detail.kind !== 'ArtifactCaptured'
      )
        return incomplete('ReceiptAuthority');
      const opened = await readRaw(opening.detail.artifactSaid);
      if (
        opened?.kind !== 'ResearchPreparationOpened' ||
        opened.evaluationId !== input.binding.evaluationId ||
        opened.startedMonotonicMicroseconds !== receipt.startedMonotonicMicroseconds
      )
        return incomplete('ReceiptAuthority');
      const fromSequence = receipt.fromSequence;
      const inference = events.filter(
        (item) =>
          item.sequence >= fromSequence &&
          item.sequence < source.sequence &&
          item.phase.kind === 'Research' &&
          item.detail.kind === 'EvaluationBudgetDebited' &&
          item.detail.budget === 'runWallTimeSeconds',
      );
      const intervals: CodingElapsedInterval[] = [];
      for (const item of inference) {
        if (item.detail.kind !== 'EvaluationBudgetDebited') return incomplete('ReceiptAuthority');
        const raw = await readRaw(item.detail.receiptArtifactSaid);
        if (
          raw?.kind !== 'EvaluationResearchElapsed' ||
          !safeCount(raw.startedMonotonicMicroseconds) ||
          !safeCount(raw.finishedMonotonicMicroseconds)
        )
          return incomplete('ReceiptAuthority');
        intervals.push({
          artifactSaid: item.detail.receiptArtifactSaid,
          startedMonotonicMicroseconds: raw.startedMonotonicMicroseconds,
          finishedMonotonicMicroseconds: raw.finishedMonotonicMicroseconds,
        });
      }
      if (
        !isDeepStrictEqual(
          receipt.inferenceWallReceiptSaids,
          intervals.map((item) => item.artifactSaid),
        )
      )
        return incomplete('ReceiptAuthority');
      const measured = measureResearchPreparationElapsed(
        receipt.startedMonotonicMicroseconds,
        receipt.finishedMonotonicMicroseconds,
        intervals,
      );
      if (
        measured.kind !== 'Measured' ||
        measured.elapsedMilliseconds !== receipt.elapsedMilliseconds
      )
        return incomplete('ReceiptAuthority');
    }
    if (budget === 'runWallTimeSeconds' && receipt.kind === 'EvaluationResearchPreparationElapsed')
      lastPreparationReceiptSaid = event.detail.receiptArtifactSaid;
    if (budget === 'runWallTimeSeconds' && receipt.kind === 'EvaluationFinalizationElapsed') {
      if (receipt.researchPreparationReceiptSaid !== lastPreparationReceiptSaid)
        return incomplete('ReceiptAuthority');
      if (receipt.researchPreparationReceiptSaid !== undefined) {
        if (!said(receipt.researchPreparationReceiptSaid)) return incomplete('ReceiptAuthority');
        const preparation = await readRaw(receipt.researchPreparationReceiptSaid);
        if (
          preparation?.kind !== 'EvaluationResearchPreparationElapsed' ||
          preparation.finishedMonotonicMicroseconds !== receipt.startedMonotonicMicroseconds ||
          !events.some(
            (item) =>
              item.sequence < source.sequence &&
              item.phase.kind === 'Research' &&
              item.detail.kind === 'EvaluationBudgetDebited' &&
              item.detail.receiptArtifactSaid === receipt.researchPreparationReceiptSaid,
          )
        )
          return incomplete('ReceiptAuthority');
      }

      const coding = events.filter(
        (item) =>
          item.sequence < source.sequence &&
          item.phase.kind === 'Trial' &&
          item.detail.kind === 'EvaluationBudgetDebited' &&
          item.detail.budget === 'runWallTimeSeconds',
      );
      if (
        coding.length !== 18 ||
        new Set(coding.map(phaseKey)).size !== 18 ||
        !Array.isArray(receipt.codingWallReceiptSaids) ||
        !isDeepStrictEqual(
          receipt.codingWallReceiptSaids,
          coding.map((item) =>
            item.detail.kind === 'EvaluationBudgetDebited' ? item.detail.receiptArtifactSaid : '',
          ),
        ) ||
        !safeCount(receipt.startedMonotonicMicroseconds) ||
        !safeCount(receipt.finishedMonotonicMicroseconds)
      )
        return incomplete('ReceiptAuthority');
      const intervals: CodingElapsedInterval[] = [];
      for (const coded of coding) {
        if (coded.detail.kind !== 'EvaluationBudgetDebited') return incomplete('ReceiptAuthority');
        const raw = await readRaw(coded.detail.receiptArtifactSaid);
        if (
          raw?.kind !== 'EvaluationWallElapsed' ||
          !safeCount(raw.startedMonotonicMicroseconds) ||
          !safeCount(raw.finishedMonotonicMicroseconds)
        )
          return incomplete('ReceiptAuthority');
        intervals.push({
          artifactSaid: coded.detail.receiptArtifactSaid,
          startedMonotonicMicroseconds: raw.startedMonotonicMicroseconds,
          finishedMonotonicMicroseconds: raw.finishedMonotonicMicroseconds,
        });
      }
      const measured = measureFinalizationElapsed(
        receipt.startedMonotonicMicroseconds,
        receipt.finishedMonotonicMicroseconds,
        intervals,
      );
      if (
        measured.kind !== 'Measured' ||
        measured.elapsedMilliseconds !== receipt.elapsedMilliseconds
      )
        return incomplete('ReceiptAuthority');
    }
    if (
      (budget === 'runWallTimeSeconds' &&
        receipt.kind !== 'EvaluationFinalizationElapsed' &&
        receipt.kind !== 'EvaluationResearchElapsed' &&
        receipt.kind !== 'EvaluationResearchPreparationElapsed') ||
      (budget === 'aggregateChildCommandTimeSeconds' && receipt.kind === 'EvaluationChildCommands')
    ) {
      if (source.detail.kind !== 'ArtifactCaptured') return incomplete('ReceiptAuthority');
      let cleanup: UntrustedMeasurement | undefined;
      try {
        cleanup = await readRaw(source.detail.artifactSaid);
      } catch {
        return incomplete('ReceiptCustody');
      }
      if (cleanup?.kind !== 'Cleanup' || cleanup.confirmed !== true)
        return incomplete('ReceiptAuthority');
    }
    if (budget === 'providerRequests') {
      if (source.detail.kind !== 'ModelExchange') return incomplete('ReceiptAuthority');
      const witness = events.filter(
        (candidate) =>
          candidate.detail.kind === 'ProviderUsageVerified' &&
          candidate.detail.modelExchangeEventSaid === source.d,
      );
      const usageEvent = witness[0];
      if (
        witness.length !== 1 ||
        usageEvent?.detail.kind !== 'ProviderUsageVerified' ||
        usageEvent.sequence <= source.sequence ||
        usageEvent.sequence >= event.sequence ||
        !samePhase(usageEvent, source) ||
        usageEvent.detail.receiptArtifactSaid !== debit.receiptArtifactSaid ||
        usageEvent.detail.providerReportArtifactSaid !== receipt.providerReportArtifactSaid ||
        captured.get(usageEvent.detail.providerReportArtifactSaid) === undefined ||
        captured.get(usageEvent.detail.receiptArtifactSaid) === undefined
      )
        return incomplete('ProviderUsage');
      const openedReceipt = await dependencies.receipts.openPublic({
        evaluationId: input.binding.evaluationId,
        artifactSaid: debit.receiptArtifactSaid,
      });
      if (
        openedReceipt.kind !== 'Opened' ||
        decodeEvaluationProviderUsageReceipt(openedReceipt.artifact, openedReceipt.bytes).kind !==
          'Accepted'
      )
        return incomplete('ReceiptCustody');
      const providerPhaseKey = phaseKey(source);
      const expectedOrdinal = providerOrdinalByPhase.get(providerPhaseKey) ?? 0;
      let exchange: UntrustedMeasurement | undefined;
      try {
        exchange = await readRaw(source.detail.rawArtifactSaid);
      } catch {
        return incomplete('ReceiptCustody');
      }
      if (
        exchange?.kind !== 'ModelExchange' ||
        exchange.requestOrdinal !== receipt.requestOrdinal ||
        !record(exchange.message) ||
        !record(exchange.message.usage) ||
        exchange.message.responseId !== receipt.responseId ||
        exchange.message.provider !== receipt.provider ||
        exchange.message.model !== receipt.model ||
        !safeCount(receipt.requestOrdinal) ||
        receipt.requestOrdinal !== expectedOrdinal ||
        !safeCount(exchange.message.usage.input) ||
        !safeCount(exchange.message.usage.output) ||
        !safeCount(exchange.message.usage.cacheRead) ||
        !safeCount(exchange.message.usage.cacheWrite) ||
        !safeCount(exchange.message.usage.totalTokens) ||
        exchange.message.usage.totalTokens !==
          exchange.message.usage.input +
            exchange.message.usage.output +
            exchange.message.usage.cacheRead +
            exchange.message.usage.cacheWrite ||
        receipt.cacheReadTokens !== exchange.message.usage.cacheRead ||
        receipt.cacheWriteTokens !== exchange.message.usage.cacheWrite ||
        receipt.inputTokens !==
          exchange.message.usage.input +
            exchange.message.usage.cacheRead +
            exchange.message.usage.cacheWrite ||
        receipt.outputTokens !== exchange.message.usage.output ||
        receipt.totalTokens !== exchange.message.usage.totalTokens ||
        receipt.evaluationId !== source.evaluationId ||
        receipt.streamId !== source.streamId ||
        receipt.harnessRevisionSaid !== source.harnessRevisionSaid ||
        !isDeepStrictEqual(receipt.phase, source.phase) ||
        usageEvent.detail.requestOrdinal !== receipt.requestOrdinal ||
        providerUsage.has(usageEvent.d)
      )
        return incomplete('ProviderUsage');
      let verified: Awaited<ReturnType<EvaluationMeasurementReceipts['verifyProviderUsage']>>;
      try {
        verified = await dependencies.receipts.verifyProviderUsage({
          usageEventSaid: usageEvent.d,
        });
      } catch {
        return incomplete('ProviderUsage');
      }
      if (
        verified.kind !== 'Verified' ||
        verified.usageEventSaid !== usageEvent.d ||
        verified.responseId !== receipt.responseId ||
        verified.inputTokens !== receipt.inputTokens ||
        verified.outputTokens !== receipt.outputTokens ||
        verified.spendMicroUsd !== receipt.spendMicroUsd
      )
        return incomplete('ProviderUsage');
      providerUsage.set(usageEvent.d, source.d);
      providerOrdinalByPhase.set(providerPhaseKey, expectedOrdinal + 1);
      orderedUsage.push(usageEvent.d);
    }
  }
  for (const event of events) {
    if (event.detail.kind !== 'ArtifactCaptured' || event.detail.custody !== 'Public') continue;
    const raw = await readRaw(event.detail.artifactSaid);
    if (
      raw?.kind !== 'ParentAuditOperation' ||
      !record(raw.operation) ||
      raw.operation.kind !== 'ProtectedGrading'
    )
      continue;
    const operation = raw.operation;
    if (
      !said(operation.buildCleanupReceiptSaid) ||
      !said(operation.cleanupReceiptSaid) ||
      !Array.isArray(operation.publicCleanupReceiptSaids) ||
      !operation.publicCleanupReceiptSaids.every(said)
    )
      return incomplete('ReceiptAuthority');
    const required = [
      operation.buildCleanupReceiptSaid,
      ...operation.publicCleanupReceiptSaids,
      operation.cleanupReceiptSaid,
    ];
    if (required.some((cleanup) => !finalizationCleanups.has(`${phaseKey(event)}:${cleanup}`)))
      return incomplete('MissingDimension');
  }
  if (budgets.some((budget) => !seen.has(budget))) return incomplete('MissingDimension');
  if (
    [...trialPhases].some((phase) => {
      const measured = phaseBudgets.get(phase);
      return !completedTrialPhases.has(phase) || budgets.some((budget) => !measured?.has(budget));
    })
  )
    return incomplete('MissingDimension');
  if (orderedUsage.length !== totals.providerRequests) return incomplete('ProviderUsage');
  for (const event of events) {
    if (event.detail.kind !== 'ModelExchange' && event.detail.kind !== 'ToolProposed') continue;
    const group = sourceBudgets.get(event.d);
    if (
      event.detail.kind === 'ModelExchange' &&
      providerBudgets.some((budget) => !group?.has(budget))
    )
      return incomplete('MissingDimension');
    if (event.detail.kind === 'ToolProposed' && !group?.has('toolProposals'))
      return incomplete('MissingDimension');
  }
  if (
    [...nativeProposals].some(
      (source) => !sourceBudgets.get(source)?.has('aggregateChildCommandTimeSeconds'),
    )
  )
    return incomplete('MissingDimension');
  if (
    [...noNativeCommandPhases].some((phase) => nativeCommandPhases.has(phase)) ||
    [...researchElapsedUsage].some((usage) => !providerUsage.has(usage))
  )
    return incomplete('ReceiptAuthority');
  const prepared = prepareEvaluationEvidenceEvent({
    evaluationId: head.evaluationId,
    streamId: head.streamId,
    originRunId: head.originRunId,
    taskId: head.taskId,
    taskRevisionSaid: head.taskRevisionSaid,
    personalAgentAid: head.personalAgentAid,
    taskMandateSaid: head.taskMandateSaid,
    harnessRevisionSaid: head.harnessRevisionSaid,
    phase: head.phase,
    sequence: events.length,
    previous: { kind: 'Previous', eventSaid: head.d },
    occurredAt: input.occurredAt,
    detail: {
      kind: 'EvaluationBudgetCovered',
      throughSequence: head.sequence,
      throughHeadSaid: head.d,
      totals,
      providerUsageEventSaids: orderedUsage,
    },
  });
  return prepared.kind === 'Prepared'
    ? { kind: 'Prepared', event: prepared.event }
    : incomplete('EventChain');
}
