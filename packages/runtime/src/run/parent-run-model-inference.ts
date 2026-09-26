import type { Api, AssistantMessage, Model, TranscriptContext } from '@earendil-works/pi-ai';
import type { BaselineHarnessRevision } from '@devrandom/protocol';

import { responsesRequestBytes } from '../pi/responses-request-measurement.js';
import type { EvidenceRecorder } from '../evidence/evidence-recorder.js';
import {
  budgetTerminal,
  providerActualUsage,
  providerReservation,
  recordingTerminal,
  requestContextMeasurement,
  requestInputTokens,
  usageIsAccountable,
} from '../pi/baseline-pi-executor.js';
import type { RunResourceBudget } from './run-resource-budget.js';
import type { PiExecutionDisposition } from './run-supervisor.js';

type RunModelCompatibility = Pick<
  BaselineHarnessRevision['modelCompatibility'],
  'provider' | 'model' | 'contextWindowTokens' | 'maximumOutputTokens' | 'thinkingLevel'
>;

export interface ParentRunModelInferenceDependencies {
  readonly model: Model<Api>;
  readonly compatibility: RunModelCompatibility;
  readonly sessionId: string;
  readonly budget: Pick<RunResourceBudget, 'reserve' | 'commit' | 'release'>;
  readonly evidence: Pick<EvidenceRecorder, 'record' | 'storeArtifact'>;
  complete(context: TranscriptContext, signal: AbortSignal): Promise<AssistantMessage>;
  consumeUsage(
    message: AssistantMessage,
  ):
    | { readonly kind: 'Verified'; readonly spendMicroUsd: number }
    | { readonly kind: 'Unavailable' };
  now(): string;
}

export type RunModelCompletion =
  | {
      readonly kind: 'Completed';
      readonly message: AssistantMessage;
      readonly usageEventSaid: string;
    }
  | { readonly kind: 'Stopped'; readonly disposition: PiExecutionDisposition };

/** Parent-owned model and Run budget conversation; the OCI worker receives only the completed message. */
export class ParentRunModelInference {
  readonly #dependencies: ParentRunModelInferenceDependencies;
  #nextOrdinal = 0;

  constructor(dependencies: ParentRunModelInferenceDependencies) {
    this.#dependencies = dependencies;
  }

