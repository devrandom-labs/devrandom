import Type from 'typebox';
import Value from 'typebox/value';

import { evaluationClosureInputSchema, type EvaluationClosure } from './closure.js';

/** The agent signs the claim before the resulting exchange SAID is added to the closure. */
export const evaluationClosureSealExchangeRoute = '/devrandom/evaluation/closure/1' as const;

export const evaluationClosureSealClaimSchema = Type.Object(
  {
    evaluationId: evaluationClosureInputSchema.properties.evaluationId,
    evidenceStreamId: evaluationClosureInputSchema.properties.evidenceStreamId,
    originRunId: evaluationClosureInputSchema.properties.originRunId,
    manifestSaid: evaluationClosureInputSchema.properties.manifestSaid,
    acceptedEventCount: evaluationClosureInputSchema.properties.acceptedEventCount,
    acceptedHeadSaid: evaluationClosureInputSchema.properties.acceptedHeadSaid,
    observationSaids: evaluationClosureInputSchema.properties.observationSaids,
    measurementSaids: evaluationClosureInputSchema.properties.measurementSaids,
    sharedAuditSaid: evaluationClosureInputSchema.properties.sharedAuditSaid,
    armAuditSaids: evaluationClosureInputSchema.properties.armAuditSaids,
    protectedCustodySaid: evaluationClosureInputSchema.properties.protectedCustodySaid,
  },
  { additionalProperties: false },
);
export const evaluationClosureSealPayloadSchema = Type.Object(
  {
    version: Type.Literal(1),
    kind: Type.Literal('EvaluationClosureSeal'),
    claim: evaluationClosureSealClaimSchema,
  },
  { additionalProperties: false },
);

export type EvaluationClosureSealClaim = Type.Static<typeof evaluationClosureSealClaimSchema>;
export type EvaluationClosureSealPayload = Type.Static<typeof evaluationClosureSealPayloadSchema>;
export type EvaluationClosureSealPayloadDecoding =
  | { readonly kind: 'Accepted'; readonly payload: EvaluationClosureSealPayload }
  | { readonly kind: 'Rejected'; readonly reason: 'SchemaInvalid' | 'ClaimIncomplete' };

function claimIncomplete(claim: EvaluationClosureSealClaim): boolean {
  return (
    new Set(claim.observationSaids).size !== 18 ||
    new Set(claim.measurementSaids).size !== 15 ||
    claim.evaluationId === claim.originRunId ||
    claim.evidenceStreamId === claim.originRunId ||
    claim.evidenceStreamId === claim.evaluationId
  );
}

export function decodeEvaluationClosureSealPayload(
  input: unknown,
): EvaluationClosureSealPayloadDecoding {
  if (!Value.Check(evaluationClosureSealPayloadSchema, input)) {
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  }
  if (claimIncomplete(input.claim)) return { kind: 'Rejected', reason: 'ClaimIncomplete' };
  return { kind: 'Accepted', payload: structuredClone(input) };
}

export function evaluationClosureSealPayload(
  closure: EvaluationClosure,
): EvaluationClosureSealPayload {
  return {
    version: 1,
    kind: 'EvaluationClosureSeal',
    claim: {
      evaluationId: closure.evaluationId,
      evidenceStreamId: closure.evidenceStreamId,
      originRunId: closure.originRunId,
      manifestSaid: closure.manifestSaid,
      acceptedEventCount: closure.acceptedEventCount,
      acceptedHeadSaid: closure.acceptedHeadSaid,
      observationSaids: closure.observationSaids,
      measurementSaids: closure.measurementSaids,
      sharedAuditSaid: closure.sharedAuditSaid,
      armAuditSaids: closure.armAuditSaids,
      protectedCustodySaid: closure.protectedCustodySaid,
    },
  };
}
