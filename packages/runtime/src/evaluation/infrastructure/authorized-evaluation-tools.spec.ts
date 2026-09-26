import { prepareEvaluationEvidenceEvent, prepareEvaluationManifest } from '@devrandom/protocol';
import { describe, expect, it, vi } from 'vitest';
import { AcceptedProposalCapacity } from './accepted-proposal-capacity.js';
import { AuthorizedEvaluationTools } from '../application/authorized-evaluation-tools.js';
const said = (character: string): string => `E${character.repeat(43)}`;
const id = (digit: string): string =>
  `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const budget = {
  providerRequests: 2,
  providerInputTokens: 2000,
  providerOutputTokens: 200,
  providerSpendMicroUsd: 100,
  runWallTimeSeconds: 30,
  toolProposals: 2,
  aggregateChildCommandTimeSeconds: 30,
  changedFiles: 2,
  changedWorktreeBytes: 2000,
  evidencePlusArtifactsPerRunBytes: 10000,
};

function fixture(arm: 'H1' | 'C1' | 'C2' | 'C3' | 'H1TaskSearch' = 'C2') {
  const prepared = prepareEvaluationManifest({
    evaluationId: id('1'),
    taskId: id('2'),
    taskRevisionSaid: said('t'),
    originRunId: id('3'),
    ownerAid: said('o'),
    personalAgentAid: said('a'),
    taskMandateSaid: said('m'),
    retainedCheckpointSaid: said('c'),
    retainedSealSaid: said('s'),
    policySaid: said('p'),
    revisions: { H1: said('h'), C1: said('j'), C2: said('k'), C3: said('l') },
    executionProfileSaid: said('e'),
    sourceInventorySaid: said('i'),
    hypothesisSaid: said('H'),
    verifierSaid: said('v'),
    protectedCaseArtifactSaid: said('q'),
    finalCaseArtifactSaid: said('f'),
    publicConditionIds: ['cesr-current'],
    heldOutCaseCount: 1,
    allocation: { diagnosis: budget, perEntry: budget, finalization: budget },
  });
  if (prepared.kind !== 'Prepared') throw new Error('Manifest fixture invalid.');
  const manifest = prepared.manifest;
  const binding = {
    kind: 'Evaluation' as const,
    taskId: manifest.taskId,
    taskRevisionSaid: manifest.taskRevisionSaid,
    originRunId: manifest.originRunId,
    personalAgentAid: manifest.personalAgentAid,
    taskMandateSaid: manifest.taskMandateSaid,
    harnessRevisionSaid: arm === 'H1TaskSearch' ? manifest.revisions.H1 : manifest.revisions[arm],
    evaluationId: manifest.evaluationId,
    evaluationLeaseId: id('4'),
    evidenceStreamId: id('5'),
    phase: {
      kind: 'Trial' as const,
      manifestSaid: manifest.d,
      arm,
      repetition: 1 as const,
      attempt: 1 as const,
    },
  };
  const events: Extract<
    ReturnType<typeof prepareEvaluationEvidenceEvent>,
    { kind: 'Prepared' }
  >['event'][] = [];
  const append = (detail: unknown) => {
    const last = events.at(-1);
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
      previous: last === undefined ? { kind: 'Genesis' } : { kind: 'Previous', eventSaid: last.d },
      occurredAt: '2026-09-26T12:00:00.000Z',
      detail,
    });
    if (prepared.kind !== 'Prepared') throw new Error('Event fixture invalid.');
    events.push(prepared.event);
    return prepared.event.d;
  };
  const proposed = append({
    kind: 'ToolProposed',
    proposalIndex: 0,
    toolCallId: 'submit',
    inputArtifactSaid: said('i'),
  });
  const open = vi.fn().mockImplementation(() =>
    Promise.resolve({
      kind: 'Acknowledged',
      events,
      throughSequence: events.length - 1,
      headSaid: events[events.length - 1]?.d,
    }),
  );
  const capacity = new AcceptedProposalCapacity({ manifest, accepted: { open } });
  return { manifest, binding, events, append, proposed, open, capacity };
}

describe('Evaluation tool effects', () => {
  function given() {
    const trial = fixture('H1');
    const enact = vi
      .fn()
      .mockResolvedValue({ kind: 'Completed', summary: 'read', outputArtifactSaids: [] });
    const inspect = vi
      .fn()
      .mockResolvedValue({ kind: 'Held', expiresAt: '2026-09-26T13:00:00.000Z' });
    const mandate = vi
      .fn()
      .mockResolvedValue({
        kind: 'Current',
        mandateSaid: trial.binding.taskMandateSaid,
        allowedCapabilities: ['ReadRepository'],
      });
    const gateway = new AuthorizedEvaluationTools({
      manifest: trial.manifest,
      activeTools: [{ name: 'read_file', requiredCapability: 'ReadRepository' }],
      resources: { resolve: () => ({ kind: 'Resolved', resource: 'repository://src/main.rs' }) },
      mandate: { inspect: mandate },
      lease: { inspect },
      capacity: trial.capacity,
      effects: { enact },
      now: () => Date.parse('2026-09-26T12:00:00.000Z'),
    });
    const proposal = {
      piSessionId: 'pi',
      modelTurnId: 'turn',
      toolCallId: 'read',
      proposalIndex: 0,
      input: { kind: 'ReadFile' as const, path: 'src/main.rs' },
    };
    return { ...trial, enact, inspect, mandate, gateway, proposal };
  }
  it('authorizes the real Evaluation binding and never replays the same effect', async () => {
    const x = given();
    expect(
      await x.gateway.propose(x.binding, x.proposal, new AbortController().signal),
    ).toMatchObject({ kind: 'Completed' });
    expect(x.inspect).toHaveBeenCalledWith(x.binding);
    expect(await x.gateway.propose(x.binding, x.proposal, new AbortController().signal)).toEqual({
      kind: 'EvidenceIntegrityFailure',
    });
    expect(x.enact).toHaveBeenCalledTimes(1);
  });
  it('rejects mismatched evaluation revision before inspecting authority or performing an effect', async () => {
    const x = given();
    expect(
      await x.gateway.propose(
        { ...x.binding, harnessRevisionSaid: said('z') },
        x.proposal,
        new AbortController().signal,
      ),
    ).toEqual({ kind: 'EvidenceIntegrityFailure' });
    expect(x.mandate).not.toHaveBeenCalled();
    expect(x.enact).not.toHaveBeenCalled();
  });
  it('refuses an expired lease and an exhausted exact accepted capacity', async () => {
    const x = given();
    x.inspect.mockResolvedValue({ kind: 'Held', expiresAt: '2026-09-26T11:59:59.000Z' });
    expect(await x.gateway.propose(x.binding, x.proposal, new AbortController().signal)).toEqual({
      kind: 'Rejected',
      reason: 'LeaseLost',
    });
    expect(x.enact).not.toHaveBeenCalled();
    const y = given();
    y.append({
      kind: 'EvaluationBudgetDebited',
      budget: 'toolProposals',
      amount: 1,
      consumed: 1,
      receiptArtifactSaid: said('r'),
      sourceEventSaid: y.proposed,
    });
    const second = y.append({
      kind: 'ToolProposed',
      proposalIndex: 1,
      toolCallId: 'next',
      inputArtifactSaid: said('j'),
    });
    y.append({
      kind: 'EvaluationBudgetDebited',
      budget: 'toolProposals',
      amount: 1,
      consumed: 2,
      receiptArtifactSaid: said('s'),
      sourceEventSaid: second,
    });
    y.append({
      kind: 'ToolProposed',
      proposalIndex: 2,
      toolCallId: 'third',
      inputArtifactSaid: said('k'),
    });
    expect(await y.gateway.propose(y.binding, y.proposal, new AbortController().signal)).toEqual({
      kind: 'Rejected',
      reason: 'BudgetExhausted',
    });
    expect(y.enact).not.toHaveBeenCalled();
  });
});
