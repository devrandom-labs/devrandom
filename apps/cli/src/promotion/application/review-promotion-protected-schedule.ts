import { isDeepStrictEqual } from 'node:util';

import { comparisonSlots, type ComparisonSlot } from '@devrandom/domain';
import {
  decodeEvaluationEvidenceEvent,
  decodeEvaluationManifest,
  decodeTrialObservationEvidence,
  type EvaluationClosureEvidenceIndex,
  type EvaluationEvidenceEvent,
  type EvaluationManifest,
  type TrialObservationEvidence,
} from '@devrandom/protocol';

import type { PromotionAcceptedEvidenceReading } from './open-promotion-custody.js';

/** Parent-only oracle check of a typed Trial record against its ACKed ciphertext. */
export interface PromotionProtectedTrialRegrading {
  regrade(input: {
    readonly manifest: EvaluationManifest;
    readonly trial: TrialObservationEvidence;
  }): Promise<
    | { readonly kind: 'Verified'; readonly verdict: 'Pass' | 'Fail' }
    | { readonly kind: 'Incomplete' }
  >;
}

function capturedInSlot(
  events: readonly EvaluationEvidenceEvent[],
  manifest: EvaluationManifest,
  slot: ComparisonSlot,
  artifactSaid: string,
  custody: 'Public' | 'ProtectedCiphertext',
): boolean {
  return events.some(
    (event) =>
      event.detail.kind === 'ArtifactCaptured' &&
      event.detail.artifactSaid === artifactSaid &&
      event.detail.custody === custody &&
      event.phase.kind === 'Trial' &&
      event.phase.manifestSaid === manifest.d &&
      event.phase.arm === slot.arm &&
      event.phase.repetition === slot.repetition &&
      event.phase.attempt === slot.attempt &&
      event.evaluationId === manifest.evaluationId &&
      event.taskId === manifest.taskId &&
      event.taskRevisionSaid === manifest.taskRevisionSaid &&
      event.personalAgentAid === manifest.personalAgentAid &&
      event.taskMandateSaid === manifest.taskMandateSaid,
  );
}

/** E4's 18-slot parent recheck; public correctness, audit and selection remain separate. */
export async function reviewPromotionProtectedSchedule(
  input: {
    readonly manifest: EvaluationManifest;
    readonly index: EvaluationClosureEvidenceIndex;
    readonly acceptedEvents: readonly EvaluationEvidenceEvent[];
  },
  ports: {
    readonly reading: Pick<PromotionAcceptedEvidenceReading, 'openPublic'>;
    readonly regrading: PromotionProtectedTrialRegrading;
  },
): Promise<
  | {
      readonly kind: 'Regraded';
      readonly slots: readonly {
        readonly slot: ComparisonSlot;
        readonly verdict: 'Pass' | 'Fail';
      }[];
    }
  | { readonly kind: 'Incomplete' }
> {
  const { manifest, index, acceptedEvents } = input;
  const schedule = comparisonSlots();
  if (
    decodeEvaluationManifest(manifest).kind !== 'Accepted' ||
    index.evaluationId !== manifest.evaluationId ||
    index.manifestSaid !== manifest.d ||
    !isDeepStrictEqual(manifest.slots, schedule) ||
    index.observations.length !== schedule.length ||
    index.observations.some(
      (entry, position) => !isDeepStrictEqual(entry.slot, schedule[position]),
    ) ||
    new Set(index.observations.map((entry) => entry.artifactSaid)).size !== schedule.length ||
    acceptedEvents.some((event) => decodeEvaluationEvidenceEvent(event).kind !== 'Accepted')
  )
    return { kind: 'Incomplete' };
  const protectedSaids = new Set<string>();
  const slots: { slot: ComparisonSlot; verdict: 'Pass' | 'Fail' }[] = [];
  try {
    for (const entry of index.observations) {
      if (!capturedInSlot(acceptedEvents, manifest, entry.slot, entry.artifactSaid, 'Public'))
        return { kind: 'Incomplete' };
      const opened = await ports.reading.openPublic({
        evaluationId: manifest.evaluationId,
        artifactSaid: entry.artifactSaid,
      });
      if (opened.kind !== 'Opened' || opened.artifact.d !== entry.artifactSaid)
        return { kind: 'Incomplete' };
      const decoded = decodeTrialObservationEvidence(opened.artifact, opened.bytes);
      if (decoded.kind !== 'Accepted') return { kind: 'Incomplete' };
      const trial = decoded.evidence;
      if (
        trial.evaluationId !== manifest.evaluationId ||
        trial.manifestSaid !== manifest.d ||
        trial.harnessRevisionSaid !==
          (entry.slot.arm === 'H1TaskSearch'
            ? manifest.revisions.H1
            : manifest.revisions[entry.slot.arm]) ||
        !isDeepStrictEqual(trial.observation.slot, entry.slot) ||
        protectedSaids.has(trial.protectedObservationSaid) ||
        !capturedInSlot(
          acceptedEvents,
          manifest,
          entry.slot,
          trial.protectedObservationSaid,
          'ProtectedCiphertext',
        )
      )
        return { kind: 'Incomplete' };
      protectedSaids.add(trial.protectedObservationSaid);
      const regraded = await ports.regrading.regrade({ manifest, trial });
      if (regraded.kind !== 'Verified' || regraded.verdict !== trial.protectedVerdict)
        return { kind: 'Incomplete' };
      slots.push({ slot: entry.slot, verdict: regraded.verdict });
    }
  } catch {
    return { kind: 'Incomplete' };
  }
  return { kind: 'Regraded', slots };
}
