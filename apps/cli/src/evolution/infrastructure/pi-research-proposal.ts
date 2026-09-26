import type { EvaluationAllowance } from '@devrandom/domain';
import {
  decodeEvaluationExecutionBinding,
  prepareEvidenceArtifact,
  prepareEvaluationEvidenceEvent,
  prepareEvaluationProviderUsageReceipt,
  type EvaluationEvidenceEvent,
} from '@devrandom/protocol';
import {
  inspectConcentrateProviderReport,
  type EvaluationEvidence,
  type EvaluationModelInference,
  type EvaluationRawArtifacts,
} from '@devrandom/runtime';

type ResearchConsumption = Pick<
  EvaluationAllowance,
  | 'providerRequests'
  | 'providerInputTokens'
  | 'providerOutputTokens'
  | 'providerSpendMicroUsd'
  | 'runWallTimeSeconds'
>;
type InferenceInput = Parameters<EvaluationModelInference['complete']>[0];
export interface ResearchProposalInput extends InferenceInput {
  readonly consumed: ResearchConsumption;
  readonly position: { readonly nextSequence: number; readonly chainHeadSaid: string | null };
}
export type ResearchProposal =
  | {
      readonly kind: 'Proposed';
      readonly document: unknown;
      readonly exchangeEventSaid: string;
      readonly usageEventSaid: string;
      readonly nextSequence: number;
      readonly headSaid: string;
      readonly consumed: ResearchConsumption;
    }
  | { readonly kind: 'Rejected'; readonly reason: 'Binding' | 'Usage' | 'Output' | 'Evidence' }
  | Exclude<Awaited<ReturnType<EvaluationModelInference['complete']>>, { kind: 'Completed' }>;

