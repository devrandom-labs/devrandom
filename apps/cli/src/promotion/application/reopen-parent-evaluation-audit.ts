import { isDeepStrictEqual } from 'node:util';
import {
  decodeEvidenceArtifact,
  type EvaluationClosureEvidenceIndex,
  type EvaluationManifest,
  type EvaluationVerifierBundle,
  type EvaluationEvidenceEvent,
} from '@devrandom/protocol';
import Type from 'typebox';
import Value from 'typebox/value';
import { prepareParentEvaluationAudit } from './prepare-parent-evaluation-audit.js';
import type { ParentAuditSourceReading } from './review-parent-audit-sources.js';

const said = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const sourceProof = Type.Object(
  {
    version: Type.Literal(1),
    kind: Type.Literal('ParentEvaluationAuditProof'),
    evaluationId: Type.String(),
    manifestSaid: said,
    throughSequence: Type.Integer({ minimum: 0, maximum: 9999 }),
    throughHeadSaid: said,
    observationArtifactSaids: Type.Array(said, { minItems: 18, maxItems: 18, uniqueItems: true }),
    measurementArtifactSaids: Type.Array(said, { minItems: 15, maxItems: 15, uniqueItems: true }),
    operationArtifactSaids: Type.Array(said, { minItems: 42, maxItems: 512, uniqueItems: true }),
    scope: Type.Literal('Shared'),
    obligation: Type.Literal('measurementValidity'),
  },
  { additionalProperties: false },
);

/** Replays the pre-audit source prefix named by the accepted closure, not its declared verdict. */
export async function reopenParentEvaluationAudit(
  input: {
    readonly manifest: EvaluationManifest;
    readonly verifier: EvaluationVerifierBundle;
    readonly index: EvaluationClosureEvidenceIndex;
    readonly acceptedEvents: readonly EvaluationEvidenceEvent[];
  },
  ports: ParentAuditSourceReading,
): ReturnType<typeof prepareParentEvaluationAudit> {
  try {
    const first = input.index.audits[0]?.proofs[0];
    if (first?.scope !== 'Shared' || first.obligation !== 'measurementValidity')
      return { kind: 'Incomplete' };
    const raw = await ports.reading.openPublic({
      evaluationId: input.manifest.evaluationId,
      artifactSaid: first.proofSaid,
    });
    if (
      raw.kind !== 'Opened' ||
      raw.artifact.d !== first.proofSaid ||
      raw.artifact.mediaType !== 'application/json' ||
      decodeEvidenceArtifact(raw.artifact, raw.bytes).kind !== 'Accepted'
    )
      return { kind: 'Incomplete' };
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw.bytes));
    if (
      !Value.Check(sourceProof, parsed) ||
      parsed.evaluationId !== input.manifest.evaluationId ||
      parsed.manifestSaid !== input.manifest.d ||
      input.acceptedEvents[parsed.throughSequence]?.d !== parsed.throughHeadSaid ||
      !isDeepStrictEqual(
        parsed.observationArtifactSaids,
        input.index.observations.map((item) => item.artifactSaid),
      ) ||
      !isDeepStrictEqual(
        parsed.measurementArtifactSaids,
        input.index.measurements.map((item) => item.artifactSaid),
      ) ||
      input.acceptedEvents
        .slice(parsed.throughSequence + 1)
        .some(
          (event) =>
            !['ArtifactCaptured', 'EvaluationBudgetDebited', 'EvaluationBudgetCovered'].includes(
              event.detail.kind,
            ),
        )
    )
      return { kind: 'Incomplete' };
    const prepared = await prepareParentEvaluationAudit(
      {
        manifest: input.manifest,
        verifier: input.verifier,
        acceptedEvents: input.acceptedEvents.slice(0, parsed.throughSequence + 1),
        observationArtifactSaids: parsed.observationArtifactSaids,
        measurementArtifactSaids: parsed.measurementArtifactSaids,
        operationArtifactSaids: parsed.operationArtifactSaids,
      },
      ports,
    );
    return prepared.kind === 'Prepared' && isDeepStrictEqual(prepared.audits, input.index.audits)
      ? prepared
      : { kind: 'Incomplete' };
  } catch {
    return { kind: 'Incomplete' };
  }
}
