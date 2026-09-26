import { describe, expect, it } from 'vitest';

import {
  decodePromotionSelectionRecord,
  preparePromotionSelectionRecord,
} from './selection-record.js';

const said = (letter: string) => `E${letter.repeat(43)}`;
const input = {
  taskId: 'bbb13317-1c5e-4472-842e-692da01386cf',
  taskRevisionSaid: said('t'),
  harnessLineageId: '5ebf49b9-df26-4a49-9194-da868f97cf9d',
  expectedIncumbentRevisionSaid: said('h'),
  expectedPointerVersion: 1,
  evaluationManifestSaid: said('m'),
  evaluationClosureSaid: said('e'),
  hypothesisSaid: said('i'),
  selection: {
    kind: 'Activate' as const,
    candidateRevisionSaid: said('c'),
    artifactSaids: [said('x'), said('y'), said('z')],
  },
};

describe('content-addressed local promotion selection', () => {
  it('binds the exact M, closure, hypothesis, candidate and measured artifacts', () => {
    const prepared = preparePromotionSelectionRecord(input);
    expect(prepared).toMatchObject({ kind: 'Prepared', record: { kind: 'PromotionSelection' } });
    if (prepared.kind !== 'Prepared') throw new Error('selection fixture rejected');
    expect(decodePromotionSelectionRecord(prepared.record)).toEqual({
      kind: 'Accepted',
      record: prepared.record,
    });
    expect(preparePromotionSelectionRecord(input)).toEqual(prepared);
    expect(
      decodePromotionSelectionRecord({ ...prepared.record, evaluationClosureSaid: said('q') }),
    ).toEqual({ kind: 'Rejected', reason: 'SaidMismatch' });
  });

  it('rejects H1 as successor and disallows an implicit winner in retention', () => {
    expect(
      preparePromotionSelectionRecord({
        ...input,
        selection: {
          ...input.selection,
          candidateRevisionSaid: input.expectedIncumbentRevisionSaid,
        },
      }),
    ).toEqual({ kind: 'Rejected', reason: 'IncumbentAsSuccessor' });
    const retained = preparePromotionSelectionRecord({
      ...input,
      selection: { kind: 'RetainIncumbent' },
    });
    expect(retained).toMatchObject({
      kind: 'Prepared',
      record: { selection: { kind: 'RetainIncumbent' } },
    });
    if (retained.kind !== 'Prepared') throw new Error('retention fixture rejected');
    expect(
      decodePromotionSelectionRecord({
        ...retained.record,
        selection: { kind: 'RetainIncumbent', candidateRevisionSaid: said('c') },
      }),
    ).toEqual({ kind: 'Rejected', reason: 'SchemaInvalid' });
  });
});
