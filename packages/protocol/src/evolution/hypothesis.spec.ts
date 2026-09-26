import { describe, expect, it } from 'vitest';

import { decodeEvolutionHypothesis, prepareEvolutionHypothesis } from './hypothesis.js';

const said = (character: string): string => `E${character.repeat(43)}`;
const id = (character: string): string => `${character.repeat(8)}-1111-4111-8111-111111111111`;

function input() {
  return {
    taskId: id('1'),
    taskRevisionSaid: said('a'),
    originRunId: id('2'),
    retainedCheckpointSaid: said('b'),
    retainedSealSaid: said('c'),
    parentRevisionSaid: said('d'),
    personalAgentAid: said('e'),
    sourceInventorySaid: said('f'),
    retrievalReceiptSaid: said('k'),
    failure: {
      eventSaid: said('g'),
      rawEvidenceSaid: said('h'),
    },
    source: {
      episodeSaid: said('i'),
      rawEvidenceSaid: said('j'),
    },
    implicatedComponent: 'Workflow' as const,
    predictedCorrection: 'Require a fresh public compatibility receipt after the focused edit.',
    publicReplayAssertion:
      'The recovery workflow calls the disclosed public verifier on current source bytes.',
    falsifier:
      'The public verifier was already called on the final source, or the source does not change the recovery choice.',
    regressionRisks: ['Extra tool calls can exhaust the Task budget.'],
    rejectedExplanations: ['The fixture lacks the disclosed current CESR marker requirement.'],
  };
}

describe('evolution hypothesis', () => {
  it('binds one attributed diagnosis to exact retained failure and source evidence', () => {
    const prepared = prepareEvolutionHypothesis(input());
    expect(prepared.kind).toBe('Prepared');
    if (prepared.kind !== 'Prepared') return;
    expect(decodeEvolutionHypothesis(prepared.hypothesis)).toEqual({
      kind: 'Accepted',
      hypothesis: prepared.hypothesis,
    });
    expect(prepareEvolutionHypothesis(input())).toEqual(prepared);
  });

  it('rejects missing raw evidence, absent falsifier and empty rejected explanations', () => {
    expect(prepareEvolutionHypothesis({ ...input(), failure: { eventSaid: said('g') } })).toEqual({
      kind: 'Rejected',
      reason: 'SchemaInvalid',
    });
    expect(prepareEvolutionHypothesis({ ...input(), falsifier: '' })).toEqual({
      kind: 'Rejected',
      reason: 'SchemaInvalid',
    });
    expect(prepareEvolutionHypothesis({ ...input(), rejectedExplanations: [] })).toEqual({
      kind: 'Rejected',
      reason: 'SchemaInvalid',
    });
    expect(prepareEvolutionHypothesis({ ...input(), retrievalReceiptSaid: undefined })).toEqual({
      kind: 'Rejected',
      reason: 'SchemaInvalid',
    });
  });

  it('rejects merged failure/source identity and unapproved authority fields', () => {
    expect(
      prepareEvolutionHypothesis({
        ...input(),
        source: { episodeSaid: said('g'), rawEvidenceSaid: said('h') },
      }),
    ).toEqual({ kind: 'Rejected', reason: 'EvidenceIdentityConflict' });
    expect(prepareEvolutionHypothesis({ ...input(), winner: 'C2' })).toEqual({
      kind: 'Rejected',
      reason: 'SchemaInvalid',
    });
  });

  it('rejects a changed claim under the original SAID', () => {
    const prepared = prepareEvolutionHypothesis(input());
    expect(prepared.kind).toBe('Prepared');
    if (prepared.kind !== 'Prepared') return;
    expect(
      decodeEvolutionHypothesis({
        ...prepared.hypothesis,
        predictedCorrection: 'Submit without verification.',
      }),
    ).toEqual({ kind: 'Rejected', reason: 'SaidMismatch' });
  });
});
