import { describe, expect, it } from 'vitest';
import type { SimulationProofReport } from './simulation-proof-report.js';
import { renderSimulationDemo } from './prd03-demo.js';

const report: SimulationProofReport = {
  version: 1,
  mode: 'Simulation',
  generatedAt: '2026-09-26T17:00:00.000Z',
  repositoryRoot: '/repository',
  continuity: 'IndependentFixtureProofs',
  status: 'Passed',
  claim: 'Independent fixture proofs.',
  stages: [
    {
      id: 'process-loss-recovery',
      title: 'Process-loss recovery',
      status: 'Passed',
      testCount: 2,
      proofPath: 'proofs/recovery.json',
      proofSha256: `sha256:${'a'.repeat(64)}`,
      realBoundaries: ['OS SIGKILL and same-Run continuation'],
      simulatedInputs: ['Initial authority fixture'],
    },
  ],
};

describe('demo presentation claims', () => {
  it('labels recorded independent proofs and distinguishes real boundaries from fixture inputs', () => {
    const text = renderSimulationDemo(report);
    expect(text).toContain('RECORDED SIMULATION');
    expect(text).toContain('Independent mechanism proofs');
    expect(text).toContain('Real: OS SIGKILL and same-Run continuation');
    expect(text).toContain('Simulated: Initial authority fixture');
    expect(text).toContain('Live evolution acceptance: NOT ESTABLISHED');
    expect(text).toContain('proofs/recovery.json');
    expect(text).not.toContain('H2 activated');
  });

  it('keeps a blocked proof visible instead of announcing a ready demonstration', () => {
    const stage = report.stages[0];
    if (stage === undefined) throw new Error('Missing presentation fixture stage.');
    const text = renderSimulationDemo({
      ...report,
      status: 'Blocked',
      stages: [{ ...stage, status: 'Blocked', reason: 'SkippedAssertion' }],
    });
    expect(text).toContain('DEMO PROOFS BLOCKED');
    expect(text).toContain('SkippedAssertion');
    expect(text).not.toContain('DEMO PROOFS READY');
  });
});
