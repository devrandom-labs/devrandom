import { TextDecoder, TextEncoder } from 'node:util';

import {
  assessTamperAuditScope,
  comparisonSlots,
  tamperAuditObligations,
  tamperLifecycleRoles,
  type TamperAuditScopeAssessment,
  type TamperAuditScope,
} from '@devrandom/domain';
import Type from 'typebox';
import Value from 'typebox/value';

import {
  decodeEvidenceArtifact,
  prepareEvidenceArtifact,
  type EvidenceArtifact,
} from '../evidence/evidence-artifact.js';

const said = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const uuid = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const arm = Type.Union(
  (['H1', 'C1', 'C2', 'C3', 'H1TaskSearch'] as const).map((name) => Type.Literal(name)),
);
const slot = Type.Object(
  {
    arm,
    repetition: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)]),
    attempt: Type.Union([Type.Literal(1), Type.Literal(2)]),
  },
  { additionalProperties: false },
);
const scope = Type.Union(
  (['Shared', 'H1', 'C1', 'C2', 'C3', 'H1TaskSearch'] as const).map((name) => Type.Literal(name)),
);
const obligation = Type.Union(tamperAuditObligations.map((name) => Type.Literal(name)));
const verdict = Type.Union(
  (['Pass', 'Fail', 'Incomplete'] as const).map((name) => Type.Literal(name)),
);
const role = Type.Union(tamperLifecycleRoles.map((name) => Type.Literal(name)));
const attemptKind = Type.Union(
  (
    [
      'HeldOutAccess',
      'EvaluatorModification',
      'EvidenceDeletion',
      'CaseOmission',
      'ArtifactSubstitution',
    ] as const
  ).map((name) => Type.Literal(name)),
);

