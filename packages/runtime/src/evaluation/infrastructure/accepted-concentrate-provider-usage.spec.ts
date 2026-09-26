import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import type { EvaluationExecutionBinding } from '@devrandom/domain';
import {
  prepareEvidenceArtifact,
  prepareEvaluationEvidenceEvent,
  prepareEvaluationProviderUsageReceipt,
  type EvidenceArtifact,
  type EvaluationEvidenceEvent,
} from '@devrandom/protocol';

import { AcceptedConcentrateProviderUsage } from './accepted-concentrate-provider-usage.js';

const said = (letter: string): string => `E${letter.repeat(43)}`;

function fixture(phase?: EvaluationExecutionBinding['phase']) {
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
    phase: phase ?? {
      kind: 'Trial' as const,
      manifestSaid: said('v'),
      arm: 'H1' as const,
      repetition: 1 as const,
      attempt: 1 as const,
    },
  };
  const artifacts = new Map<string, { artifact: EvidenceArtifact; bytes: Uint8Array }>();
  const raw = (value: unknown): string => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const prepared = prepareEvidenceArtifact(bytes, 'application/json');
    if (prepared.kind !== 'Prepared') throw new Error(prepared.reason);
    artifacts.set(prepared.artifact.d, { artifact: prepared.artifact, bytes });
    return prepared.artifact.d;
  };
  const events: EvaluationEvidenceEvent[] = [];
  const append = (detail: EvaluationEvidenceEvent['detail']) => {
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
      occurredAt: '2026-09-26T12:00:00.000Z',
      detail,
    });
    if (prepared.kind !== 'Prepared') throw new Error(prepared.reason);
    events.push(prepared.event);
    return prepared.event;
  };
  const message = {
    provider: 'concentrate',
    model: 'deepinfra/deepseek-v4-flash-0731',
    responseId: 'response-1',
    usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 1, totalTokens: 16 },
    content: [],
  };
  const exchangeRaw = raw({ kind: 'ModelExchange', requestOrdinal: 0, message });
  const exchange = append({ kind: 'ModelExchange', rawArtifactSaid: exchangeRaw });
  const reportSaid = raw({
    type: 'response.completed',
    response: {
      id: message.responseId,
      model: message.model,
      cost: { total: 0.000007 },
      usage: {
        input_tokens: 14,
        output_tokens: 2,
        total_tokens: 16,
        input_tokens_details: { cached_tokens: 3, cache_write_tokens: 1 },
      },
    },
  });
  append({ kind: 'ArtifactCaptured', artifactSaid: reportSaid, custody: 'Public' });
  const preparedReceipt = prepareEvaluationProviderUsageReceipt({
    evaluationId: binding.evaluationId,
    streamId: binding.evidenceStreamId,
    harnessRevisionSaid: binding.harnessRevisionSaid,
    phase: binding.phase,
    modelExchangeEventSaid: exchange.d,
    requestOrdinal: 0,
    provider: message.provider,
    model: message.model,
    responseId: message.responseId,
    inputTokens: 14,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 1,
    totalTokens: 16,
    spendMicroUsd: 7,
    providerReportArtifactSaid: reportSaid,
  });
  if (preparedReceipt.kind !== 'Prepared') throw new Error('receipt fixture');
  artifacts.set(preparedReceipt.artifact.d, {
    artifact: preparedReceipt.artifact,
    bytes: preparedReceipt.bytes,
  });
  append({ kind: 'ArtifactCaptured', artifactSaid: preparedReceipt.artifact.d, custody: 'Public' });
  const usageEvent = append({
    kind: 'ProviderUsageVerified',
    modelExchangeEventSaid: exchange.d,
    receiptArtifactSaid: preparedReceipt.artifact.d,
    providerReportArtifactSaid: reportSaid,
    requestOrdinal: 0,
  });
  const accepted = {
    open: () =>
      Promise.resolve({
        kind: 'Acknowledged' as const,
        events,
        throughSequence: events.length - 1,
        headSaid: events.at(-1)?.d ?? '',
      }),
  };
  const openPublic = (input: { artifactSaid: string }) => {
    const artifact = artifacts.get(input.artifactSaid);
    return Promise.resolve(
      artifact === undefined
        ? { kind: 'Missing' as const }
        : { kind: 'Opened' as const, ...artifact },
    );
  };
  return { binding, artifacts, events, accepted, openPublic, usageEvent, reportSaid };
}

describe('accepted Concentrate provider usage replay', () => {
  it.each(['Trial', 'Research'] as const)(
    'verifies %s source, exact raw terminal report, and charge after reopening accepted custody',
    async (kind) => {
      const given = fixture(
        kind === 'Research'
          ? { kind: 'Research', policySaid: said('p'), role: 'DiagnosticRefiner' }
          : undefined,
      );
      const first = new AcceptedConcentrateProviderUsage(given);
      const second = new AcceptedConcentrateProviderUsage(given);
      const expected = {
        kind: 'Verified',
        usageEventSaid: given.usageEvent.d,
        responseId: 'response-1',
        inputTokens: 14,
        outputTokens: 2,
        spendMicroUsd: 7,
      };
      expect(await first.verifyProviderUsage({ usageEventSaid: given.usageEvent.d })).toEqual(
        expected,
      );
      expect(await second.verifyProviderUsage({ usageEventSaid: given.usageEvent.d })).toEqual(
        expected,
      );
    },
  );

  it('fails closed on missing event or substituted exact provider bytes', async () => {
    const given = fixture();
    const verifier = new AcceptedConcentrateProviderUsage(given);
    expect(await verifier.verifyProviderUsage({ usageEventSaid: said('x') })).toEqual({
      kind: 'Missing',
    });
    const original = given.artifacts.get(given.reportSaid);
    if (original === undefined) throw new Error('report fixture missing');
    given.artifacts.set(given.reportSaid, {
      artifact: original.artifact,
      bytes: new TextEncoder().encode('{"type":"response.completed","response":{"id":"forged"}}'),
    });
    expect(await verifier.verifyProviderUsage({ usageEventSaid: given.usageEvent.d })).toEqual({
      kind: 'Missing',
    });
  });
});
