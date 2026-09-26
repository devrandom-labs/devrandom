import { describe, expect, it } from 'vitest';

import { assessSuccessorFamily, type SuccessorRevisionIdentity } from './successor-revision.js';

const said = (letter: string) => `E${letter.repeat(43)}`;
const common = {
  parentRevisionSaid: said('h'),
  h0Said: said('o'),
  taskRevisionSaid: said('t'),
  sourceInventorySaid: said('s'),
  executionProfileSaid: said('p'),
};
const candidates: readonly [
  SuccessorRevisionIdentity,
  SuccessorRevisionIdentity,
  SuccessorRevisionIdentity,
] = [
  { ...common, arm: 'C1', revisionSaid: said('a'), configurationArtifactSaid: said('1') },
  { ...common, arm: 'C2', revisionSaid: said('b'), configurationArtifactSaid: said('2') },
  { ...common, arm: 'C3', revisionSaid: said('c'), configurationArtifactSaid: said('3') },
];

describe('successor family identity', () => {
  it('requires three distinct immutable H1 siblings before manifest M', () => {
    expect(assessSuccessorFamily(common, candidates)).toEqual({
      kind: 'Complete',
      revisions: { C1: said('a'), C2: said('b'), C3: said('c') },
    });
  });

  it('blocks an omitted or duplicated treatment family', () => {
    expect(assessSuccessorFamily(common, candidates.slice(0, 2))).toEqual({
      kind: 'Blocked',
      reason: 'CandidateSetIncomplete',
    });
    expect(
      assessSuccessorFamily(common, [
        candidates[0],
        candidates[1],
        { ...candidates[2], arm: 'C2' },
      ]),
    ).toEqual({ kind: 'Blocked', reason: 'CandidateSetIncomplete' });
  });

  it('blocks a mixed H1, Task, source, profile or H0 binding', () => {
    for (const field of [
      'parentRevisionSaid',
      'h0Said',
      'taskRevisionSaid',
      'sourceInventorySaid',
      'executionProfileSaid',
    ] as const) {
      const changed = candidates.map((candidate, index) =>
        index === 1 ? { ...candidate, [field]: said('z') } : candidate,
      );
      expect(assessSuccessorFamily(common, changed)).toEqual({
        kind: 'Blocked',
        reason: 'BindingMismatch',
      });
    }
  });

  it('blocks reused candidate or configuration identity', () => {
    expect(
      assessSuccessorFamily(common, [
        candidates[0],
        { ...candidates[1], revisionSaid: said('a') },
        candidates[2],
      ]),
    ).toEqual({ kind: 'Blocked', reason: 'IdentityReused' });
    expect(
      assessSuccessorFamily(common, [
        candidates[0],
        { ...candidates[1], configurationArtifactSaid: said('1') },
        candidates[2],
      ]),
    ).toEqual({ kind: 'Blocked', reason: 'IdentityReused' });
  });
});
