import { validateExecutionBinding, type EvaluationExecutionBinding } from '@devrandom/domain';
import { decodeEvaluationEvidenceEvent, type EvaluationEvidenceEvent } from '@devrandom/protocol';

export interface ProtectedTrialAcceptedPrefix {
  readonly kind: 'Acknowledged';
  readonly events: readonly EvaluationEvidenceEvent[];
  readonly throughSequence: number;
  readonly headSaid: string;
}

export type ProtectedTrialPrefixVerification =
  | {
      readonly kind: 'Verified';
      readonly events: readonly EvaluationEvidenceEvent[];
      readonly stoppedSequence: number;
      readonly custodySequence: number;
    }
  | { readonly kind: 'Missing' };

/** Verifies the exact hosted stopped prefix and later protected-ciphertext ACK before usage attribution. */
export function verifyProtectedTrialPrefix(
  input: {
    readonly binding: EvaluationExecutionBinding;
    readonly trialEvidenceHeadSaid: string;
    readonly protectedObservationSaid: string;
    readonly custodyEvidenceHeadSaid: string;
    readonly custodyEvidenceSequence: number;
  },
  prefix: ProtectedTrialAcceptedPrefix,
): ProtectedTrialPrefixVerification {
  const { binding, custodyEvidenceSequence } = input;
  if (
    validateExecutionBinding(binding).kind !== 'Accepted' ||
    binding.phase.kind !== 'Trial' ||
    !Number.isSafeInteger(custodyEvidenceSequence) ||
    custodyEvidenceSequence < 1 ||
    custodyEvidenceSequence > 9_999 ||
    prefix.events.length !== custodyEvidenceSequence + 1 ||
    prefix.throughSequence !== custodyEvidenceSequence ||
    prefix.headSaid !== input.custodyEvidenceHeadSaid
  )
    return { kind: 'Missing' };
  for (const [index, event] of prefix.events.entries()) {
    const predecessor = prefix.events[index - 1];
    if (
      decodeEvaluationEvidenceEvent(event).kind !== 'Accepted' ||
      event.sequence !== index ||
      event.evaluationId !== binding.evaluationId ||
      event.streamId !== binding.evidenceStreamId ||
      event.originRunId !== binding.originRunId ||
      event.taskId !== binding.taskId ||
      event.taskRevisionSaid !== binding.taskRevisionSaid ||
      event.personalAgentAid !== binding.personalAgentAid ||
      event.taskMandateSaid !== binding.taskMandateSaid ||
      (index === 0
        ? event.previous.kind !== 'Genesis'
        : event.previous.kind !== 'Previous' || event.previous.eventSaid !== predecessor?.d)
    )
      return { kind: 'Missing' };
  }
  const custody = prefix.events[custodyEvidenceSequence];
  const stopped = prefix.events.find((event) => event.d === input.trialEvidenceHeadSaid);
  const sameTrial = (event: EvaluationEvidenceEvent) =>
    event.harnessRevisionSaid === binding.harnessRevisionSaid &&
    JSON.stringify(event.phase) === JSON.stringify(binding.phase);
  if (
    custody?.d !== input.custodyEvidenceHeadSaid ||
    custody.detail.kind !== 'ArtifactCaptured' ||
    custody.detail.custody !== 'ProtectedCiphertext' ||
    custody.detail.artifactSaid !== input.protectedObservationSaid ||
    stopped === undefined ||
    stopped.sequence >= custodyEvidenceSequence ||
    stopped.detail.kind !== 'TrialStopped' ||
    stopped.detail.reason !== 'Completed' ||
    custody.harnessRevisionSaid !== binding.harnessRevisionSaid ||
    stopped.harnessRevisionSaid !== binding.harnessRevisionSaid ||
    JSON.stringify(custody.phase) !== JSON.stringify(binding.phase) ||
    JSON.stringify(stopped.phase) !== JSON.stringify(binding.phase) ||
    prefix.events.filter((event) => event.detail.kind === 'TrialStopped' && sameTrial(event))
      .length !== 1 ||
    prefix.events
      .slice(stopped.sequence + 1, custodyEvidenceSequence)
      .some(
        (event) =>
          sameTrial(event) &&
          !(event.detail.kind === 'ArtifactCaptured' && event.detail.custody === 'Public'),
      )
  )
    return { kind: 'Missing' };
  return {
    kind: 'Verified',
    events: prefix.events,
    stoppedSequence: stopped.sequence,
    custodySequence: custody.sequence,
  };
}
