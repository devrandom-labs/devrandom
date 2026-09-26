import {
  assessEvaluationLease,
  validateExecutionBinding,
  type EvaluationExecutionBinding,
  type EvaluationLeaseReceipt,
} from '@devrandom/domain';
import { decodeEvaluationManifest, type EvaluationManifest } from '@devrandom/protocol';

import type { TrialExecution } from './evaluation-conversations.js';

export interface ProtectedTrialInput {
  readonly manifest: EvaluationManifest;
  readonly binding: EvaluationExecutionBinding;
  readonly lease: EvaluationLeaseReceipt;
  readonly leaseRequestStartedAt: number;
  readonly now: number;
  readonly cleanSourceSaid: string;
  readonly reviewedBehaviorSaid: string;
  readonly modelProfileSaid: string;
  readonly containerProfileSaid: string;
  readonly signal: AbortSignal;
}

export type ProtectedTrialInvocation =
  | { readonly kind: 'Executed'; readonly observation: Awaited<ReturnType<TrialExecution['run']>> }
  | {
      readonly kind: 'Rejected';
      readonly reason:
        | 'BindingInvalid'
        | 'ManifestInvalid'
        | 'ManifestMismatch'
        | 'SlotInvalid'
        | 'LeaseLost'
        | 'ProfileMismatch';
    }
  | { readonly kind: 'Invalid'; readonly reason: 'Interrupted' | 'ExecutionFailed' };

/** The Supervisor's owned trial use case checks every frozen right before constructing a worker. */
export async function runProtectedTrial(
  input: ProtectedTrialInput,
  execution: TrialExecution,
): Promise<ProtectedTrialInvocation> {
  if (input.signal.aborted) return { kind: 'Invalid', reason: 'Interrupted' };
  if (decodeEvaluationManifest(input.manifest).kind !== 'Accepted')
    return { kind: 'Rejected', reason: 'ManifestInvalid' };
  if (validateExecutionBinding(input.binding).kind !== 'Accepted')
    return { kind: 'Rejected', reason: 'BindingInvalid' };
  const { binding, manifest } = input;
  if (binding.phase.kind !== 'Trial') return { kind: 'Rejected', reason: 'SlotInvalid' };
  const phase = binding.phase;
  if (
    binding.evaluationId !== manifest.evaluationId ||
    binding.originRunId !== manifest.originRunId ||
    binding.taskId !== manifest.taskId ||
    binding.taskRevisionSaid !== manifest.taskRevisionSaid ||
    binding.personalAgentAid !== manifest.personalAgentAid ||
    binding.taskMandateSaid !== manifest.taskMandateSaid ||
    phase.manifestSaid !== manifest.d
  )
    return { kind: 'Rejected', reason: 'ManifestMismatch' };
  const slot = manifest.slots.find(
    (required) =>
      required.arm === phase.arm &&
      required.repetition === phase.repetition &&
      required.attempt === phase.attempt,
  );
  if (slot === undefined) return { kind: 'Rejected', reason: 'SlotInvalid' };
  const expectedRevision =
    slot.arm === 'H1TaskSearch' ? manifest.revisions.H1 : manifest.revisions[slot.arm];
  if (binding.harnessRevisionSaid !== expectedRevision)
    return { kind: 'Rejected', reason: 'ManifestMismatch' };
  if (
    assessEvaluationLease(
      input.lease,
      binding.evaluationId,
      binding.evaluationLeaseId,
      input.leaseRequestStartedAt,
      input.now,
    ).kind !== 'Held'
  )
    return { kind: 'Rejected', reason: 'LeaseLost' };
  if (
    input.containerProfileSaid !== manifest.executionProfileSaid ||
    input.cleanSourceSaid.length === 0 ||
    input.reviewedBehaviorSaid.length === 0 ||
    input.modelProfileSaid.length === 0
  )
    return { kind: 'Rejected', reason: 'ProfileMismatch' };
  try {
    const observation = await execution.run({
      binding,
      manifest,
      slot,
      cleanSourceSaid: input.cleanSourceSaid,
      reviewedBehaviorSaid: input.reviewedBehaviorSaid,
      modelProfileSaid: input.modelProfileSaid,
      containerProfileSaid: input.containerProfileSaid,
      signal: input.signal,
    });
    return { kind: 'Executed', observation };
  } catch {
    return { kind: 'Invalid', reason: 'ExecutionFailed' };
  }
}
