import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import Type from 'typebox';
import Value from 'typebox/value';

import {
  decodePromotionSelectionRecord,
  promotionSelectionRecordSchema,
} from './selection-record.js';

const said = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const uuid = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const fingerprint = Type.String({ pattern: '^sha256:[a-f0-9]{64}$' });

export const activationDispositionSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('Activate'),
      selectionEvidenceSaid: said,
      candidateRevisionSaid: said,
      artifactSaids: Type.Array(said, { minItems: 3, maxItems: 3 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('RetainIncumbent'),
      selectionEvidenceSaid: said,
    },
    { additionalProperties: false },
  ),
]);

export const activationCommitCommandInputSchema = Type.Object(
  {
    version: Type.Literal(1),
    commandId: uuid,
    taskId: uuid,
    taskRevisionSaid: said,
    harnessLineageId: uuid,
    expectedIncumbentRevisionSaid: said,
    expectedPointerVersion: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    evaluationManifestSaid: said,
    evaluationClosureSaid: said,
    exactPromotionMandateSaid: said,
    agentProposalExchangeSaid: said,
    governorDecisionExchangeSaid: said,
    selectionRecord: promotionSelectionRecordSchema,
    disposition: activationDispositionSchema,
  },
  { additionalProperties: false },
);

export const activationCommitCommandSchema = Type.Object(
  {
    ...activationCommitCommandInputSchema.properties,
    fingerprint,
  },
  { additionalProperties: false },
);

export const activationCommitReceiptSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Union([Type.Literal('Committed'), Type.Literal('AlreadyCommitted')]),
      decisionReceiptSaid: said,
      activeRevisionSaid: said,
      pointerVersion: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
      disposition: Type.Union([Type.Literal('Activated'), Type.Literal('Retained')]),
    },
    { additionalProperties: false },
  ),
  Type.Object({ kind: Type.Literal('Conflict') }, { additionalProperties: false }),
  Type.Object(
    {
      kind: Type.Literal('Rejected'),
      gate: Type.Union([
        Type.Literal('Authority'),
        Type.Literal('Evidence'),
        Type.Literal('Signature'),
        Type.Literal('Mandate'),
        Type.Literal('Selection'),
      ]),
    },
    { additionalProperties: false },
  ),
  Type.Object({ kind: Type.Literal('Unavailable') }, { additionalProperties: false }),
]);

export type ActivationCommitCommandInput = Type.Static<typeof activationCommitCommandInputSchema>;
export type ActivationCommitCommand = Type.Static<typeof activationCommitCommandSchema>;
export type ActivationCommitReceipt = Type.Static<typeof activationCommitReceiptSchema>;
export type ActivationCommandPreparation =
  | { readonly kind: 'Prepared'; readonly command: ActivationCommitCommand }
  | {
      readonly kind: 'Rejected';
      readonly reason: 'SchemaInvalid' | 'IncumbentAsSuccessor' | 'SelectionRecordMismatch';
    };
export type ActivationCommandDecoding =
  | { readonly kind: 'Accepted'; readonly command: ActivationCommitCommand }
  | {
      readonly kind: 'Rejected';
      readonly reason:
        | 'SchemaInvalid'
        | 'IncumbentAsSuccessor'
        | 'SelectionRecordMismatch'
        | 'FingerprintMismatch';
    };

function canonical(input: ActivationCommitCommandInput): ActivationCommitCommandInput {
  return {
    version: 1,
    commandId: input.commandId,
    taskId: input.taskId,
    taskRevisionSaid: input.taskRevisionSaid,
    harnessLineageId: input.harnessLineageId,
    expectedIncumbentRevisionSaid: input.expectedIncumbentRevisionSaid,
    expectedPointerVersion: input.expectedPointerVersion,
    evaluationManifestSaid: input.evaluationManifestSaid,
    evaluationClosureSaid: input.evaluationClosureSaid,
    exactPromotionMandateSaid: input.exactPromotionMandateSaid,
    agentProposalExchangeSaid: input.agentProposalExchangeSaid,
    governorDecisionExchangeSaid: input.governorDecisionExchangeSaid,
    selectionRecord: structuredClone(input.selectionRecord),
    disposition:
      input.disposition.kind === 'Activate'
        ? {
            kind: 'Activate',
            selectionEvidenceSaid: input.disposition.selectionEvidenceSaid,
            candidateRevisionSaid: input.disposition.candidateRevisionSaid,
            artifactSaids: [...input.disposition.artifactSaids],
          }
        : {
            kind: 'RetainIncumbent',
            selectionEvidenceSaid: input.disposition.selectionEvidenceSaid,
          },
  };
}

export function activationCommitCommandFingerprint(input: ActivationCommitCommandInput): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(canonical(input)))
    .digest('hex')}`;
}

function incumbentAsSuccessor(input: ActivationCommitCommandInput): boolean {
  return (
    input.disposition.kind === 'Activate' &&
    input.disposition.candidateRevisionSaid === input.expectedIncumbentRevisionSaid
  );
}

function selectionRecordMatches(input: ActivationCommitCommandInput): boolean {
  const record = input.selectionRecord;
  if (decodePromotionSelectionRecord(record).kind !== 'Accepted') return false;
  return (
    record.taskId === input.taskId &&
    record.taskRevisionSaid === input.taskRevisionSaid &&
    record.harnessLineageId === input.harnessLineageId &&
    record.expectedIncumbentRevisionSaid === input.expectedIncumbentRevisionSaid &&
    record.expectedPointerVersion === input.expectedPointerVersion &&
    record.evaluationManifestSaid === input.evaluationManifestSaid &&
    record.evaluationClosureSaid === input.evaluationClosureSaid &&
    record.d === input.disposition.selectionEvidenceSaid &&
    isDeepStrictEqual(
      record.selection,
      input.disposition.kind === 'Activate'
        ? {
            kind: 'Activate',
            candidateRevisionSaid: input.disposition.candidateRevisionSaid,
            artifactSaids: input.disposition.artifactSaids,
          }
        : { kind: 'RetainIncumbent' },
    )
  );
}

export function prepareActivationCommitCommand(input: unknown): ActivationCommandPreparation {
  if (!Value.Check(activationCommitCommandInputSchema, input))
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  if (incumbentAsSuccessor(input)) return { kind: 'Rejected', reason: 'IncumbentAsSuccessor' };
  if (!selectionRecordMatches(input))
    return { kind: 'Rejected', reason: 'SelectionRecordMismatch' };
  const body = canonical(input);
  return {
    kind: 'Prepared',
    command: { ...body, fingerprint: activationCommitCommandFingerprint(body) },
  };
}

export function decodeActivationCommitCommand(input: unknown): ActivationCommandDecoding {
  if (!Value.Check(activationCommitCommandSchema, input))
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  if (incumbentAsSuccessor(input)) return { kind: 'Rejected', reason: 'IncumbentAsSuccessor' };
  if (!selectionRecordMatches(input))
    return { kind: 'Rejected', reason: 'SelectionRecordMismatch' };
  if (input.fingerprint !== activationCommitCommandFingerprint(input))
    return { kind: 'Rejected', reason: 'FingerprintMismatch' };
  return { kind: 'Accepted', command: canonicalCommand(input) };
}

function canonicalCommand(input: ActivationCommitCommand): ActivationCommitCommand {
  return { ...canonical(input), fingerprint: input.fingerprint };
}