/** The Pi edge proposes JSON; only parent-verified usage and durable raw evidence can release it. */
export class PiResearchProposal {
  readonly #ports: {
    readonly inference: EvaluationModelInference;
    readonly evidence: EvaluationEvidence;
    readonly artifacts: EvaluationRawArtifacts;
    now(): string;
  };
  constructor(ports: {
    readonly inference: EvaluationModelInference;
    readonly evidence: EvaluationEvidence;
    readonly artifacts: EvaluationRawArtifacts;
    now(): string;
  }) {
    this.#ports = ports;
  }

  async propose(input: ResearchProposalInput): Promise<ResearchProposal> {
    const { binding } = input;
    const consumed = { ...input.consumed };
    const startedMonotonicMicroseconds = Math.floor(performance.now() * 1000);
    if (
      decodeEvaluationExecutionBinding(binding).kind !== 'Accepted' ||
      binding.phase.kind !== 'Research'
    )
      return { kind: 'Rejected', reason: 'Binding' };
    let sequence = input.position.nextSequence;
    let head = input.position.chainHeadSaid;
    if (!Number.isSafeInteger(sequence) || sequence < 0 || (sequence === 0) !== (head === null))
      return { kind: 'Rejected', reason: 'Binding' };
    const raw = async (bytes: Uint8Array): Promise<string> => {
      const identified = prepareEvidenceArtifact(bytes, 'application/json');
      if (identified.kind !== 'Prepared') throw new Error('Research artifact rejected');
      const stored = await this.#ports.artifacts.record({ bytes, mediaType: 'application/json' });
      if (stored.kind !== 'Stored' || stored.artifact.d !== identified.artifact.d)
        throw new Error('Research artifact unavailable');
      return stored.artifact.d;
    };
    const append = async (detail: EvaluationEvidenceEvent['detail']): Promise<string> => {
      const event = prepareEvaluationEvidenceEvent({
        evaluationId: binding.evaluationId,
        streamId: binding.evidenceStreamId,
        originRunId: binding.originRunId,
        taskId: binding.taskId,
        taskRevisionSaid: binding.taskRevisionSaid,
        personalAgentAid: binding.personalAgentAid,
        taskMandateSaid: binding.taskMandateSaid,
        harnessRevisionSaid: binding.harnessRevisionSaid,
        phase: binding.phase,
        sequence,
        previous: head === null ? { kind: 'Genesis' } : { kind: 'Previous', eventSaid: head },
        occurredAt: this.#ports.now(),
        detail,
      });
      if (event.kind !== 'Prepared') throw new Error('Research event invalid');
      const ack = await this.#ports.evidence.record(event.event);
      if (ack.kind !== 'Recorded' || ack.sequence !== sequence || ack.headSaid !== event.event.d)
        throw new Error('Research evidence unacknowledged');
      sequence++;
      head = event.event.d;
      return head;
    };
    try {
      const completed = await this.#ports.inference.complete(input);
      if (completed.kind !== 'Completed') return completed;
      const message = completed.message;
      const report = inspectConcentrateProviderReport(completed.providerReportBytes, message);
      if (report.kind !== 'Verified' || report.spendMicroUsd !== completed.verifiedSpendMicroUsd)
        return { kind: 'Rejected', reason: 'Usage' };
      const exchange = await raw(
        Buffer.from(
          JSON.stringify({
            kind: 'ModelExchange',
            requestOrdinal: input.requestOrdinal,
            context: input.context,
            message,
          }),
        ),
      );
      const exchangeEventSaid = await append({ kind: 'ModelExchange', rawArtifactSaid: exchange });
      const reportSaid = await raw(completed.providerReportBytes);
      await append({ kind: 'ArtifactCaptured', artifactSaid: reportSaid, custody: 'Public' });
      const receipt = prepareEvaluationProviderUsageReceipt({
        evaluationId: binding.evaluationId,
        streamId: binding.evidenceStreamId,
        harnessRevisionSaid: binding.harnessRevisionSaid,
        phase: binding.phase,
        modelExchangeEventSaid: exchangeEventSaid,
        requestOrdinal: input.requestOrdinal,
        provider: message.provider,
        model: message.model,
        responseId: message.responseId,
        inputTokens: report.inputTokens,
        outputTokens: report.outputTokens,
        cacheReadTokens: report.cacheReadTokens,
        cacheWriteTokens: report.cacheWriteTokens,
        totalTokens: report.totalTokens,
        spendMicroUsd: report.spendMicroUsd,
        providerReportArtifactSaid: reportSaid,
      });
      if (receipt.kind !== 'Prepared') return { kind: 'Rejected', reason: 'Usage' };
      const receiptSaid = await raw(receipt.bytes);
      await append({ kind: 'ArtifactCaptured', artifactSaid: receiptSaid, custody: 'Public' });
      const usageEventSaid = await append({
        kind: 'ProviderUsageVerified',
        modelExchangeEventSaid: exchangeEventSaid,
        receiptArtifactSaid: receiptSaid,
        providerReportArtifactSaid: reportSaid,
        requestOrdinal: input.requestOrdinal,
      });
      for (const [budget, amount] of [
        ['providerRequests', 1],
        ['providerInputTokens', report.inputTokens],
        ['providerOutputTokens', report.outputTokens],
        ['providerSpendMicroUsd', report.spendMicroUsd],
      ] as const) {
        consumed[budget] += amount;
        await append({
          kind: 'EvaluationBudgetDebited',
          budget,
          amount,
          consumed: consumed[budget],
          receiptArtifactSaid: receiptSaid,
          sourceEventSaid: exchangeEventSaid,
        });
      }
      const finishedMonotonicMicroseconds = Math.floor(performance.now() * 1000);
      const elapsedMilliseconds = Math.ceil(
        (finishedMonotonicMicroseconds - startedMonotonicMicroseconds) / 1000,
      );
      const debitedSeconds = Math.max(1, Math.ceil(elapsedMilliseconds / 1000));
      const wallSaid = await raw(
        Buffer.from(
          JSON.stringify({
            kind: 'EvaluationResearchElapsed',
            method: 'ParentMonotonicResearch',
            evaluationId: binding.evaluationId,
            streamId: binding.evidenceStreamId,
            harnessRevisionSaid: binding.harnessRevisionSaid,
            phase: binding.phase,
            usageEventSaid,
            startedMonotonicMicroseconds,
            finishedMonotonicMicroseconds,
            elapsedMilliseconds,
            debitedSeconds,
          }),
        ),
      );
      await append({ kind: 'ArtifactCaptured', artifactSaid: wallSaid, custody: 'Public' });
      consumed.runWallTimeSeconds += debitedSeconds;
      const finalHead = await append({
        kind: 'EvaluationBudgetDebited',
        budget: 'runWallTimeSeconds',
        amount: debitedSeconds,
        consumed: consumed.runWallTimeSeconds,
        receiptArtifactSaid: wallSaid,
        sourceEventSaid: usageEventSaid,
      });
      if (input.signal.aborted) return { kind: 'Interrupted' };
      if (message.stopReason !== 'stop' || message.content.some((item) => item.type === 'toolCall'))
        return { kind: 'Rejected', reason: 'Output' };
      const text = message.content
        .filter((item) => item.type === 'text')
        .map((item) => item.text)
        .join('\n')
        .trim();
      if (Buffer.byteLength(text) > 32 * 1024) return { kind: 'Rejected', reason: 'Output' };
      try {
        return {
          kind: 'Proposed',
          document: JSON.parse(text),
          exchangeEventSaid,
          usageEventSaid,
          nextSequence: sequence,
          headSaid: finalHead,
          consumed,
        };
      } catch {
        return { kind: 'Rejected', reason: 'Output' };
      }
    } catch {
      return { kind: 'Rejected', reason: 'Evidence' };
    }
  }
}
