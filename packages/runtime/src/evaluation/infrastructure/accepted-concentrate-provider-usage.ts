import { isDeepStrictEqual } from 'node:util';

import { validateExecutionBinding, type EvaluationExecutionBinding } from '@devrandom/domain';
import {
  decodeEvidenceArtifact,
  decodeEvaluationEvidenceEvent,
  decodeEvaluationProviderUsageReceipt,
  type EvaluationEvidenceEvent,
} from '@devrandom/protocol';

import type {
  EvaluationAcceptedPrefix,
  EvaluationMeasurementReceipts,
} from '../application/prepare-evaluation-budget-coverage.js';
import { inspectConcentrateProviderReport } from './concentrate-provider-report.js';

interface ParentEvidence {
  readonly binding: EvaluationExecutionBinding;
  readonly accepted: EvaluationAcceptedPrefix;
  readonly openPublic: EvaluationMeasurementReceipts['openPublic'];
}

type Verification = Awaited<ReturnType<EvaluationMeasurementReceipts['verifyProviderUsage']>>;
type PublicRead = Awaited<ReturnType<EvaluationMeasurementReceipts['openPublic']>>;

function record(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function sameIdentity(
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

function sameTrial(event: EvaluationEvidenceEvent, binding: EvaluationExecutionBinding): boolean {
  return (
    event.harnessRevisionSaid === binding.harnessRevisionSaid &&
    isDeepStrictEqual(event.phase, binding.phase)
  );
}

function capturedBefore(
  events: readonly EvaluationEvidenceEvent[],
  artifactSaid: string,
  source: EvaluationEvidenceEvent,
  usage: EvaluationEvidenceEvent,
): boolean {
  return events.some(
    (event) =>
      event.detail.kind === 'ArtifactCaptured' &&
      event.detail.custody === 'Public' &&
      event.detail.artifactSaid === artifactSaid &&
      event.sequence > source.sequence &&
      event.sequence < usage.sequence &&
      event.harnessRevisionSaid === source.harnessRevisionSaid &&
      isDeepStrictEqual(event.phase, source.phase),
  );
}

/** Replays accepted Evaluation evidence and exact raw provider bytes after process loss. */
export class AcceptedConcentrateProviderUsage {
  readonly #parent: ParentEvidence;

  constructor(parent: ParentEvidence) {
    this.#parent = parent;
  }

  async #open(artifactSaid: string): Promise<PublicRead> {
    return this.#parent.openPublic({
      evaluationId: this.#parent.binding.evaluationId,
      artifactSaid,
    });
  }

  async verifyProviderUsage(input: { readonly usageEventSaid: string }): Promise<Verification> {
    const { binding, accepted } = this.#parent;
    if (validateExecutionBinding(binding).kind !== 'Accepted') return { kind: 'Missing' };
    try {
      const prefix = await accepted.open(binding);
      if (prefix.kind !== 'Acknowledged') return prefix;
      const events = prefix.events;
      if (
        events.length === 0 ||
        events.length > 10_000 ||
        prefix.throughSequence !== events.length - 1 ||
        prefix.headSaid !== events.at(-1)?.d
      )
        return { kind: 'Missing' };
      for (const [index, event] of events.entries()) {
        const predecessor = events[index - 1];
        if (
          decodeEvaluationEvidenceEvent(event).kind !== 'Accepted' ||
          event.sequence !== index ||
          !sameIdentity(event, binding) ||
          (index === 0
            ? event.previous.kind !== 'Genesis'
            : event.previous.kind !== 'Previous' || event.previous.eventSaid !== predecessor?.d)
        )
          return { kind: 'Missing' };
      }
      const usage = events.find((event) => event.d === input.usageEventSaid);
      if (usage?.detail.kind !== 'ProviderUsageVerified' || !sameTrial(usage, binding))
        return { kind: 'Missing' };
      const detail = usage.detail;
      const source = events.find((event) => event.d === detail.modelExchangeEventSaid);
      if (
        source?.detail.kind !== 'ModelExchange' ||
        !sameTrial(source, binding) ||
        source.sequence >= usage.sequence ||
        events.filter(
          (event) =>
            event.detail.kind === 'ProviderUsageVerified' &&
            event.detail.modelExchangeEventSaid === source.d,
        ).length !== 1 ||
        !capturedBefore(events, detail.receiptArtifactSaid, source, usage) ||
        !capturedBefore(events, detail.providerReportArtifactSaid, source, usage)
      )
        return { kind: 'Missing' };
      const receiptRead = await this.#open(detail.receiptArtifactSaid);
      if (receiptRead.kind !== 'Opened') return receiptRead;
      const decoded = decodeEvaluationProviderUsageReceipt(receiptRead.artifact, receiptRead.bytes);
      if (decoded.kind !== 'Accepted') return { kind: 'Missing' };
      const receipt = decoded.receipt;
      if (
        receipt.evaluationId !== binding.evaluationId ||
        receipt.streamId !== binding.evidenceStreamId ||
        receipt.harnessRevisionSaid !== binding.harnessRevisionSaid ||
        !isDeepStrictEqual(receipt.phase, binding.phase) ||
        receipt.modelExchangeEventSaid !== source.d ||
        receipt.requestOrdinal !== detail.requestOrdinal ||
        receipt.providerReportArtifactSaid !== detail.providerReportArtifactSaid
      )
        return { kind: 'Missing' };
      const reportRead = await this.#open(detail.providerReportArtifactSaid);
      const exchangeRead = await this.#open(source.detail.rawArtifactSaid);
      if (reportRead.kind !== 'Opened') return reportRead;
      if (exchangeRead.kind !== 'Opened') return exchangeRead;
      if (
        decodeEvidenceArtifact(reportRead.artifact, reportRead.bytes).kind !== 'Accepted' ||
        decodeEvidenceArtifact(exchangeRead.artifact, exchangeRead.bytes).kind !== 'Accepted' ||
        reportRead.artifact.mediaType !== 'application/json' ||
        exchangeRead.artifact.mediaType !== 'application/json'
      )
        return { kind: 'Missing' };
      const exchange: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(exchangeRead.bytes),
      );
      if (
        !record(exchange) ||
        exchange.kind !== 'ModelExchange' ||
        exchange.requestOrdinal !== receipt.requestOrdinal ||
        !record(exchange.message)
      )
        return { kind: 'Missing' };
      const message = exchange.message;
      const messageUsage = message.usage;
      if (
        typeof message.provider !== 'string' ||
        typeof message.model !== 'string' ||
        typeof message.responseId !== 'string' ||
        !record(messageUsage) ||
        !count(messageUsage.input) ||
        !count(messageUsage.output) ||
        !count(messageUsage.cacheRead) ||
        !count(messageUsage.cacheWrite) ||
        !count(messageUsage.totalTokens)
      )
        return { kind: 'Missing' };
      const report = inspectConcentrateProviderReport(reportRead.bytes, {
        provider: message.provider,
        model: message.model,
        responseId: message.responseId,
        usage: {
          input: messageUsage.input,
          output: messageUsage.output,
          cacheRead: messageUsage.cacheRead,
          cacheWrite: messageUsage.cacheWrite,
          totalTokens: messageUsage.totalTokens,
        },
      });
      if (
        report.kind !== 'Verified' ||
        receipt.provider !== message.provider ||
        receipt.model !== message.model ||
        receipt.responseId !== report.responseId ||
        receipt.inputTokens !== report.inputTokens ||
        receipt.outputTokens !== report.outputTokens ||
        receipt.cacheReadTokens !== report.cacheReadTokens ||
        receipt.cacheWriteTokens !== report.cacheWriteTokens ||
        receipt.totalTokens !== report.totalTokens ||
        receipt.spendMicroUsd !== report.spendMicroUsd
      )
        return { kind: 'Missing' };
      return {
        kind: 'Verified',
        usageEventSaid: usage.d,
        responseId: report.responseId,
        inputTokens: report.inputTokens,
        outputTokens: report.outputTokens,
        spendMicroUsd: report.spendMicroUsd,
      };
    } catch {
      return { kind: 'Unavailable' };
    }
  }
}