/** E3 checklist 13: exact, ordered references; this document never grades a candidate. */
export const evaluationClosureEvidenceIndexSchema = Type.Object(
  {
    version: Type.Literal(1),
    kind: Type.Literal('EvaluationClosureEvidenceIndex'),
    evaluationId: uuid,
    manifestSaid: said,
    sourceInventorySaid: said,
    hypothesisSaid: said,
    lease: Type.Object(
      { leaseId: uuid, version: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) },
      { additionalProperties: false },
    ),
    observations: Type.Array(
      Type.Object({ slot, artifactSaid: said }, { additionalProperties: false }),
      { minItems: 18, maxItems: 18 },
    ),
    measurements: Type.Array(
      Type.Object({ slot, artifactSaid: said }, { additionalProperties: false }),
      { minItems: 15, maxItems: 15 },
    ),
    audits: Type.Array(
      Type.Object(
        {
          scope,
          assessmentArtifactSaid: said,
          proofs: Type.Array(
            Type.Object(
              {
                scope,
                obligation,
                proofSaid: said,
                finding: Type.Union([Type.Literal('Pass'), Type.Literal('Fail')]),
              },
              { additionalProperties: false },
            ),
            { minItems: 7, maxItems: 7 },
          ),
          attemptCoverage: Type.Object(
            {
              scope,
              proofSaid: said,
              complete: Type.Boolean(),
              coveredRoles: Type.Array(role, { minItems: 5, maxItems: 5 }),
              attempts: Type.Array(
                Type.Object(
                  { attemptSaid: said, role, kind: attemptKind },
                  { additionalProperties: false },
                ),
                { maxItems: 512 },
              ),
            },
            { additionalProperties: false },
          ),
          obligations: Type.Object(
            Object.fromEntries(tamperAuditObligations.map((name) => [name, verdict])) as Record<
              (typeof tamperAuditObligations)[number],
              typeof verdict
            >,
            { additionalProperties: false },
          ),
          verdict,
        },
        { additionalProperties: false },
      ),
      { minItems: 6, maxItems: 6 },
    ),
    budget: Type.Object(
      {
        coverageEventSaid: said,
        totals: Type.Object(
          {
            providerRequests: count,
            providerInputTokens: count,
            providerOutputTokens: count,
            providerSpendMicroUsd: count,
            runWallTimeSeconds: count,
            toolProposals: count,
            aggregateChildCommandTimeSeconds: count,
            changedFiles: count,
            changedWorktreeBytes: count,
          },
          { additionalProperties: false },
        ),
        anchors: Type.Array(
          Type.Object(
            {
              dimension: Type.Union(
                (
                  [
                    'providerRequests',
                    'providerInputTokens',
                    'providerOutputTokens',
                    'providerSpendMicroUsd',
                    'runWallTimeSeconds',
                    'toolProposals',
                    'aggregateChildCommandTimeSeconds',
                    'changedFiles',
                    'changedWorktreeBytes',
                  ] as const
                ).map((name) => Type.Literal(name)),
              ),
              finalDebitEventSaid: said,
              receiptArtifactSaid: said,
              sourceEventSaid: said,
            },
            { additionalProperties: false },
          ),
          { minItems: 9, maxItems: 9 },
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type EvaluationClosureEvidenceIndex = Type.Static<
  typeof evaluationClosureEvidenceIndexSchema
>;
export type EvaluationClosureEvidenceIndexRejection =
  | 'SchemaInvalid'
  | 'ScheduleInvalid'
  | 'AuditInvalid'
  | 'ControlFloorFailed'
  | 'BudgetInvalid'
  | 'DuplicateSaid'
  | 'ArtifactTooLarge'
  | 'ArtifactInvalid'
  | 'NoncanonicalBytes';
export type EvaluationClosureEvidenceIndexPreparation =
  | {
      readonly kind: 'Prepared';
      readonly index: EvaluationClosureEvidenceIndex;
      readonly artifact: EvidenceArtifact;
      readonly bytes: Uint8Array;
    }
  | { readonly kind: 'Rejected'; readonly reason: EvaluationClosureEvidenceIndexRejection };
export type EvaluationClosureEvidenceIndexDecoding =
  | {
      readonly kind: 'Accepted';
      readonly index: EvaluationClosureEvidenceIndex;
      readonly artifact: EvidenceArtifact;
      readonly bytes: Uint8Array;
    }
  | { readonly kind: 'Rejected'; readonly reason: EvaluationClosureEvidenceIndexRejection };

const scopes: readonly TamperAuditScope[] = ['Shared', 'H1', 'C1', 'C2', 'C3', 'H1TaskSearch'];
const dimensions = [
  'providerRequests',
  'providerInputTokens',
  'providerOutputTokens',
  'providerSpendMicroUsd',
  'runWallTimeSeconds',
  'toolProposals',
  'aggregateChildCommandTimeSeconds',
  'changedFiles',
  'changedWorktreeBytes',
] as const;
const maximumBytes = 128 * 1024;

export const evaluationAuditAssessmentSchema = Type.Object(
  {
    scope,
    obligations: Type.Object(
      Object.fromEntries(tamperAuditObligations.map((name) => [name, verdict])) as Record<
        (typeof tamperAuditObligations)[number],
        typeof verdict
      >,
      { additionalProperties: false },
    ),
    verdict,
    proofSaids: Type.Array(said, { maxItems: 520, uniqueItems: true }),
  },
  { additionalProperties: false },
);

export type EvaluationAuditAssessmentPreparation =
  | {
      readonly kind: 'Prepared';
      readonly assessment: TamperAuditScopeAssessment;
      readonly artifact: EvidenceArtifact;
      readonly bytes: Uint8Array;
    }
  | {
      readonly kind: 'Rejected';
      readonly reason: 'SchemaInvalid' | 'NoncanonicalBytes' | 'ArtifactInvalid';
    };
export type EvaluationAuditAssessmentDecoding =
  | {
      readonly kind: 'Accepted';
      readonly assessment: TamperAuditScopeAssessment;
      readonly artifact: EvidenceArtifact;
      readonly bytes: Uint8Array;
    }
  | {
      readonly kind: 'Rejected';
      readonly reason: 'SchemaInvalid' | 'NoncanonicalBytes' | 'ArtifactInvalid';
    };

function sameSlot(
  first: { arm: string; repetition: number; attempt: number },
  second: typeof first,
) {
  return (
    first.arm === second.arm &&
    first.repetition === second.repetition &&
    first.attempt === second.attempt
  );
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function invalidIndex(
  index: EvaluationClosureEvidenceIndex,
): EvaluationClosureEvidenceIndexRejection | undefined {
  const expected = comparisonSlots();
  if (
    index.observations.some((entry, position) => {
      const scheduled = expected[position];
      return scheduled === undefined || !sameSlot(entry.slot, scheduled);
    }) ||
    index.measurements.some((entry, position) => {
      const measured = expected.filter((slot) => slot.attempt === 1)[position];
      return (
        measured === undefined ||
        entry.slot.arm !== measured.arm ||
        entry.slot.repetition !== measured.repetition ||
        (entry.slot.arm !== 'H1TaskSearch' && entry.slot.attempt !== 1)
      );
    })
  )
    return 'ScheduleInvalid';
  const artifactSaids = [
    ...index.observations.map((entry) => entry.artifactSaid),
    ...index.measurements.map((entry) => entry.artifactSaid),
    ...index.audits.map((audit) => audit.assessmentArtifactSaid),
  ];
  if (!unique(artifactSaids)) return 'DuplicateSaid';
  for (const [position, audit] of index.audits.entries()) {
    if (
      audit.scope !== scopes[position] ||
      audit.proofs.some(
        (proof, proofPosition) =>
          proof.scope !== audit.scope || proof.obligation !== tamperAuditObligations[proofPosition],
      ) ||
      audit.attemptCoverage.scope !== audit.scope ||
      audit.attemptCoverage.coveredRoles.some(
        (role, rolePosition) => role !== tamperLifecycleRoles[rolePosition],
      ) ||
      audit.attemptCoverage.attempts.some(
        (attempt) => !audit.attemptCoverage.coveredRoles.includes(attempt.role),
      )
    )
      return 'AuditInvalid';
    const proofSaids = [
      ...audit.proofs.map((proof) => proof.proofSaid),
      audit.attemptCoverage.proofSaid,
      ...audit.attemptCoverage.attempts.map((attempt) => attempt.attemptSaid),
    ];
    if (!unique(proofSaids)) return 'DuplicateSaid';
    const assessed = assessTamperAuditScope({
      scope: audit.scope,
      proofs: audit.proofs,
      attemptCoverage: [audit.attemptCoverage],
    });
    if (
      audit.verdict !== assessed.verdict ||
      tamperAuditObligations.some(
        (obligation) => audit.obligations[obligation] !== assessed.obligations[obligation],
      )
    )
      return 'AuditInvalid';
    if (
      (audit.scope === 'Shared' || audit.scope === 'H1' || audit.scope === 'H1TaskSearch') &&
      audit.verdict !== 'Pass'
    )
      return 'ControlFloorFailed';
  }
  if (
    index.budget.anchors.some((anchor, position) => anchor.dimension !== dimensions[position]) ||
    !unique(index.budget.anchors.map((anchor) => anchor.finalDebitEventSaid)) ||
    !unique(index.budget.anchors.map((anchor) => anchor.receiptArtifactSaid)) ||
    index.budget.anchors.some(
      (anchor) => anchor.finalDebitEventSaid === index.budget.coverageEventSaid,
    )
  )
    return 'BudgetInvalid';
  return undefined;
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([first], [second]) => (first < second ? -1 : first > second ? 1 : 0))
        .map(([key, item]) => [key, sorted(item)]),
    );
  }
  return value;
}

function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(sorted(value)));
}

