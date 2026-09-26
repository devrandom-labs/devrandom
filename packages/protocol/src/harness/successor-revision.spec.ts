import { describe, expect, it } from 'vitest';

import {
  decodeSuccessorHarnessRevision,
  prepareSuccessorHarnessRevision,
} from './successor-revision.js';

const said = (letter: string) => `E${letter.repeat(43)}`;
const common = {
  parentRevisionSaid: said('h'),
  h0Said: said('o'),
  taskRevisionSaid: said('t'),
  sourceInventorySaid: said('s'),
  executionProfileSaid: said('p'),
  configurationArtifactSaid: said('a'),
};

describe('immutable successor Harness revision', () => {
  it.each([
    { arm: 'C1', treatment: { kind: 'Instruction' } },
    {
      arm: 'C2',
      treatment: {
        kind: 'ReviewedWorkflow',
        reviewedImplementationSaid: said('w'),
        publicReplayReceiptSaid: said('r'),
      },
    },
    {
      arm: 'C3',
      treatment: {
        kind: 'ContextSelection',
        reviewedImplementationSaid: said('x'),
        publicReplayReceiptSaid: said('q'),
      },
    },
  ])('prepares and decodes one $arm delta without changing H1 authority', ({ arm, treatment }) => {
    const prepared = prepareSuccessorHarnessRevision({ ...common, arm, treatment });
    expect(prepared.kind).toBe('Prepared');
    if (prepared.kind !== 'Prepared') return;
    expect(prepared.revision).toMatchObject({
      version: 1,
      kind: 'ReviewedSuccessor',
      arm,
      treatment,
      parentRevisionSaid: common.parentRevisionSaid,
    });
    expect(decodeSuccessorHarnessRevision(prepared.revision)).toEqual({
      kind: 'Accepted',
      revision: prepared.revision,
    });
  });

  it('rejects an arm/treatment mismatch and an invented C1 replay receipt', () => {
    expect(
      prepareSuccessorHarnessRevision({
        ...common,
        arm: 'C1',
        treatment: {
          kind: 'ReviewedWorkflow',
          reviewedImplementationSaid: said('w'),
          publicReplayReceiptSaid: said('r'),
        },
      }).kind,
    ).toBe('Rejected');
    expect(
      prepareSuccessorHarnessRevision({
        ...common,
        arm: 'C1',
        treatment: { kind: 'Instruction', publicReplayReceiptSaid: said('r') },
      }).kind,
    ).toBe('Rejected');
  });

  it('requires exact reviewed implementation and public replay for C2/C3', () => {
    expect(
      prepareSuccessorHarnessRevision({
        ...common,
        arm: 'C2',
        treatment: { kind: 'ReviewedWorkflow', reviewedImplementationSaid: said('w') },
      }).kind,
    ).toBe('Rejected');
    expect(
      prepareSuccessorHarnessRevision({
        ...common,
        arm: 'C3',
        treatment: { kind: 'ContextSelection', publicReplayReceiptSaid: said('r') },
      }).kind,
    ).toBe('Rejected');
  });

  it('rejects hidden winner, authority, tool, model or score fields', () => {
    for (const forbidden of [
      'winner',
      'authority',
      'activeTools',
      'modelCompatibility',
      'score',
    ] as const) {
      expect(
        prepareSuccessorHarnessRevision({
          ...common,
          arm: 'C1',
          treatment: { kind: 'Instruction' },
          [forbidden]: 'forged',
        }).kind,
      ).toBe('Rejected');
    }
  });

  it('rejects an altered SAID or post-freeze treatment/configuration substitution', () => {
    const prepared = prepareSuccessorHarnessRevision({
      ...common,
      arm: 'C2',
      treatment: {
        kind: 'ReviewedWorkflow',
        reviewedImplementationSaid: said('w'),
        publicReplayReceiptSaid: said('r'),
      },
    });
    if (prepared.kind !== 'Prepared') throw new Error('fixture successor');
    expect(
      decodeSuccessorHarnessRevision({ ...prepared.revision, configurationArtifactSaid: said('z') })
        .kind,
    ).toBe('Rejected');
    expect(
      decodeSuccessorHarnessRevision({
        ...prepared.revision,
        treatment: { ...prepared.revision.treatment, publicReplayReceiptSaid: said('z') },
      }).kind,
    ).toBe('Rejected');
  });
});
