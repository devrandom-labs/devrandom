import { describe, expect, it } from 'vitest';

import { validateExecutionBinding } from './execution-binding.js';

const origin = {
  taskId: 'task',
  taskRevisionSaid: 'revision',
  originRunId: 'retained-run',
  personalAgentAid: 'agent',
  taskMandateSaid: 'mandate',
  harnessRevisionSaid: 'harness',
};

describe('evaluation execution identity', () => {
  it('accepts a trial with its own evaluation, lease and evidence stream', () => {
    expect(
      validateExecutionBinding({
        kind: 'Evaluation',
        ...origin,
        evaluationId: 'evaluation',
        evaluationLeaseId: 'evaluation-lease',
        evidenceStreamId: 'evaluation-stream',
        phase: {
          kind: 'Trial',
          manifestSaid: 'manifest',
          arm: 'C2',
          repetition: 2,
          attempt: 1,
        },
      }),
    ).toEqual({ kind: 'Accepted' });
  });

  it('rejects a trial borrowing the predecessor Run stream or lease', () => {
    const trial = {
      kind: 'Evaluation' as const,
      ...origin,
      evaluationId: 'evaluation',
      evaluationLeaseId: 'incarnation',
      evidenceStreamId: 'run-stream',
      phase: {
        kind: 'Trial' as const,
        manifestSaid: 'manifest',
        arm: 'C2' as const,
        repetition: 1 as const,
        attempt: 1 as const,
      },
    };
    expect(
      validateExecutionBinding(trial, { runStreamId: 'run-stream', incarnationId: 'incarnation' }),
    ).toEqual({
      kind: 'Rejected',
      reason: 'PredecessorRightsReused',
    });
  });

  it('rejects a task-search second attempt on a non-search arm', () => {
    expect(
      validateExecutionBinding({
        kind: 'Evaluation',
        ...origin,
        evaluationId: 'evaluation',
        evaluationLeaseId: 'evaluation-lease',
        evidenceStreamId: 'evaluation-stream',
        phase: {
          kind: 'Trial',
          manifestSaid: 'manifest',
          arm: 'C1',
          repetition: 1,
          attempt: 2,
        },
      }),
    ).toEqual({ kind: 'Rejected', reason: 'SlotInvalid' });
  });

  it('keeps pre-manifest research distinct from a graded trial', () => {
    expect(
      validateExecutionBinding({
        kind: 'Evaluation',
        ...origin,
        evaluationId: 'evaluation',
        evaluationLeaseId: 'evaluation-lease',
        evidenceStreamId: 'evaluation-stream',
        phase: { kind: 'Research', policySaid: 'policy', role: 'DiagnosticRefiner' },
      }),
    ).toEqual({ kind: 'Accepted' });
  });
});
