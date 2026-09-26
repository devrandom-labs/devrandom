import { prepareEvaluationEvidenceEvent, prepareEvaluationManifest } from '@devrandom/protocol';
import { describe, expect, it, vi } from 'vitest';

import { AcceptedProposalCapacity } from './accepted-proposal-capacity.js';

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

function fixture() {
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
    harnessRevisionSaid: manifest.revisions.C2,
    evaluationId: manifest.evaluationId,
    evaluationLeaseId: id('4'),
    evidenceStreamId: id('5'),
    phase: {
      kind: 'Trial' as const,
      manifestSaid: manifest.d,
      arm: 'C2' as const,
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
  return { binding, events, append, proposed, open, capacity };
}

describe('accepted Evaluation proposal capacity', () => {
  it('allows exactly one unbilled final proposal with room in the held allocation', async () => {
    const given = fixture();
    expect(await given.capacity.inspect(given.binding)).toEqual({ kind: 'Available' });
    expect(given.open).toHaveBeenCalledWith(given.binding);
    given.append({
      kind: 'EvaluationBudgetDebited',
      budget: 'toolProposals',
      amount: 1,
      consumed: 1,
      receiptArtifactSaid: said('r'),
      sourceEventSaid: given.proposed,
    });
    expect(await given.capacity.inspect(given.binding)).toEqual({ kind: 'Unavailable' });
  });

  it('fails closed on a gap, forged debit, stale head and exhausted slot', async () => {
    const wrongStream = fixture();
    expect(
      await wrongStream.capacity.inspect({
        ...wrongStream.binding,
        evidenceStreamId: id('6'),
      }),
    ).toEqual({ kind: 'Unavailable' });

    const gap = fixture();
    const first = gap.events[0];
    if (first === undefined) throw new Error('Fixture event missing.');
    gap.open.mockResolvedValue({
      kind: 'Acknowledged',
      events: gap.events,
      throughSequence: 2,
      headSaid: first.d,
    });
    expect(await gap.capacity.inspect(gap.binding)).toEqual({ kind: 'Unavailable' });

    const forged = fixture();
    forged.append({
      kind: 'EvaluationBudgetDebited',
      budget: 'toolProposals',
      amount: 1,
      consumed: 1,
      receiptArtifactSaid: said('r'),
      sourceEventSaid: said('x'),
    });
    expect(await forged.capacity.inspect(forged.binding)).toEqual({ kind: 'Unavailable' });

    const exhausted = fixture();
    exhausted.append({
      kind: 'EvaluationBudgetDebited',
      budget: 'toolProposals',
      amount: 1,
      consumed: 1,
      receiptArtifactSaid: said('r'),
      sourceEventSaid: exhausted.proposed,
    });
    exhausted.append({
      kind: 'ToolProposed',
      proposalIndex: 1,
      toolCallId: 'edit',
      inputArtifactSaid: said('j'),
    });
    const second = exhausted.events[2]?.d;
    if (second === undefined) throw new Error('Fixture proposal missing.');
    exhausted.append({
      kind: 'EvaluationBudgetDebited',
      budget: 'toolProposals',
      amount: 1,
      consumed: 2,
      receiptArtifactSaid: said('s'),
      sourceEventSaid: second,
    });
    exhausted.append({
      kind: 'ToolProposed',
      proposalIndex: 2,
      toolCallId: 'submit',
      inputArtifactSaid: said('k'),
    });
    expect(await exhausted.capacity.inspect(exhausted.binding)).toEqual({ kind: 'Exhausted' });
  });
});
