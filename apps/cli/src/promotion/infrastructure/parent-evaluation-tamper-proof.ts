import { isDeepStrictEqual } from 'node:util';

import { comparisonSlots, tamperLifecycleRoles, type TamperAuditScope } from '@devrandom/domain';
import {
  decodeEvaluationEvidenceEvent,
  decodeEvaluationManifest,
  decodeEvidenceArtifact,
  prepareEvidenceArtifact,
  type EvaluationEvidenceEvent,
  type EvaluationManifest,
  type EvidenceArtifact,
} from '@devrandom/protocol';
import Type from 'typebox';
import Value from 'typebox/value';

import type { PromotionTamperProofInspection } from '../application/review-promotion-tamper-audit.js';

const said = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const uuid = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const scope = Type.Union([
  Type.Literal('Shared'),
  Type.Literal('H1'),
  Type.Literal('C1'),
  Type.Literal('C2'),
  Type.Literal('C3'),
  Type.Literal('H1TaskSearch'),
]);
const role = Type.Union([
  Type.Literal('Execution'),
  Type.Literal('Evaluation'),
  Type.Literal('Selection'),
  Type.Literal('Recording'),
  Type.Literal('Propagation'),
]);
const attemptKind = Type.Union([
  Type.Literal('HeldOutAccess'),
  Type.Literal('EvaluatorModification'),
  Type.Literal('EvidenceDeletion'),
  Type.Literal('CaseOmission'),
  Type.Literal('ArtifactSubstitution'),
]);
const proofSchema = Type.Object(
  {
    version: Type.Literal(1),
    kind: Type.Literal('TrialStopProcedureProof'),
    evaluationId: uuid,
    manifestSaid: said,
    scope,
    throughSequence: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    throughHeadSaid: said,
    trialStoppedEventSaids: Type.Array(said, { minItems: 3, maxItems: 18, uniqueItems: true }),
    observation: Type.Union([Type.Literal('AllCompleted'), Type.Literal('NotCompleted')]),
  },
  { additionalProperties: false },
);
const attemptWindowSchema = Type.Object(
  {
    version: Type.Literal(1),
    kind: Type.Literal('TamperAttemptWindow'),
    evaluationId: uuid,
    manifestSaid: said,
    scope,
    throughHeadSaid: said,
    roles: Type.Array(
      Type.Object(
        {
          role,
          openedEventSaid: said,
          closedEventSaid: said,
          attempts: Type.Array(
            Type.Object({ attemptSaid: said, kind: attemptKind }, { additionalProperties: false }),
            { maxItems: 512 },
          ),
        },
        { additionalProperties: false },
      ),
      { minItems: 5, maxItems: 5 },
    ),
  },
  { additionalProperties: false },
);
type ProcedureProof = Type.Static<typeof proofSchema>;
type AttemptWindow = Type.Static<typeof attemptWindowSchema>;

function completePrefix(
  manifest: EvaluationManifest,
  events: readonly EvaluationEvidenceEvent[],
): boolean {
  if (decodeEvaluationManifest(manifest).kind !== 'Accepted' || events.length < 2) return false;
  const first = events[0];
  const last = events.at(-1);
  if (
    first?.sequence !== 0 ||
    first.previous.kind !== 'Genesis' ||
    events.filter((event) => event.detail.kind === 'EvaluationBudgetCovered').length !== 1 ||
    last?.detail.kind !== 'EvaluationBudgetCovered' ||
    last.detail.throughSequence !== last.sequence - 1 ||
    last.detail.throughHeadSaid !== events.at(-2)?.d
  )
    return false;
  return events.every((event, index) => {
    const previous = events[index - 1];
    return (
      decodeEvaluationEvidenceEvent(event).kind === 'Accepted' &&
      event.sequence === index &&
      (index === 0
        ? event.previous.kind === 'Genesis'
        : event.previous.kind === 'Previous' && event.previous.eventSaid === previous?.d) &&
      event.evaluationId === manifest.evaluationId &&
      event.streamId === first.streamId &&
      event.taskId === manifest.taskId &&
      event.taskRevisionSaid === manifest.taskRevisionSaid &&
      event.originRunId === manifest.originRunId &&
      event.personalAgentAid === manifest.personalAgentAid &&
      event.taskMandateSaid === manifest.taskMandateSaid &&
      (event.phase.kind !== 'Trial' || event.phase.manifestSaid === manifest.d)
    );
  });
}

