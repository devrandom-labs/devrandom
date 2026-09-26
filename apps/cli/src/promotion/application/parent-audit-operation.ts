import {
  decodeEvidenceArtifact,
  prepareEvidenceArtifact,
  type EvidenceArtifact,
} from '@devrandom/protocol';
import Type from 'typebox';
import Value from 'typebox/value';

const said = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const repetition = Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)]);
const arm = Type.Union([
  Type.Literal('H1'),
  Type.Literal('C1'),
  Type.Literal('C2'),
  Type.Literal('C3'),
  Type.Literal('H1TaskSearch'),
]);
const slot = Type.Object(
  { arm, repetition, attempt: Type.Union([Type.Literal(1), Type.Literal(2)]) },
  { additionalProperties: false },
);
const head = Type.Object({ sequence: count, headSaid: said }, { additionalProperties: false });
const operation = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('TrialExecution'),
      slot,
      sourceSaid: said,
      trialStoppedEventSaid: said,
      cleanupReceiptSaid: said,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('ProtectedGrading'),
      slot,
      taskArtifactSaid: said,
      protectedObservationSaid: said,
      cleanupReceiptSaid: said,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('PublicSearchSelection'),
      repetition,
      firstArtifactSaid: said,
      secondArtifactSaid: said,
      selectedArtifactSaid: said,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('MeasurementDerivation'),
      observationArtifactSaids: Type.Array(said, { minItems: 18, maxItems: 18, uniqueItems: true }),
      measurementArtifactSaids: Type.Array(said, { minItems: 15, maxItems: 15, uniqueItems: true }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('EvidenceRecording'),
      batchSaid: said,
      acceptedThroughSequence: count,
      chainHeadSaid: said,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('EvidencePropagation'),
      throughSequence: count,
      headSaid: said,
      artifactSaids: Type.Array(said, { minItems: 1, maxItems: 512, uniqueItems: true }),
    },
    { additionalProperties: false },
  ),
]);
const inputSchema = Type.Object(
  {
    evaluationId: Type.String({
      pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    }),
    manifestSaid: said,
    scope: Type.Union([Type.Literal('Shared'), arm]),
    opened: head,
    closed: head,
    operation,
  },
  { additionalProperties: false },
);
const receiptSchema = Type.Object(
  {
    version: Type.Literal(1),
    kind: Type.Literal('ParentAuditOperation'),
    ...inputSchema.properties,
    role: Type.Union([
      Type.Literal('Execution'),
      Type.Literal('Evaluation'),
      Type.Literal('Selection'),
      Type.Literal('Recording'),
      Type.Literal('Propagation'),
    ]),
  },
  { additionalProperties: false },
);

export type ParentAuditOperationInput = Type.Static<typeof inputSchema>;
export type ParentAuditOperation = Type.Static<typeof receiptSchema>;
export type PreparedParentAuditOperation =
  | {
      readonly kind: 'Prepared';
      readonly receipt: ParentAuditOperation;
      readonly artifact: EvidenceArtifact;
      readonly bytes: Uint8Array;
    }
  | { readonly kind: 'Rejected' };

function roleOf(detail: ParentAuditOperationInput['operation']): ParentAuditOperation['role'] {
  switch (detail.kind) {
    case 'TrialExecution':
      return 'Execution';
    case 'ProtectedGrading':
      return 'Evaluation';
    case 'PublicSearchSelection':
    case 'MeasurementDerivation':
      return 'Selection';
    case 'EvidenceRecording':
      return 'Recording';
    case 'EvidencePropagation':
      return 'Propagation';
  }
}

function valid(input: ParentAuditOperationInput): boolean {
  if (
    input.opened.sequence > input.closed.sequence ||
    (input.opened.sequence === input.closed.sequence &&
      input.opened.headSaid !== input.closed.headSaid)
  )
    return false;
  const detail = input.operation;
  switch (detail.kind) {
    case 'TrialExecution':
    case 'ProtectedGrading':
      return (
        input.scope === detail.slot.arm &&
        (detail.slot.arm === 'H1TaskSearch' || detail.slot.attempt === 1)
      );
    case 'PublicSearchSelection':
      return (
        input.scope === 'H1TaskSearch' &&
        detail.firstArtifactSaid !== detail.secondArtifactSaid &&
        (detail.selectedArtifactSaid === detail.firstArtifactSaid ||
          detail.selectedArtifactSaid === detail.secondArtifactSaid)
      );
    case 'MeasurementDerivation':
      return input.scope === 'Shared';
    case 'EvidenceRecording':
      return (
        detail.acceptedThroughSequence === input.closed.sequence &&
        detail.chainHeadSaid === input.closed.headSaid
      );
    case 'EvidencePropagation':
      return (
        detail.throughSequence === input.closed.sequence &&
        detail.headSaid === input.closed.headSaid
      );
  }
}

/** Capture actual trusted-parent operation inputs/outputs; this is not an audit verdict. */
export function prepareParentAuditOperation(input: unknown): PreparedParentAuditOperation {
  if (!Value.Check(inputSchema, input) || !valid(input)) return { kind: 'Rejected' };
  const receipt: ParentAuditOperation = {
    version: 1,
    kind: 'ParentAuditOperation',
    ...structuredClone(input),
    role: roleOf(input.operation),
  };
  const bytes = Buffer.from(JSON.stringify(receipt));
  const artifact = prepareEvidenceArtifact(bytes, 'application/json');
  return artifact.kind === 'Prepared'
    ? { kind: 'Prepared', receipt, artifact: artifact.artifact, bytes }
    : { kind: 'Rejected' };
}

/** Content identity is checked here; semantic replay is a separate parent responsibility. */
export function decodeParentAuditOperation(
  artifact: EvidenceArtifact,
  bytes: Uint8Array,
):
  | { readonly kind: 'Accepted'; readonly receipt: ParentAuditOperation }
  | { readonly kind: 'Rejected' } {
  if (
    bytes.byteLength > 128 * 1024 ||
    artifact.mediaType !== 'application/json' ||
    decodeEvidenceArtifact(artifact, bytes).kind !== 'Accepted'
  )
    return { kind: 'Rejected' };
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!Value.Check(receiptSchema, parsed)) return { kind: 'Rejected' };
    const prepared = prepareParentAuditOperation({
      evaluationId: parsed.evaluationId,
      manifestSaid: parsed.manifestSaid,
      scope: parsed.scope,
      opened: parsed.opened,
      closed: parsed.closed,
      operation: parsed.operation,
    });
    return prepared.kind === 'Prepared' &&
      prepared.artifact.d === artifact.d &&
      Buffer.from(prepared.bytes).equals(Buffer.from(bytes))
      ? { kind: 'Accepted', receipt: prepared.receipt }
      : { kind: 'Rejected' };
  } catch {
    return { kind: 'Rejected' };
  }
}
