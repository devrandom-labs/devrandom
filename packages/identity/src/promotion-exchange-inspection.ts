import { isDeepStrictEqual } from 'node:util';

import {
  governorPromotionDecisionExchangeRoute,
  governorPromotionDecisionPayloadSchema,
  promotionProposalExchangeRoute,
  promotionProposalPayloadSchema,
  type GovernorPromotionDecisionPayload,
  type PromotionProposalPayload,
} from '@devrandom/protocol';
import { Saider, type SignifyClient } from 'signify-ts';
import Type from 'typebox';
import Value from 'typebox/value';

import type { GovernorAid, IssuerAid, PersonalAgentAid } from './keri-identifier.js';

const said = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const exchange = Type.Object(
  {
    v: Type.String({ minLength: 1 }),
    t: Type.Literal('exn'),
    d: said,
    i: said,
    rp: said,
    p: Type.String(),
    dt: Type.String({ minLength: 1 }),
    r: Type.String({ minLength: 1 }),
    q: Type.Object({}, { additionalProperties: true }),
    a: Type.Object({ i: said }, { additionalProperties: true }),
    e: Type.Object({}, { additionalProperties: true }),
  },
  { additionalProperties: false },
);
const resource = Type.Object({ exn: Type.Unknown() }, { additionalProperties: true });

export interface PromotionExchangeExpectation<Payload> {
  readonly exchangeSaid: string;
  readonly sourceAid: string;
  readonly recipientAid: IssuerAid;
  readonly payload: Payload;
}

export interface PromotionExchangePair {
  readonly proposal: PromotionExchangeExpectation<PromotionProposalPayload> & {
    readonly sourceAid: PersonalAgentAid;
  };
  readonly decision: PromotionExchangeExpectation<GovernorPromotionDecisionPayload> & {
    readonly sourceAid: GovernorAid;
  };
}

export type PromotionExchangeInspection =
  | {
      readonly kind: 'Verified';
      readonly proposalExchangeSaid: string;
      readonly agentAid: PersonalAgentAid;
      readonly decisionExchangeSaid: string;
      readonly governorAid: GovernorAid;
    }
  | { readonly kind: 'Rejected'; readonly reason: 'Binding' | 'Malformed' | 'Said' }
  | { readonly kind: 'Pending' }
  | { readonly kind: 'Unavailable'; readonly dependency: 'Keria' };

/** KERIA's issuer-side exchange read supplies signature/source authentication. */
export interface IssuerPromotionExchanges {
  inspect(expected: PromotionExchangePair): Promise<PromotionExchangeInspection>;
}

function match(
  untrusted: unknown,
  expected: PromotionExchangeExpectation<
    PromotionProposalPayload | GovernorPromotionDecisionPayload
  >,
  route: string,
  payloadSchema:
    typeof promotionProposalPayloadSchema | typeof governorPromotionDecisionPayloadSchema,
): Extract<PromotionExchangeInspection, { kind: 'Rejected' }> | { kind: 'Matched' } {
  if (!Value.Check(exchange, untrusted)) return { kind: 'Rejected', reason: 'Malformed' };
  if (untrusted.d !== expected.exchangeSaid) return { kind: 'Rejected', reason: 'Said' };
  const { i: recipientAid, ...payload } = untrusted.a;
  if (
    untrusted.r !== route ||
    untrusted.i !== expected.sourceAid ||
    untrusted.rp !== expected.recipientAid ||
    recipientAid !== expected.recipientAid ||
    !Value.Check(payloadSchema, payload) ||
    !isDeepStrictEqual(payload, expected.payload)
  )
    return { kind: 'Rejected', reason: 'Binding' };
  try {
    return new Saider({ qb64: untrusted.d }).verify(untrusted, true, true)
      ? { kind: 'Matched' }
      : { kind: 'Rejected', reason: 'Said' };
  } catch {
    return { kind: 'Rejected', reason: 'Said' };
  }
}

function missing(cause: unknown, exchangeSaid: string): boolean {
  return (
    cause instanceof Error && cause.message.startsWith(`HTTP GET /exchanges/${exchangeSaid} - 404 `)
  );
}

async function read(
  client: SignifyClient,
  expected: PromotionExchangeExpectation<
    PromotionProposalPayload | GovernorPromotionDecisionPayload
  >,
  route: string,
  schema: typeof promotionProposalPayloadSchema | typeof governorPromotionDecisionPayloadSchema,
): Promise<PromotionExchangeInspection | { kind: 'Matched' }> {
  try {
    const retrieved: unknown = await client.exchanges().get(expected.exchangeSaid);
    if (!Value.Check(resource, retrieved)) return { kind: 'Rejected', reason: 'Malformed' };
    return match(retrieved.exn, expected, route, schema);
  } catch (cause) {
    return missing(cause, expected.exchangeSaid)
      ? { kind: 'Pending' }
      : { kind: 'Unavailable', dependency: 'Keria' };
  }
}

export function signifyIssuerPromotionExchanges(client: SignifyClient): IssuerPromotionExchanges {
  return {
    async inspect(expected) {
      if (
        String(expected.proposal.sourceAid) === String(expected.decision.sourceAid) ||
        expected.proposal.recipientAid !== expected.decision.recipientAid ||
        expected.decision.payload.agentProposalExchangeSaid !== expected.proposal.exchangeSaid
      )
        return { kind: 'Rejected', reason: 'Binding' };
      const proposal = await read(
        client,
        expected.proposal,
        promotionProposalExchangeRoute,
        promotionProposalPayloadSchema,
      );
      if (proposal.kind !== 'Matched') return proposal;
      const decision = await read(
        client,
        expected.decision,
        governorPromotionDecisionExchangeRoute,
        governorPromotionDecisionPayloadSchema,
      );
      if (decision.kind !== 'Matched') return decision;
      return {
        kind: 'Verified',
        proposalExchangeSaid: expected.proposal.exchangeSaid,
        agentAid: expected.proposal.sourceAid,
        decisionExchangeSaid: expected.decision.exchangeSaid,
        governorAid: expected.decision.sourceAid,
      };
    },
  };
}