/** Exact public assessment report bytes, independent of transport JSON key order. */
export function prepareEvaluationAuditAssessmentArtifact(
  input: unknown,
): EvaluationAuditAssessmentPreparation {
  if (
    !Value.Check(evaluationAuditAssessmentSchema, input) ||
    input.proofSaids.some((proofSaid, position) => {
      const previous = input.proofSaids[position - 1];
      return previous !== undefined && proofSaid <= previous;
    })
  )
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  const bytes = canonicalJsonBytes(input);
  const prepared = prepareEvidenceArtifact(bytes, 'application/json');
  if (prepared.kind !== 'Prepared') return { kind: 'Rejected', reason: 'ArtifactInvalid' };
  return {
    kind: 'Prepared',
    assessment: structuredClone(input),
    artifact: prepared.artifact,
    bytes,
  };
}

export function decodeEvaluationAuditAssessmentArtifact(
  artifact: unknown,
  bytes: Uint8Array,
): EvaluationAuditAssessmentDecoding {
  if (bytes.byteLength > maximumBytes) return { kind: 'Rejected', reason: 'ArtifactInvalid' };
  const decoded = decodeEvidenceArtifact(artifact, bytes);
  if (decoded.kind !== 'Accepted' || decoded.artifact.mediaType !== 'application/json')
    return { kind: 'Rejected', reason: 'ArtifactInvalid' };
  let input: unknown;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    input = JSON.parse(text) as unknown;
  } catch {
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  }
  const prepared = prepareEvaluationAuditAssessmentArtifact(input);
  if (prepared.kind !== 'Prepared') return prepared;
  if (text !== new TextDecoder().decode(prepared.bytes))
    return { kind: 'Rejected', reason: 'NoncanonicalBytes' };
  return {
    kind: 'Accepted',
    assessment: prepared.assessment,
    artifact: decoded.artifact,
    bytes: Uint8Array.from(bytes),
  };
}

