import { validateExecutionBinding } from '@devrandom/domain';
import { prepareEvidenceArtifact, type EvaluationExecutionProfile } from '@devrandom/protocol';
import type { AssistantMessage } from '@earendil-works/pi-ai';

import {
  providerReservation,
  requestInputTokens,
  type PiModelOpening,
} from '../../pi/baseline-pi-executor.js';
import type {
  EvaluationLease,
  EvaluationModelInference,
  EvaluationProviderAllowance,
} from '../application/evaluation-conversations.js';
import { inspectConcentrateProviderReport } from './concentrate-provider-report.js';

type OpenedModel = Extract<PiModelOpening, { readonly kind: 'Opened' }> & {
  consumeProviderReport: NonNullable<
    Extract<PiModelOpening, { readonly kind: 'Opened' }>['consumeProviderReport']
  >;
};
type TrialProfile = Pick<
  EvaluationExecutionProfile,
  'd' | 'modelProvider' | 'modelId' | 'maximumOutputTokens' | 'thinkingLevel'
>;

interface Configuration {
  readonly profile: TrialProfile;
  readonly opened: OpenedModel;
  readonly lease: EvaluationLease;
  readonly allowance: EvaluationProviderAllowance;
  readonly startingOrdinal?: number;
}

function thinkingLevel(
  level: string,
): 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined {
  return ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(level)
    ? (level as 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max')
    : undefined;
}

function interrupted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function reservationMaximum(
  context: Parameters<EvaluationModelInference['complete']>[0]['context'],
  outputTokens: number,
  model: OpenedModel['model'],
):
  | {
      readonly providerRequests: 1;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly spendMicroUsd: number;
    }
  | undefined {
  try {
    const estimated = requestInputTokens(context.messages);
    const encoded = new TextEncoder().encode(JSON.stringify(context)).byteLength;
    const inputTokens = estimated === undefined ? undefined : Math.max(estimated, encoded);
    if (inputTokens === undefined || inputTokens < 1 || !Number.isSafeInteger(inputTokens))
      return undefined;
    if (inputTokens > model.contextWindow - outputTokens) return undefined;
    const amounts = providerReservation(inputTokens, outputTokens, model);
    if (amounts === undefined) return undefined;
    const spendMicroUsd =
      amounts.find((amount) => amount.budget === 'providerSpendMicroUsd')?.amount ?? 0;
    return { providerRequests: 1, inputTokens, outputTokens, spendMicroUsd };
  } catch {
    return undefined;
  }
}

/** Trusted-parent adapter: no provider effect precedes current lease and reserved Evaluation capacity. */
export class ParentConcentrateEvaluationInference implements EvaluationModelInference {
  readonly #configuration: Configuration;
  #nextOrdinal: number;
  #inFlight = false;

  constructor(configuration: Configuration) {
    this.#configuration = configuration;
    this.#nextOrdinal = configuration.startingOrdinal ?? 0;
  }

  async complete(
    input: Parameters<EvaluationModelInference['complete']>[0],
  ): ReturnType<EvaluationModelInference['complete']> {
    if (this.#inFlight) return { kind: 'Unavailable' };
    this.#inFlight = true;
    try {
      return await this.#complete(input);
    } finally {
      this.#inFlight = false;
    }
  }

  async #complete(
    input: Parameters<EvaluationModelInference['complete']>[0],
  ): ReturnType<EvaluationModelInference['complete']> {
    const { profile, opened, lease, allowance } = this.#configuration;
    if (input.signal.aborted) return { kind: 'Interrupted' };
    if (
      !Number.isSafeInteger(this.#nextOrdinal) ||
      this.#nextOrdinal < 0 ||
      input.requestOrdinal !== this.#nextOrdinal ||
      validateExecutionBinding(input.binding).kind !== 'Accepted' ||
      input.binding.phase.kind !== 'Trial' ||
      input.modelProfileSaid !== profile.d ||
      input.maximumOutputTokens !== profile.maximumOutputTokens ||
      opened.model.provider !== 'concentrate' ||
      opened.model.provider !== profile.modelProvider ||
      opened.model.id !== profile.modelId ||
      opened.model.maxTokens < profile.maximumOutputTokens ||
      (profile.thinkingLevel !== 'off' && thinkingLevel(profile.thinkingLevel) === undefined)
    )
      return { kind: 'Unavailable' };
    let held: Awaited<ReturnType<EvaluationLease['inspect']>>;
    try {
      held = await lease.inspect(input.binding);
    } catch {
      return { kind: 'Unavailable' };
    }
    if (held.kind !== 'Held') return { kind: held.kind === 'Lost' ? 'LeaseLost' : 'Unavailable' };
    const maximum = reservationMaximum(input.context, input.maximumOutputTokens, opened.model);
    if (maximum === undefined) return { kind: 'BudgetExhausted' };
    let reserved: Awaited<ReturnType<EvaluationProviderAllowance['reserve']>>;
    try {
      reserved = await allowance.reserve({
        binding: input.binding,
        requestOrdinal: input.requestOrdinal,
        maximum,
      });
    } catch {
      return { kind: 'Unavailable' };
    }
    if (reserved.kind !== 'Reserved')
      return { kind: reserved.kind === 'Exhausted' ? 'BudgetExhausted' : 'Unavailable' };
    this.#nextOrdinal += 1;
    const record = async (
      usage: Parameters<EvaluationProviderAllowance['record']>[0]['usage'],
    ): Promise<Awaited<ReturnType<EvaluationProviderAllowance['record']>>> => {
      try {
        return await allowance.record({ reservationId: reserved.reservationId, usage });
      } catch {
        return { kind: 'Unavailable' };
      }
    };
    let message: AssistantMessage;
    try {
      const reasoning = thinkingLevel(profile.thinkingLevel);
      message = await opened.runtime.completeSimple(opened.model, input.context, {
        maxTokens: input.maximumOutputTokens,
        ...(reasoning === undefined ? {} : { reasoning }),
        signal: input.signal,
        maxRetries: 0,
      });
    } catch {
      await record({ kind: 'Unresolved' });
      return { kind: interrupted(input.signal) ? 'Interrupted' : 'Unavailable' };
    }
    const observed = opened.consumeProviderReport(message);
    if (observed.kind !== 'Verified') {
      await record({ kind: 'Unresolved' });
      return { kind: 'UnknownUsage' };
    }
    const providerReportBytes = Uint8Array.from(observed.providerReportBytes);
    const inspected = inspectConcentrateProviderReport(providerReportBytes, message);
    if (inspected.kind !== 'Verified' || inspected.spendMicroUsd !== observed.spendMicroUsd) {
      await record({ kind: 'Unresolved' });
      return { kind: 'UnknownUsage' };
    }
    const report = prepareEvidenceArtifact(providerReportBytes, 'application/json');
    if (report.kind !== 'Prepared') {
      await record({ kind: 'Unresolved' });
      return { kind: 'UnknownUsage' };
    }
    const settled = await record({
      kind: 'Verified',
      providerRequests: 1,
      inputTokens: inspected.inputTokens,
      outputTokens: inspected.outputTokens,
      spendMicroUsd: inspected.spendMicroUsd,
      responseId: inspected.responseId,
      providerReportArtifactSaid: report.artifact.d,
    });
    if (settled.kind !== 'Recorded')
      return { kind: settled.kind === 'Exhausted' ? 'BudgetExhausted' : 'Unavailable' };
    if (interrupted(input.signal) || message.stopReason === 'aborted')
      return { kind: 'Interrupted' };
    if (message.stopReason === 'error') return { kind: 'Unavailable' };
    try {
      held = await lease.inspect(input.binding);
    } catch {
      return { kind: 'Unavailable' };
    }
    if (held.kind !== 'Held') return { kind: held.kind === 'Lost' ? 'LeaseLost' : 'Unavailable' };
    return {
      kind: 'Completed',
      message,
      verifiedSpendMicroUsd: inspected.spendMicroUsd,
      providerReportBytes,
    };
  }
}
