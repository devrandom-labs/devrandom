import { isDeepStrictEqual } from 'node:util';

import Type from 'typebox';
import Value from 'typebox/value';

import { activationDispositionSchema, type ActivationCommitCommand } from './activation-command.js';

const said = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const uuid = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});

export const promotionProposalExchangeRoute = '/devrandom/promotion/proposal/1' as const;
export const governorPromotionDecisionExchangeRoute = '/devrandom/promotion/decision/1' as const;

const commonPromotionBinding = {
  taskId: uuid,
  taskRevisionSaid: said,
  harnessLineageId: uuid,
  expectedIncumbentRevisionSaid: said,
  expectedPointerVersion: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  evaluationManifestSaid: said,
  evaluationClosureSaid: said,
  disposition: activationDispositionSchema,
} as const;

/** The EXN source AID, route and SAID are verified by the native Signify adapter. */
export const promotionProposalPayloadSchema = Type.Object(
  {
    version: Type.Literal(1),
    kind: Type.Literal('PromotionProposal'),
    ...commonPromotionBinding,
    hypothesisSaid: said,
  },
  { additionalProperties: false },
);

/** The Governor signs after independently checking M, evidence and exact-M authority. */
export const governorPromotionDecisionPayloadSchema = Type.Object(
  {
    version: Type.Literal(1),
    kind: Type.Literal('GovernorPromotionDecision'),
    ...commonPromotionBinding,
    exactPromotionMandateSaid: said,
    agentProposalExchangeSaid: said,
  },
  { additionalProperties: false },
);

export type PromotionProposalPayload = Type.Static<typeof promotionProposalPayloadSchema>;
export type GovernorPromotionDecisionPayload = Type.Static<
  typeof governorPromotionDecisionPayloadSchema
>;

/** Semantic equality only; callers must first verify both signed EXNs and their distinct AIDs. */
export function activationExchangeBindings(
  command: ActivationCommitCommand,
  proposal: unknown,
  decision: unknown,
): 'Matched' | 'Mismatch' {
  if (
    !Value.Check(promotionProposalPayloadSchema, proposal) ||
    !Value.Check(governorPromotionDecisionPayloadSchema, decision)
  )
    return 'Mismatch';
  const commonMatches = [proposal, decision].every(
    (payload) =>
      payload.taskId === command.taskId &&
      payload.taskRevisionSaid === command.taskRevisionSaid &&
      payload.harnessLineageId === command.harnessLineageId &&
      payload.expectedIncumbentRevisionSaid === command.expectedIncumbentRevisionSaid &&
      payload.expectedPointerVersion === command.expectedPointerVersion &&
      payload.evaluationManifestSaid === command.evaluationManifestSaid &&
      payload.evaluationClosureSaid === command.evaluationClosureSaid &&
      isDeepStrictEqual(payload.disposition, command.disposition),
  );
  return commonMatches &&
    proposal.hypothesisSaid === command.selectionRecord.hypothesisSaid &&
    decision.exactPromotionMandateSaid === command.exactPromotionMandateSaid &&
    decision.agentProposalExchangeSaid === command.agentProposalExchangeSaid
    ? 'Matched'
    : 'Mismatch';
}