export function prepareEvaluationClosureEvidenceIndex(
  input: unknown,
): EvaluationClosureEvidenceIndexPreparation {
  if (!Value.Check(evaluationClosureEvidenceIndexSchema, input))
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  const invalid = invalidIndex(input);
  if (invalid !== undefined) return { kind: 'Rejected', reason: invalid };
  const index = structuredClone(input);
  const bytes = canonicalJsonBytes(index);
  if (bytes.byteLength > maximumBytes) return { kind: 'Rejected', reason: 'ArtifactTooLarge' };
  const prepared = prepareEvidenceArtifact(bytes, 'application/json');
  if (prepared.kind !== 'Prepared') return { kind: 'Rejected', reason: 'ArtifactInvalid' };
  return { kind: 'Prepared', index, artifact: prepared.artifact, bytes };
}

export function decodeEvaluationClosureEvidenceIndex(
  artifact: unknown,
  bytes: Uint8Array,
): EvaluationClosureEvidenceIndexDecoding {
  if (bytes.byteLength > maximumBytes) return { kind: 'Rejected', reason: 'ArtifactTooLarge' };
  const decodedArtifact = decodeEvidenceArtifact(artifact, bytes);
  if (
    decodedArtifact.kind !== 'Accepted' ||
    decodedArtifact.artifact.mediaType !== 'application/json'
  )
    return { kind: 'Rejected', reason: 'ArtifactInvalid' };
  let input: unknown;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    input = JSON.parse(text) as unknown;
  } catch {
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  }
  if (!Value.Check(evaluationClosureEvidenceIndexSchema, input))
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  if (text !== new TextDecoder().decode(canonicalJsonBytes(input)))
    return { kind: 'Rejected', reason: 'NoncanonicalBytes' };
  const invalid = invalidIndex(input);
  if (invalid !== undefined) return { kind: 'Rejected', reason: invalid };
  return {
    kind: 'Accepted',
    index: input,
    artifact: decodedArtifact.artifact,
    bytes: Uint8Array.from(bytes),
  };
}