  async complete(
    context: TranscriptContext,
    requestOrdinal: number,
    signal: AbortSignal,
  ): Promise<RunModelCompletion> {
    const config = this.#dependencies;
    const interrupted = () => signal.aborted;
    if (
      requestOrdinal !== this.#nextOrdinal ||
      signal.aborted ||
      config.model.provider !== config.compatibility.provider ||
      config.model.id !== config.compatibility.model
    )
      return { kind: 'Stopped', disposition: { kind: 'EvidenceIntegrityFailure' } };
    this.#nextOrdinal += 1;
    let measured = requestContextMeasurement(
      context.messages,
      { modelCompatibility: config.compatibility },
      requestOrdinal,
    );
    if (measured === undefined)
      return { kind: 'Stopped', disposition: { kind: 'EvidenceIntegrityFailure' } };
    if (config.model.api === 'openai-responses' && config.model.provider === 'concentrate') {
      const bytes = await responsesRequestBytes(config.model, context, {
        maxTokens: config.compatibility.maximumOutputTokens,
        ...(config.compatibility.thinkingLevel === 'off'
          ? {}
          : { reasoning: config.compatibility.thinkingLevel }),
      });
      if (bytes === undefined || interrupted())
        return { kind: 'Stopped', disposition: { kind: 'EvidenceIntegrityFailure' } };
      measured = {
        ...measured,
        profile: 'ResponsesByteBound',
        admissionEstimateTokens: Math.max(measured.piEstimateTokens, bytes),
      };
    }

    if (measured.admissionEstimateTokens > measured.allowedInputTokens)
      return {
        kind: 'Stopped',
        disposition: { kind: 'ContextLimitReached', measurement: measured },
      };
    const inputTokens = requestInputTokens(context.messages);
    const amounts =
      inputTokens === undefined
        ? undefined
        : providerReservation(inputTokens, config.compatibility.maximumOutputTokens, config.model);
    if (amounts === undefined)
      return { kind: 'Stopped', disposition: { kind: 'EvidenceIntegrityFailure' } };
    const reserved = config.budget.reserve(amounts);
    if (reserved.kind !== 'Reserved')
      return {
        kind: 'Stopped',
        disposition:
          reserved.kind === 'Exhausted'
            ? { kind: 'BudgetExhausted' }
            : { kind: 'EvidenceIntegrityFailure' },
      };
    const modelTurnId = `${config.sessionId}:${String(requestOrdinal)}`;
    const requested = config.evidence.record({
      occurredAt: config.now(),
      producer: { kind: 'PiExecutor' },
      event: {
        kind: 'ModelRequest',
        piSessionId: config.sessionId,
        modelTurnId,
        provider: config.compatibility.provider,
        model: config.compatibility.model,
        maximumOutputTokens: config.compatibility.maximumOutputTokens,
      },
    });
    if (requested.kind !== 'Recorded') {
      config.budget.release(reserved.reservation);
      return { kind: 'Stopped', disposition: recordingTerminal(requested) };
    }
    let message: AssistantMessage;
    try {
      message = await config.complete(context, signal);
    } catch {
      const committed = config.budget.commit(reserved.reservation, {
        producer: { kind: 'PiExecutor' },
        actual: [{ budget: 'providerRequests', amount: 1 }],
      });
      return {
        kind: 'Stopped',
        disposition: budgetTerminal(committed) ?? { kind: 'ProviderUnavailable' },
      };
    }
    const usage = config.consumeUsage(message);
    if (usage.kind !== 'Verified' || !usageIsAccountable(message, usage.spendMicroUsd)) {
      const committed = config.budget.commit(reserved.reservation, {
        producer: { kind: 'PiExecutor' },
        actual: [{ budget: 'providerRequests', amount: 1 }],
      });
      return {
        kind: 'Stopped',
        disposition: budgetTerminal(committed) ?? { kind: 'ModelUsageUnavailable' },
      };
    }
    const committed = config.budget.commit(reserved.reservation, {
      producer: { kind: 'PiExecutor' },
      actual: providerActualUsage(message, usage.spendMicroUsd),
    });
    const debitFailure = budgetTerminal(committed);
    if (debitFailure !== undefined && debitFailure.kind !== 'BudgetExhausted')
      return { kind: 'Stopped', disposition: debitFailure };
    const artifact = config.evidence.storeArtifact({
      bytes: Buffer.from(JSON.stringify({ message, usageReceipt: usage }), 'utf8'),
      mediaType: 'application/json',
    });
    if (artifact.kind !== 'Stored' && artifact.kind !== 'AlreadyStored')
      return {
        kind: 'Stopped',
        disposition:
          artifact.kind === 'SecretDetected'
            ? { kind: 'SecretDetected' }
            : { kind: 'EvidenceIntegrityFailure' },
      };
    const completed = config.evidence.record({
      occurredAt: config.now(),
      producer: { kind: 'PiExecutor' },
      event: {
        kind: 'ModelMessageCompleted',
        piSessionId: config.sessionId,
        modelTurnId,
        messageArtifactSaid: artifact.artifact.d,
        disposition:
          message.stopReason === 'aborted'
            ? 'Aborted'
            : message.stopReason === 'error'
              ? 'ProviderFailure'
              : 'Completed',
        usage: {
          inputTokens: message.usage.input,
          outputTokens: message.usage.output,
          cacheReadTokens: message.usage.cacheRead,
          cacheWriteTokens: message.usage.cacheWrite,
          spendMicroUsd: usage.spendMicroUsd,
        },
      },
    });
    if (completed.kind !== 'Recorded')
      return { kind: 'Stopped', disposition: recordingTerminal(completed) };
    if (debitFailure !== undefined) return { kind: 'Stopped', disposition: debitFailure };
    if (message.stopReason === 'aborted')
      return { kind: 'Stopped', disposition: { kind: 'Aborted' } };
    if (message.stopReason === 'error')
      return { kind: 'Stopped', disposition: { kind: 'ProviderUnavailable' } };
    return { kind: 'Completed', message, usageEventSaid: completed.event.d };
  }
}
