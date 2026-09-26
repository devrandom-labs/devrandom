import { describe, expect, it, vi } from 'vitest';

import { prepareEvaluationSourceInventory, prepareEvolutionHypothesis } from '@devrandom/protocol';

import { reviewEvolutionHypothesisInfluence } from './hypothesis-influence.js';

const said = (letter: string): string => `E${letter.repeat(43)}`;
const taskId = '123e4567-e89b-42d3-a456-426614174000';
const runId = '123e4567-e89b-42d3-a456-426614174001';
const ownerAid = said('o');
const episodeSaid = said('e');
const rawEvidenceSaid = said('r');
const preparedInventory = prepareEvaluationSourceInventory({
  taskId,
  taskRevisionSaid: said('t'),
  ownerAid,
  repositoryResourceSaid: said('g'),
  corpusSaid: said('c'),
  experienceMandateSaid: said('m'),
  sources: [
    {
      episodeSaid,
      rawEvidenceSaid,
      ownerAid,
      repositoryResourceSaid: said('g'),
      corpusSaid: said('c'),
      disclosure: 'AuthorizedAnalogy',
    },
  ],
});
if (preparedInventory.kind !== 'Prepared') throw new Error('Inventory fixture rejected');
const inventory = preparedInventory.inventory;
const retained = {
  taskId,
  taskRevisionSaid: said('t'),
  originRunId: runId,
  retainedCheckpointSaid: said('k'),
  retainedSealSaid: said('s'),
  parentRevisionSaid: said('p'),
  personalAgentAid: said('a'),
  failureEventSaid: said('f'),
  failureRawEvidenceSaid: said('b'),
};
const preparedHypothesis = prepareEvolutionHypothesis({
  taskId,
  taskRevisionSaid: retained.taskRevisionSaid,
  originRunId: runId,
  retainedCheckpointSaid: retained.retainedCheckpointSaid,
  retainedSealSaid: retained.retainedSealSaid,
  parentRevisionSaid: retained.parentRevisionSaid,
  personalAgentAid: retained.personalAgentAid,
  sourceInventorySaid: inventory.d,
  retrievalReceiptSaid: said('q'),
  failure: {
    eventSaid: retained.failureEventSaid,
    rawEvidenceSaid: retained.failureRawEvidenceSaid,
  },
  source: { episodeSaid, rawEvidenceSaid },
  implicatedComponent: 'Workflow',
  predictedCorrection: 'Require a fresh public verification receipt.',
  publicReplay: {
    failureWindowSaid: said('w'),
    configurationSaid: said('x'),
    nonTreatmentInputsSaid: said('n'),
    failureQuery: 'CESR legacy mismatch',
    predictedAction: 'compatibility-recovery',
    predictedSourceChoiceSaid: said('h'),
    assertion: 'Choose recovery with the source and another action without it.',
  },
  falsifier: 'The source does not change the action.',
  regressionRisks: ['Extra verification can exhaust budget.'],
  rejectedExplanations: ['The fixture omits current marker rules.'],
});
if (preparedHypothesis.kind !== 'Prepared') throw new Error('Hypothesis fixture rejected');
const hypothesis = preparedHypothesis.hypothesis;

function ports() {
  const retrieve = vi.fn().mockResolvedValue({
    kind: 'Retrieved',
    sources: [{ episodeSaid, rawEvidenceSaid, score: 0.9 }],
    queryReceiptSaid: said('z'),
    chargedMicroUsd: 1,
  });
  const read = vi.fn().mockResolvedValue({
    kind: 'Read',
    bytes: new TextEncoder().encode('raw authorized episode'),
    totalBytes: 22,
    sourceSaid: episodeSaid,
    readReceiptSaid: said('d'),
  });
  const project = vi.fn().mockResolvedValue({
    kind: 'Projected',
    episodeSaid,
    rawEvidenceSaid,
    readReceiptSaid: said('d'),
    observation: 'legacy mismatch',
    recoveryHint: 'verify current marker',
  });
  const recalculate = vi.fn().mockImplementation(({ view }: { view: { sources: unknown[] } }) =>
    Promise.resolve(
      view.sources.length > 0
        ? {
            kind: 'Chosen',
            action: 'compatibility-recovery',
            sourceChoiceSaid: said('h'),
            citationSaids: [episodeSaid],
          }
        : {
            kind: 'Chosen',
            action: 'submit-now',
            sourceChoiceSaid: said('u'),
            citationSaids: [],
          },
    ),
  );
  return {
    retrieval: { retrieve },
    reading: { read },
    projection: { project },
    choice: { recalculate },
    retrieve,
    recalculate,
  };
}

describe('evolution hypothesis influence', () => {
  it('replays only the hypothesis predeclared choice over the exact qualified failure and source', async () => {
    const dependencies = ports();
    const outcome = await reviewEvolutionHypothesisInfluence(
      { hypothesis, inventory, retained },
      dependencies,
    );
    expect(outcome.kind).toBe('Influenced');
    if (outcome.kind !== 'Influenced') return;
    expect(outcome.hypothesisSaid).toBe(hypothesis.d);
    expect(outcome.review.source.rawEvidenceSaid).toBe(rawEvidenceSaid);
    expect(dependencies.retrieve).toHaveBeenCalledWith({
      taskId,
      taskRevisionSaid: said('t'),
      sourceInventorySaid: inventory.d,
      corpusSaid: said('c'),
      failureQuery: 'CESR legacy mismatch',
      maximumResults: 3,
    });
    expect(dependencies.recalculate).toHaveBeenCalledTimes(2);
  });

  it('blocks changed failure or source binding before Atlas retrieval', async () => {
    const dependencies = ports();
    expect(
      await reviewEvolutionHypothesisInfluence(
        { hypothesis, inventory, retained: { ...retained, failureRawEvidenceSaid: said('v') } },
        dependencies,
      ),
    ).toEqual({ kind: 'Blocked', reason: 'FailureBinding' });
    expect(
      await reviewEvolutionHypothesisInfluence(
        { hypothesis, inventory: { ...inventory, d: said('v') }, retained },
        dependencies,
      ),
    ).toEqual({ kind: 'Blocked', reason: 'SourceBinding' });
    expect(dependencies.retrieve).not.toHaveBeenCalled();
  });

  it('does not admit a citation-only or unchanged choice as causal influence', async () => {
    const dependencies = ports();
    dependencies.choice.recalculate = vi
      .fn()
      .mockImplementation(({ view }: { view: { sources: unknown[] } }) =>
        Promise.resolve({
          kind: 'Chosen',
          action: 'compatibility-recovery',
          sourceChoiceSaid: said('h'),
          citationSaids: view.sources.length > 0 ? [episodeSaid] : [],
        }),
      );
    expect(
      await reviewEvolutionHypothesisInfluence({ hypothesis, inventory, retained }, dependencies),
    ).toMatchObject({ kind: 'Blocked', reason: 'NoCausalInfluence' });
  });
});