/** Produces a narrow measured stop-set proof; it does not certify procedural Pass. */
export function prepareProceduralIntegrityProof(input: {
  readonly manifest: EvaluationManifest;
  readonly acceptedEvents: readonly EvaluationEvidenceEvent[];
  readonly scope: TamperAuditScope;
}):
  | {
      readonly kind: 'Prepared';
      readonly proof: ProcedureProof;
      readonly artifact: EvidenceArtifact;
      readonly bytes: Uint8Array;
    }
  | { readonly kind: 'Incomplete' } {
  const { manifest, acceptedEvents, scope: target } = input;
  if (!completePrefix(manifest, acceptedEvents)) return { kind: 'Incomplete' };
  const selected = comparisonSlots().filter((slot) => target === 'Shared' || slot.arm === target);
  const stops: EvaluationEvidenceEvent[] = [];
  for (const slot of selected) {
    const matched = acceptedEvents.filter(
      (event) =>
        event.detail.kind === 'TrialStopped' &&
        event.phase.kind === 'Trial' &&
        event.phase.manifestSaid === manifest.d &&
        event.phase.arm === slot.arm &&
        event.phase.repetition === slot.repetition &&
        event.phase.attempt === slot.attempt &&
        event.harnessRevisionSaid ===
          (slot.arm === 'H1TaskSearch' ? manifest.revisions.H1 : manifest.revisions[slot.arm]),
    );
    if (matched.length !== 1 || matched[0] === undefined) return { kind: 'Incomplete' };
    stops.push(matched[0]);
  }
  const final = acceptedEvents.at(-1);
  if (final === undefined) return { kind: 'Incomplete' };
  const proof: ProcedureProof = {
    version: 1,
    kind: 'TrialStopProcedureProof',
    evaluationId: manifest.evaluationId,
    manifestSaid: manifest.d,
    scope: target,
    throughSequence: final.sequence,
    throughHeadSaid: final.d,
    trialStoppedEventSaids: stops.map((event) => event.d),
    observation: stops.every(
      (event) => event.detail.kind === 'TrialStopped' && event.detail.reason === 'Completed',
    )
      ? 'AllCompleted'
      : 'NotCompleted',
  };
  if (!Value.Check(proofSchema, proof)) return { kind: 'Incomplete' };
  const bytes = Buffer.from(JSON.stringify(proof));
  const artifact = prepareEvidenceArtifact(bytes, 'application/json');
  return artifact.kind === 'Prepared'
    ? { kind: 'Prepared', proof, artifact: artifact.artifact, bytes }
    : { kind: 'Incomplete' };
}

/** Parse is not verification: five claimed role windows still need native capture sources. */
export function decodeTamperAttemptWindow(
  artifact: EvidenceArtifact,
  bytes: Uint8Array,
):
  | { readonly kind: 'ParsedUnverified'; readonly window: AttemptWindow }
  | { readonly kind: 'Rejected' } {
  if (
    decodeEvidenceArtifact(artifact, bytes).kind !== 'Accepted' ||
    artifact.mediaType !== 'application/json'
  )
    return { kind: 'Rejected' };
  let candidate: unknown;
  try {
    candidate = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return { kind: 'Rejected' };
  }
  if (!Value.Check(attemptWindowSchema, candidate)) return { kind: 'Rejected' };
  if (
    !isDeepStrictEqual(
      candidate.roles.map((item) => item.role),
      tamperLifecycleRoles,
    ) ||
    candidate.roles.some((item) => item.openedEventSaid === item.closedEventSaid) ||
    new Set(candidate.roles.flatMap((item) => [item.openedEventSaid, item.closedEventSaid]))
      .size !==
      2 * tamperLifecycleRoles.length ||
    new Set(candidate.roles.flatMap((item) => item.attempts.map((attempt) => attempt.attemptSaid)))
      .size !== candidate.roles.reduce((count, item) => count + item.attempts.length, 0) ||
    Buffer.from(
      JSON.stringify({
        version: candidate.version,
        kind: candidate.kind,
        evaluationId: candidate.evaluationId,
        manifestSaid: candidate.manifestSaid,
        scope: candidate.scope,
        throughHeadSaid: candidate.throughHeadSaid,
        roles: candidate.roles.map((item) => ({
          role: item.role,
          openedEventSaid: item.openedEventSaid,
          closedEventSaid: item.closedEventSaid,
          attempts: item.attempts.map((attempt) => ({
            attemptSaid: attempt.attemptSaid,
            kind: attempt.kind,
          })),
        })),
      }),
    ).compare(Buffer.from(bytes)) !== 0
  )
    return { kind: 'Rejected' };
  return { kind: 'ParsedUnverified', window: candidate };
}

/** Current Evaluation stream can prove an explicit stopped failure, not a five-role clean window. */
export class ParentEvaluationTamperProof implements PromotionTamperProofInspection {
  readonly #manifest: EvaluationManifest;
  readonly #events: readonly EvaluationEvidenceEvent[];

  constructor(manifest: EvaluationManifest, events: readonly EvaluationEvidenceEvent[]) {
    this.#manifest = manifest;
    this.#events = events;
  }

  obligation(
    input: Parameters<PromotionTamperProofInspection['obligation']>[0],
  ): ReturnType<PromotionTamperProofInspection['obligation']> {
    if (input.obligation !== 'proceduralIntegrity') return Promise.resolve({ kind: 'Unavailable' });
    const prepared = prepareProceduralIntegrityProof({
      manifest: this.#manifest,
      acceptedEvents: this.#events,
      scope: input.scope,
    });
    if (
      prepared.kind !== 'Prepared' ||
      input.proofSaid !== prepared.artifact.d ||
      !isDeepStrictEqual(input.artifact, prepared.artifact) ||
      !isDeepStrictEqual(input.bytes, prepared.bytes) ||
      prepared.proof.observation !== 'NotCompleted'
    )
      return Promise.resolve({ kind: 'Unavailable' });
    return Promise.resolve({
      kind: 'Verified',
      scope: input.scope,
      obligation: 'proceduralIntegrity',
      proofSaid: prepared.artifact.d,
      finding: 'Fail',
    });
  }

  coverage(
    input: Parameters<PromotionTamperProofInspection['coverage']>[0],
  ): ReturnType<PromotionTamperProofInspection['coverage']> {
    // The native stream has no Selection/Recording/Propagation boundary events.
    decodeTamperAttemptWindow(input.artifact, input.bytes);
    return Promise.resolve({ kind: 'Unavailable' });
  }
}
