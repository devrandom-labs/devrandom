import { expect, it } from 'vitest';

import { cesrPublicConditions, matchCesrPublicContract } from './cesr-public-contract.js';

it('recognizes structural equality but refuses expectation mutation, omission and catalogue mixing', () => {
  for (const contract of ['FlatGroups', 'ScopedGroups'] as const) {
    const conditions = cesrPublicConditions(contract);
    const reordered = conditions.map((condition) => ({
      expected: condition.expected,
      stimulusBase64Url: condition.stimulusBase64Url,
      id: condition.id,
    }));
    expect(matchCesrPublicContract(reordered)).toBe(contract);
    expect(matchCesrPublicContract(conditions.slice(1))).toBeUndefined();
    const first = conditions[0];
    if (first === undefined) throw new Error('Missing reviewed public case');
    expect(matchCesrPublicContract([...conditions, first])).toBeUndefined();
    const mutated = conditions.map((condition, index) =>
      index === 0
        ? { ...condition, expected: { kind: 'Rejected' as const, error: 'AnyRejection' as const } }
        : condition,
    );
    expect(matchCesrPublicContract(mutated)).toBeUndefined();
  }
  const fresh = cesrPublicConditions('ScopedGroups');
  expect(matchCesrPublicContract([...fresh.slice(14), ...fresh.slice(0, 14)])).toBeUndefined();
});
