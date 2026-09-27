import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { prepareEvidenceArtifact, type EvaluationEvidenceEvent } from '@devrandom/protocol';
import type { EvaluationModelInference, EvaluationEvidence } from '@devrandom/runtime';
import {
  PiResearchProposal,
  decodeResearchProposalOutput,
  type ResearchProposalInput,
} from './pi-research-proposal.js';
const said = (letter: string) => `E${letter.repeat(43)}`;
function fixture() {
  const input: ResearchProposalInput = {
    binding: {
      kind: 'Evaluation',
      evaluationId: randomUUID(),
      evaluationLeaseId: randomUUID(),
      evidenceStreamId: randomUUID(),
      originRunId: randomUUID(),
      taskId: randomUUID(),
      taskRevisionSaid: said('t'),
      personalAgentAid: said('a'),
      taskMandateSaid: said('m'),
      harnessRevisionSaid: said('h'),
      phase: { kind: 'Research', policySaid: said('p'), role: 'DiagnosticRefiner' },
    },
    requestOrdinal: 0,
    modelProfileSaid: said('e'),
    maximumOutputTokens: 100,
    context: {
      messages: [
        {
          role: 'user',
          content: 'Propose a hypothesis from the supplied public evidence.',
          timestamp: 0,
        },
      ],
    } as ResearchProposalInput['context'],
    signal: new AbortController().signal,
    position: { nextSequence: 0, chainHeadSaid: null },
    consumed: {
      providerRequests: 0,
      providerInputTokens: 0,
      providerOutputTokens: 0,
      providerSpendMicroUsd: 0,
      runWallTimeSeconds: 0,
    },
  };
  const complete = vi.fn<EvaluationModelInference['complete']>(() =>
    Promise.resolve({
      kind: 'Completed',
      verifiedSpendMicroUsd: 1,
      providerReportBytes: Buffer.from(
        JSON.stringify({
          type: 'response.completed',
          response: {
            id: 'r1',
            model: 'test',
            cost: { total: 0.000001 },
            usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
          },
        }),
      ),
      message: {
        role: 'assistant',
        api: 'openai-responses',
        provider: 'concentrate',
        model: 'test',
        responseId: 'r1',
        content: [
          { type: 'text', text: '{"hypothesis":"Check version scope at each group boundary"}' },
        ],
        usage: {
          input: 10,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 12,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.000001 },
        },
        stopReason: 'stop',
        timestamp: 0,
      },
    }),
  );
  const events: EvaluationEvidenceEvent[] = [];
  const record = vi.fn<EvaluationEvidence['record']>((event: EvaluationEvidenceEvent) => {
    events.push(event);
    return Promise.resolve({
      kind: 'Recorded' as const,
      sequence: event.sequence,
      headSaid: event.d,
    });
  });
  const proposal = new PiResearchProposal({
    inference: { complete },
    evidence: { record, acknowledge: () => Promise.resolve({ kind: 'Unavailable' }) },
    artifacts: {
      record: (input) => {
        const prepared = prepareEvidenceArtifact(input.bytes, input.mediaType);
        if (prepared.kind !== 'Prepared') throw new Error('fixture');
        return Promise.resolve({ kind: 'Stored', artifact: prepared.artifact });
      },
    },
    now: () => '2026-09-26T15:00:00.000Z',
  });
  return { input, complete, events, proposal, record };
}
it('releases proposed JSON only after the actual model exchange and provider report are acknowledged', async () => {
  const f = fixture();
  const result = await f.proposal.propose(f.input);
  expect(result).toMatchObject({
    kind: 'Proposed',
    document: { hypothesis: 'Check version scope at each group boundary' },
  });
  expect(f.events.map((event) => event.detail.kind)).toEqual([
    'ModelExchange',
    'ArtifactCaptured',
    'ArtifactCaptured',
    'ProviderUsageVerified',
    'EvaluationBudgetDebited',
    'EvaluationBudgetDebited',
    'EvaluationBudgetDebited',
    'EvaluationBudgetDebited',
    'ArtifactCaptured',
    'EvaluationBudgetDebited',
  ]);
  expect(f.events.every((event) => event.phase.kind === 'Research')).toBe(true);
});
it('does not spend a provider request for an evaluation trial masquerading as research', async () => {
  const f = fixture();
  const input: ResearchProposalInput = {
    ...f.input,
    binding: {
      ...f.input.binding,
      phase: { kind: 'Trial', manifestSaid: said('v'), arm: 'H1', repetition: 1, attempt: 1 },
    },
  };
  expect(await f.proposal.propose(input)).toEqual({ kind: 'Rejected', reason: 'Binding' });
  expect(f.complete).not.toHaveBeenCalled();
});
it('does not release an unacknowledged proposal', async () => {
  const f = fixture();
  f.record.mockImplementationOnce(() => Promise.resolve({ kind: 'Unavailable' }));
  expect(await f.proposal.propose(f.input)).toEqual({ kind: 'Rejected', reason: 'Evidence' });
});
it('rejects corrupt prior consumption before spending another paid request', async () => {
  const f = fixture();
  expect(
    await f.proposal.propose({
      ...f.input,
      consumed: { ...f.input.consumed, providerRequests: -1 },
    }),
  ).toEqual({ kind: 'Rejected', reason: 'Binding' });
  expect(f.complete).not.toHaveBeenCalled();
});

