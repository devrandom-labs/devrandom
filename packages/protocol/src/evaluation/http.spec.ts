import Value from 'typebox/value';
import { describe, expect, it } from 'vitest';

import { evaluationAdmissionCommandSchema, experienceQuerySchema } from './http.js';

const said = (character: string): string => `E${character.repeat(43)}`;
const id = (digit: string): string =>
  `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const allowance = {
  providerRequests: 2,
  providerInputTokens: 2000,
  providerOutputTokens: 200,
  providerSpendMicroUsd: 100,
  runWallTimeSeconds: 30,
  toolProposals: 20,
  aggregateChildCommandTimeSeconds: 30,
  changedFiles: 2,
  changedWorktreeBytes: 2000,
  evidencePlusArtifactsPerRunBytes: 10000,
};
const admission = {
  version: 1,
  commandId: id('1'),
  fingerprint: `sha256:${'a'.repeat(64)}`,
  taskId: id('2'),
  taskRevisionSaid: said('t'),
  originRunId: id('3'),
  retainedCheckpointSaid: said('c'),
  retainedSealSaid: said('s'),
  expectedActiveRevisionSaid: said('h'),
  personalAgentAid: said('a'),
  taskMandateSaid: said('m'),
  policySaid: said('p'),
  executionProfileSaid: said('e'),
  sourceInventorySaid: said('i'),
  allocation: { diagnosis: allowance, perEntry: allowance, finalization: allowance },
};

describe('closed evaluation hosted commands', () => {
  it('admits a purpose-specific command with no owner override', () => {
    expect(Value.Check(evaluationAdmissionCommandSchema, admission)).toBe(true);
    expect(
      Value.Check(evaluationAdmissionCommandSchema, { ...admission, ownerAid: said('o') }),
    ).toBe(false);
  });

  it('rejects caller-supplied vectors, filters, index names and unrestricted result counts', () => {
    const query = {
      version: 1,
      taskId: id('2'),
      sourceInventorySaid: said('i'),
      corpusSaid: said('c'),
      failureQuery: 'legacy receipt failure',
      maximumResults: 3,
    };
    expect(Value.Check(experienceQuerySchema, query)).toBe(true);
    for (const extra of [
      { vector: [0.1] },
      { indexName: 'all' },
      { filter: {} },
      { ownerAid: said('o') },
    ]) {
      expect(Value.Check(experienceQuerySchema, { ...query, ...extra })).toBe(false);
    }
    expect(Value.Check(experienceQuerySchema, { ...query, maximumResults: 100 })).toBe(false);
  });
});
