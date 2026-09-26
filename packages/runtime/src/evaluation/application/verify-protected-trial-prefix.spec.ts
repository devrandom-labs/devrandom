import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import { prepareEvaluationEvidenceEvent } from '@devrandom/protocol';

import { verifyProtectedTrialPrefix } from './verify-protected-trial-prefix.js';

const said = (letter: string): string => `E${letter.repeat(43)}`;

function fixture() {
  const binding = {
    kind: 'Evaluation' as const,
    evaluationId: randomUUID(),
    evaluationLeaseId: randomUUID(),
    evidenceStreamId: randomUUID(),
    originRunId: randomUUID(),
    taskId: randomUUID(),
    taskRevisionSaid: said('t'),
    personalAgentAid: said('a'),
    taskMandateSaid: said('m'),
    harnessRevisionSaid: said('h'),
    phase: {
      kind: 'Trial' as const,
      manifestSaid: said('v'),
      arm: 'H1' as const,
      repetition: 1 as const,
      attempt: 1 as const,
    },
  };
  const details = {
    evaluationId: binding.evaluationId,
    streamId: binding.evidenceStreamId,
    originRunId: binding.originRunId,
    taskId: binding.taskId,
    taskRevisionSaid: binding.taskRevisionSaid,
    personalAgentAid: binding.personalAgentAid,
    taskMandateSaid: binding.taskMandateSaid,
    harnessRevisionSaid: binding.harnessRevisionSaid,
    phase: binding.phase,
    occurredAt: '2026-09-26T10:00:00.000Z',
  };
  const stopped = prepareEvaluationEvidenceEvent({
    ...details,
    sequence: 0,
    previous: { kind: 'Genesis' },
    detail: { kind: 'TrialStopped', reason: 'Completed' },
  });
  if (stopped.kind !== 'Prepared') throw new Error(stopped.reason);
  const protectedObservationSaid = said('p');
  const custody = prepareEvaluationEvidenceEvent({
    ...details,
    sequence: 1,
    previous: { kind: 'Previous', eventSaid: stopped.event.d },
    detail: {
      kind: 'ArtifactCaptured',
      custody: 'ProtectedCiphertext',
      artifactSaid: protectedObservationSaid,
    },
  });
  if (custody.kind !== 'Prepared') throw new Error(custody.reason);
  const input = {
    binding,
    trialEvidenceHeadSaid: stopped.event.d,
    protectedObservationSaid,
    custodyEvidenceHeadSaid: custody.event.d,
    custodyEvidenceSequence: 1,
  };
  const prefix = {
    kind: 'Acknowledged' as const,
    events: [stopped.event, custody.event],
    throughSequence: 1,
    headSaid: custody.event.d,
  };
  return { input, prefix };
}

describe('protected trial accepted-prefix binding', () => {
  it('binds stopped trial and exact protected observation ciphertext to hosted custody', () => {
    const { input, prefix } = fixture();
    expect(verifyProtectedTrialPrefix(input, prefix).kind).toBe('Verified');
    expect(
      verifyProtectedTrialPrefix({ ...input, protectedObservationSaid: said('x') }, prefix),
    ).toEqual({ kind: 'Missing' });
    expect(
      verifyProtectedTrialPrefix({ ...input, custodyEvidenceHeadSaid: said('x') }, prefix),
    ).toEqual({ kind: 'Missing' });
  });
});
