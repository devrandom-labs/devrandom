import type { ComparisonSlot } from './comparison.js';

interface OriginRunReference {
  readonly taskId: string;
  readonly taskRevisionSaid: string;
  readonly originRunId: string;
  readonly personalAgentAid: string;
  readonly taskMandateSaid: string;
  readonly harnessRevisionSaid: string;
}

/** Evaluation effects are accountable to the retained Run but never use its lease or stream. */
export interface EvaluationExecutionBinding extends OriginRunReference {
  readonly kind: 'Evaluation';
  readonly evaluationId: string;
  readonly evaluationLeaseId: string;
  readonly evidenceStreamId: string;
  readonly phase:
    | {
        readonly kind: 'Research';
        readonly policySaid: string;
        readonly role: 'DiagnosticRefiner' | 'CandidateWorker';
      }
    | ({ readonly kind: 'Trial'; readonly manifestSaid: string } & ComparisonSlot);
}

export type ExecutionBindingAssessment =
  | { readonly kind: 'Accepted' }
  | {
      readonly kind: 'Rejected';
      readonly reason: 'IdentityInvalid' | 'PredecessorRightsReused' | 'SlotInvalid';
    };

export function validateExecutionBinding(
  binding: EvaluationExecutionBinding,
  predecessor?: { readonly runStreamId: string; readonly incarnationId: string },
): ExecutionBindingAssessment {
  const identities = [
    binding.taskId,
    binding.taskRevisionSaid,
    binding.originRunId,
    binding.personalAgentAid,
    binding.taskMandateSaid,
    binding.harnessRevisionSaid,
    binding.evaluationId,
    binding.evaluationLeaseId,
    binding.evidenceStreamId,
  ];
  if (identities.some((identity) => identity.length === 0))
    return { kind: 'Rejected', reason: 'IdentityInvalid' };
  if (
    binding.evaluationId === binding.originRunId ||
    binding.evaluationLeaseId === binding.originRunId ||
    binding.evidenceStreamId === binding.originRunId ||
    binding.evaluationLeaseId === binding.evidenceStreamId ||
    binding.evaluationLeaseId === predecessor?.incarnationId ||
    binding.evidenceStreamId === predecessor?.runStreamId
  )
    return { kind: 'Rejected', reason: 'PredecessorRightsReused' };
  if (binding.phase.kind === 'Research') {
    return binding.phase.policySaid.length > 0
      ? { kind: 'Accepted' }
      : { kind: 'Rejected', reason: 'IdentityInvalid' };
  }
  const { arm, repetition, attempt, manifestSaid } = binding.phase;
  if (
    manifestSaid.length === 0 ||
    !['H1', 'C1', 'C2', 'C3', 'H1TaskSearch'].includes(arm) ||
    ![1, 2, 3].includes(repetition) ||
    ![1, 2].includes(attempt) ||
    (arm !== 'H1TaskSearch' && attempt !== 1)
  )
    return { kind: 'Rejected', reason: 'SlotInvalid' };
  return { kind: 'Accepted' };
}
