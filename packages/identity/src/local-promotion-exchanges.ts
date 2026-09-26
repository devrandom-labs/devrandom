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

import { IdentityFailure } from './identity-error.js';
import type {
  AgentAid,
  ControllerAid,
  GovernorAid,
  IssuerAid,
  PersonalAgentAid,
} from './keri-identifier.js';
import type { GOVERNOR_ALIAS, PERSONAL_AGENT_ALIAS } from './local-principal-custody.js';
import {
  connectSignifyController,
  type ConnectedSignifyController,
  type SignifyControllerConfiguration,
} from './signify-controller.js';

export type StablePromotionExchange =
  | {
      readonly kind: 'Proposal';
      readonly senderAlias: typeof PERSONAL_AGENT_ALIAS;
      readonly sourceAid: PersonalAgentAid;
      readonly recipientAid: IssuerAid;
      readonly preparedAt: number;
      readonly payload: PromotionProposalPayload;
    }
  | {
      readonly kind: 'GovernorDecision';
      readonly senderAlias: typeof GOVERNOR_ALIAS;
      readonly sourceAid: GovernorAid;
      readonly recipientAid: IssuerAid;
      readonly preparedAt: number;
      readonly payload: GovernorPromotionDecisionPayload;
    };

export interface PreparedPromotionExchange {
  readonly exchangeSaid: string;
}

export interface LocalPromotionExchanges {
  prepare(input: StablePromotionExchange): Promise<PreparedPromotionExchange>;
  deliver(
    input: StablePromotionExchange & PreparedPromotionExchange,
  ): Promise<PreparedPromotionExchange>;
}

export interface LocalPromotionExchangeConnection extends SignifyControllerConfiguration {
  readonly expectedControllerAid: ControllerAid;
  readonly expectedAgentAid: AgentAid;
}

const said = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const resource = Type.Object({ exn: Type.Unknown() }, { additionalProperties: true });
const envelope = Type.Object(
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

function invalid(reason: string): never {
  throw new IdentityFailure({
    kind: 'keria-response-invalid',
    stage: 'Promotion exchange',
    reason,
  });
}

function route(input: StablePromotionExchange): string {
  return input.kind === 'Proposal'
    ? promotionProposalExchangeRoute
    : governorPromotionDecisionExchangeRoute;
}

function exactExchange(
  untrusted: unknown,
  input: StablePromotionExchange & PreparedPromotionExchange,
): PreparedPromotionExchange {
  if (!Value.Check(envelope, untrusted)) return invalid('native EXN is malformed');
  const { i: recipientAid, ...payload } = untrusted.a;
  if (
    untrusted.d !== input.exchangeSaid ||
    untrusted.r !== route(input) ||
    untrusted.i !== input.sourceAid ||
    untrusted.rp !== input.recipientAid ||
    recipientAid !== input.recipientAid ||
    !isDeepStrictEqual(payload, input.payload)
  )
    return invalid('native EXN differs from stable principal or decision');
  try {
    if (!new Saider({ qb64: untrusted.d }).verify(untrusted, true, true))
      return invalid('native EXN SAID is invalid');
  } catch {
    return invalid('native EXN SAID is invalid');
  }
  return { exchangeSaid: untrusted.d };
}

function datetime(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) return invalid('preparation time is invalid');
  return new Date(value).toISOString().replace('Z', '000+00:00');
}

function exchangeNotFound(cause: unknown, exchangeSaid: string): boolean {
  return (
    cause instanceof Error && cause.message.startsWith(`HTTP GET /exchanges/${exchangeSaid} - 404 `)
  );
}

async function readExchange(client: SignifyClient, exchangeSaid: string): Promise<unknown> {
  try {
    const found: unknown = await client.exchanges().get(exchangeSaid);
    if (!Value.Check(resource, found)) return invalid('native EXN resource is malformed');
    return found.exn;
  } catch (cause) {
    if (exchangeNotFound(cause, exchangeSaid)) return undefined;
    throw cause;
  }
}

async function createExchange(client: SignifyClient, input: StablePromotionExchange) {
  if (
    (input.kind === 'Proposal' && !Value.Check(promotionProposalPayloadSchema, input.payload)) ||
    (input.kind === 'GovernorDecision' &&
      !Value.Check(governorPromotionDecisionPayloadSchema, input.payload))
  )
    return invalid('promotion payload does not match its closed contract');
  const sender = await client.identifiers().get(input.senderAlias);
  if (sender.prefix !== input.sourceAid)
    return invalid('sender alias differs from expected principal AID');
  const prepared = await client
    .exchanges()
    .createExchangeMessage(
      sender,
      route(input),
      input.payload,
      {},
      input.recipientAid,
      datetime(input.preparedAt),
    );
  exactExchange(prepared[0].sad, { ...input, exchangeSaid: prepared[0].said });
  return prepared;
}

/** Signing requires the recovered local controller and the exact managed AID. */
export async function connectLocalPromotionExchanges(
  input: LocalPromotionExchangeConnection,
  connectController: (
    configuration: SignifyControllerConfiguration,
  ) => Promise<ConnectedSignifyController> = connectSignifyController,
): Promise<LocalPromotionExchanges> {
  const connected = await connectController(input);
  if (
    connected.controllerAid !== input.expectedControllerAid ||
    connected.agentAid !== input.expectedAgentAid
  )
    return invalid('local controller or KERIA agent differs from recovered custody');
  return signifyLocalPromotionExchanges(connected.client);
}

export function signifyLocalPromotionExchanges(client: SignifyClient): LocalPromotionExchanges {
  return {
    async prepare(input) {
      const [message] = await createExchange(client, input);
      return { exchangeSaid: message.said };
    },
    async deliver(input) {
      const existing = await readExchange(client, input.exchangeSaid);
      if (existing !== undefined) return exactExchange(existing, input);
      const [message, signatures, attachment] = await createExchange(client, input);
      if (message.said !== input.exchangeSaid)
        return invalid('prepared EXN changed before delivery');
      try {
        await client
          .exchanges()
          .sendFromEvents(
            input.senderAlias,
            input.kind === 'Proposal' ? 'promotion-proposal' : 'promotion-governor-decision',
            message,
            signatures,
            attachment,
            [input.recipientAid],
          );
      } catch (cause) {
        const recovered = await readExchange(client, input.exchangeSaid);
        if (recovered === undefined) throw cause;
        return exactExchange(recovered, input);
      }
      const materialized = await readExchange(client, input.exchangeSaid);
      if (materialized === undefined) return invalid('delivered EXN is absent from KERIA');
      return exactExchange(materialized, input);
    },
  };
}