it.each(['length', 'toolUse', 'error', 'aborted'] as const)(
  'never admits retained JSON rejected on its first %s response',
  async (stopReason) => {
    const f = fixture();
    const completed = await f.complete(f.input);
    if (completed.kind !== 'Completed') throw new Error('completion fixture');
    const message = { ...completed.message, stopReason };
    f.complete.mockResolvedValue({ ...completed, message });
    expect(await f.proposal.propose(f.input)).toEqual({ kind: 'Rejected', reason: 'Output' });
    expect(f.events.some(({ detail }) => detail.kind === 'ProviderUsageVerified')).toBe(true);
    expect(f.events.filter(({ detail }) => detail.kind === 'EvaluationBudgetDebited')).toHaveLength(
      5,
    );
    expect(decodeResearchProposalOutput(message)).toEqual({ kind: 'Rejected' });
  },
);

it.each(['toolCall', 'oversized', 'malformed'] as const)(
  'applies the same %s rejection to fresh and retained Research output without erasing usage',
  async (variant) => {
    const f = fixture();
    const completed = await f.complete(f.input);
    if (completed.kind !== 'Completed') throw new Error('completion fixture');
    const message = {
      ...completed.message,
      content:
        variant === 'toolCall'
          ? [
              ...completed.message.content,
              { type: 'toolCall' as const, id: 'call-1', name: 'run_tests', arguments: {} },
            ]
          : [
              {
                type: 'text' as const,
                text:
                  variant === 'oversized' ? JSON.stringify({ text: 'é'.repeat(17 * 1024) }) : '{',
              },
            ],
    };
    f.complete.mockResolvedValue({ ...completed, message });
    expect(await f.proposal.propose(f.input)).toEqual({ kind: 'Rejected', reason: 'Output' });
    expect(decodeResearchProposalOutput(message)).toEqual({ kind: 'Rejected' });
    expect(f.events.filter(({ detail }) => detail.kind === 'EvaluationBudgetDebited')).toHaveLength(
      5,
    );
  },
);
it('releases the identical complete proposal from fresh and retained output while ignoring reasoning text', async () => {
  const f = fixture();
  const completed = await f.complete(f.input);
  if (completed.kind !== 'Completed') throw new Error('completion fixture');
  const message = {
    ...completed.message,
    content: [
      { type: 'thinking' as const, thinking: 'Not proposal JSON' },
      ...completed.message.content,
    ],
  };
  f.complete.mockResolvedValue({ ...completed, message });
  const fresh = await f.proposal.propose(f.input);
  expect(fresh.kind).toBe('Proposed');
  if (fresh.kind !== 'Proposed') throw new Error('proposal fixture');
  expect(decodeResearchProposalOutput(message)).toEqual({
    kind: 'Accepted',
    document: fresh.document,
  });
  for (const malformed of [
    null,
    {},
    { ...message, role: 'user' },
    { ...message, content: [{ type: 'text', text: 7 }] },
  ])
    expect(decodeResearchProposalOutput(malformed)).toEqual({ kind: 'Rejected' });
});
