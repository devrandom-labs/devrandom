import { describe, expect, it } from 'vitest';

import {
  decodeEvaluationSourceInventory,
  prepareEvaluationSourceInventory,
} from './source-inventory.js';

const said = (character: string): string => `E${character.repeat(43)}`;
const id = (digit: string): string =>
  `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const input = {
  taskId: id('1'),
  taskRevisionSaid: said('t'),
  ownerAid: said('o'),
  repositoryResourceSaid: said('r'),
  corpusSaid: said('c'),
  experienceMandateSaid: said('m'),
  sources: [
    {
      episodeSaid: said('e'),
      rawEvidenceSaid: said('a'),
      ownerAid: said('o'),
      repositoryResourceSaid: said('r'),
      corpusSaid: said('c'),
      disclosure: 'AuthorizedAnalogy',
    },
  ],
};

describe('frozen source exposure inventory', () => {
  it('binds exact authorized raw sources and their disclosure attributes', () => {
    const prepared = prepareEvaluationSourceInventory(input);
    if (prepared.kind !== 'Prepared') throw new Error('inventory rejected');
    expect(decodeEvaluationSourceInventory(prepared.inventory)).toEqual({
      kind: 'Accepted',
      inventory: prepared.inventory,
    });
  });

  it('rejects cross-owner, protected and unbound historical sources', () => {
    for (const source of [
      { ...input.sources[0], ownerAid: said('z') },
      { ...input.sources[0], disclosure: 'Protected' },
      { ...input.sources[0], corpusSaid: said('z') },
    ]) {
      expect(prepareEvaluationSourceInventory({ ...input, sources: [source] })).toEqual({
        kind: 'Rejected',
        reason: 'SourceDenied',
      });
    }
    expect(
      prepareEvaluationSourceInventory({ ...input, experienceMandateSaid: undefined }),
    ).toEqual({ kind: 'Rejected', reason: 'SchemaInvalid' });
  });
});
