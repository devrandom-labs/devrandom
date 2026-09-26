import { isDeepStrictEqual } from 'node:util';

import {
  decodeEvaluationClosureSealPayload,
  evaluationClosureSealExchangeRoute,
  evaluationClosureSealPayloadSchema,
  type EvaluationClosureSealPayload,
} from '@devrandom/protocol';
import { Saider, type SignifyClient } from 'signify-ts';
import Type from 'typebox';
import Value from 'typebox/value';

import { IdentityFailure, reasonFromUnknown } from './identity-error.js';
import type { AgentAid, ControllerAid, IssuerAid, PersonalAgentAid } from './keri-identifier.js';
import {
  connectSignifyController,
  type ConnectedSignifyController,
  type SignifyControllerConfiguration,
} from './signify-controller.js';

const saidSchema = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });

export const evaluationClosureSealExchangeEvidenceSchema = Type.Object(
  {
    v: Type.String({ minLength: 1 }),
    t: Type.Literal('exn'),
    d: saidSchema,
    i: saidSchema,
    rp: saidSchema,
    p: Type.String(),
    dt: Type.String({ minLength: 1 }),
    r: Type.String({ minLength: 1 }),
    q: Type.Object({}, { additionalProperties: true }),
    a: Type.Object(
      { i: saidSchema, ...evaluationClosureSealPayloadSchema.properties },
      { additionalProperties: false },
    ),
    e: Type.Object({}, { additionalProperties: true }),
  },
  { additionalProperties: false },
);

export type EvaluationClosureSealExchangeEvidence = Type.Static<
  typeof evaluationClosureSealExchangeEvidenceSchema
>;

export type EvaluationClosureSealExchangeRejection =
  | 'Malformed'
  | 'SaidMismatch'
  | 'RouteMismatch'
  | 'SourceMismatch'
  | 'RecipientMismatch'
  | 'PayloadMismatch';

export interface EvaluationClosureSealExchangeExpectation {
  readonly exchangeSaid: string;
  readonly sourceAid: PersonalAgentAid;
  readonly recipientAid: IssuerAid;
  readonly payload: EvaluationClosureSealPayload;
}

export type EvaluationClosureSealExchangeMatch =
  | {
      readonly kind: 'Verified';
      readonly exchangeSaid: string;
      readonly sourceAid: PersonalAgentAid;
      readonly payload: EvaluationClosureSealPayload;
    }
  | { readonly kind: 'Rejected'; readonly reason: EvaluationClosureSealExchangeRejection };

/** Checks exact content bindings only. Sender authentication comes from KERIA custody. */
export function matchEvaluationClosureSealExchange(
  input: unknown,
  expected: EvaluationClosureSealExchangeExpectation,
): EvaluationClosureSealExchangeMatch {
  if (!Value.Check(evaluationClosureSealExchangeEvidenceSchema, input)) {
    return { kind: 'Rejected', reason: 'Malformed' };
  }
  if (input.d !== expected.exchangeSaid) return { kind: 'Rejected', reason: 'SaidMismatch' };
  if (input.r !== evaluationClosureSealExchangeRoute)
    return { kind: 'Rejected', reason: 'RouteMismatch' };
  if (input.i !== expected.sourceAid) return { kind: 'Rejected', reason: 'SourceMismatch' };
  const { i: recipientAid, ...untrustedPayload } = input.a;
  if (input.rp !== expected.recipientAid || recipientAid !== expected.recipientAid)
    return { kind: 'Rejected', reason: 'RecipientMismatch' };
  const decoded = decodeEvaluationClosureSealPayload(untrustedPayload);
  if (decoded.kind === 'Rejected' || !isDeepStrictEqual(decoded.payload, expected.payload))
    return { kind: 'Rejected', reason: 'PayloadMismatch' };
  try {
    if (!new Saider({ qb64: input.d }).verify(input, true, true))
      return { kind: 'Rejected', reason: 'SaidMismatch' };
  } catch {
    return { kind: 'Rejected', reason: 'SaidMismatch' };
  }
  return {
    kind: 'Verified',
    exchangeSaid: input.d,
    sourceAid: expected.sourceAid,
    payload: decoded.payload,
  };
}

export interface StableEvaluationClosureSealExchange {
  readonly senderAlias: string;
  readonly sourceAid: PersonalAgentAid;
  readonly recipientAid: IssuerAid;
  readonly payload: EvaluationClosureSealPayload;
  readonly preparedAt: number;
}

export interface PreparedEvaluationClosureSealExchange {
  readonly exchangeSaid: string;
}

export interface LocalEvaluationClosureSealExchange {
  prepare(
    input: StableEvaluationClosureSealExchange,
  ): Promise<PreparedEvaluationClosureSealExchange>;
  deliver(
    input: StableEvaluationClosureSealExchange & PreparedEvaluationClosureSealExchange,
  ): Promise<PreparedEvaluationClosureSealExchange>;
}

export interface LocalEvaluationClosureSealConnection extends SignifyControllerConfiguration {
  readonly expectedControllerAid: ControllerAid;
  readonly expectedAgentAid: AgentAid;
}

export type ConnectEvaluationClosureSealController = (
  configuration: SignifyControllerConfiguration,
) => Promise<ConnectedSignifyController>;

export async function connectLocalEvaluationClosureSealExchange(
  input: LocalEvaluationClosureSealConnection,
  connectController: ConnectEvaluationClosureSealController = connectSignifyController,
): Promise<LocalEvaluationClosureSealExchange> {
  const connected = await connectController(input);
  if (
    connected.controllerAid !== input.expectedControllerAid ||
    connected.agentAid !== input.expectedAgentAid
  ) {
    throw new IdentityFailure({
      kind: 'controller-state-invalid',
      reason: 'Evaluation closure signing custody differs from the recovered controller binding',
    });
  }
  return signifyLocalEvaluationClosureSealExchange(connected.client);
}

export type IssuerEvaluationClosureSealInspection =
  | { readonly kind: 'Pending' }
  | EvaluationClosureSealExchangeMatch
  | { readonly kind: 'Unavailable'; readonly dependency: 'Keria' };

export interface IssuerEvaluationClosureSealExchange {
  inspect(
    expected: EvaluationClosureSealExchangeExpectation,
  ): Promise<IssuerEvaluationClosureSealInspection>;
}

function protocolDatetime(instant: number): string {
  if (!Number.isSafeInteger(instant) || instant < 0) {
    throw new IdentityFailure({
      kind: 'keria-response-invalid',
      stage: 'Evaluation closure exchange preparation',
      reason: 'preparation time is invalid',
    });
  }
  return new Date(instant).toISOString().replace('Z', '000+00:00');
}

function unavailable(stage: string, cause: unknown): IdentityFailure {
  return new IdentityFailure(
    { kind: 'keria-unavailable', stage, reason: reasonFromUnknown(cause) },
    cause,
  );
}

function invalidPrepared(reason: string): never {
  throw new IdentityFailure({
    kind: 'keria-response-invalid',
    stage: 'Evaluation closure exchange',
    reason,
  });
}

function exchangeNotFound(cause: unknown, said: string): boolean {
  return cause instanceof Error && cause.message.startsWith(`HTTP GET /exchanges/${said} - 404 `);
}

const exchangeResourceSchema = Type.Object({ exn: Type.Unknown() }, { additionalProperties: true });

async function retrieveExchange(client: SignifyClient, exchangeSaid: string): Promise<unknown> {
  let resource: unknown;
  try {
    resource = await client.exchanges().get(exchangeSaid);
  } catch (cause) {
    if (exchangeNotFound(cause, exchangeSaid)) return undefined;
    throw unavailable('Evaluation closure exchange retrieval', cause);
  }
  if (!Value.Check(exchangeResourceSchema, resource))
    return invalidPrepared('retrieved exchange resource is malformed');
  return resource.exn;
}

async function prepareExchange(client: SignifyClient, input: StableEvaluationClosureSealExchange) {
  let prepared;
  try {
    const sender = await client.identifiers().get(input.senderAlias);
    prepared = await client
      .exchanges()
      .createExchangeMessage(
        sender,
        evaluationClosureSealExchangeRoute,
        input.payload,
        {},
        input.recipientAid,
        protocolDatetime(input.preparedAt),
      );
  } catch (cause) {
    if (cause instanceof IdentityFailure) throw cause;
    throw unavailable('Evaluation closure exchange preparation', cause);
  }
  const matched = matchEvaluationClosureSealExchange(prepared[0].sad, {
    exchangeSaid: prepared[0].said,
    sourceAid: input.sourceAid,
    recipientAid: input.recipientAid,
    payload: input.payload,
  });
  if (matched.kind === 'Rejected')
    return invalidPrepared('prepared exchange differs from stable authority binding');
  return prepared;
}

function exactExchange(
  evidence: unknown,
  input: StableEvaluationClosureSealExchange & PreparedEvaluationClosureSealExchange,
): PreparedEvaluationClosureSealExchange {
  const matched = matchEvaluationClosureSealExchange(evidence, input);
  if (matched.kind === 'Rejected') return invalidPrepared('exchange differs from stable inputs');
  return { exchangeSaid: matched.exchangeSaid };
}

export function signifyLocalEvaluationClosureSealExchange(
  client: SignifyClient,
): LocalEvaluationClosureSealExchange {
  return {
    async prepare(input) {
      const prepared = await prepareExchange(client, input);
      return { exchangeSaid: prepared[0].said };
    },
    async deliver(input) {
      const existing = await retrieveExchange(client, input.exchangeSaid);
      if (existing !== undefined) return exactExchange(existing, input);
      const [exchange, signatures, attachment] = await prepareExchange(client, input);
      if (exchange.said !== input.exchangeSaid)
        return invalidPrepared('prepared exchange SAID changed before delivery');
      let delivered: unknown;
      try {
        delivered = await client
          .exchanges()
          .sendFromEvents(
            input.senderAlias,
            'evaluation-closure',
            exchange,
            signatures,
            attachment,
            [input.recipientAid],
          );
      } catch (cause) {
        const reconciled = await retrieveExchange(client, input.exchangeSaid);
        if (reconciled !== undefined) return exactExchange(reconciled, input);
        throw unavailable('Evaluation closure exchange delivery', cause);
      }
      try {
        return exactExchange(delivered, input);
      } catch (cause) {
        if (!(cause instanceof IdentityFailure) || cause.detail.kind !== 'keria-response-invalid')
          throw cause;
        const reconciled = await retrieveExchange(client, input.exchangeSaid);
        if (reconciled === undefined) throw cause;
        return exactExchange(reconciled, input);
      }
    },
  };
}

/** Pinned KERIA GET returns only a verified EXN; local SAID matching is not a signature check. */
export function signifyIssuerEvaluationClosureSealExchange(
  client: SignifyClient,
): IssuerEvaluationClosureSealExchange {
  return {
    async inspect(expected) {
      try {
        const resource = await client.exchanges().get(expected.exchangeSaid);
        if (!Value.Check(exchangeResourceSchema, resource))
          return { kind: 'Rejected', reason: 'Malformed' };
        return matchEvaluationClosureSealExchange(resource.exn, expected);
      } catch (cause) {
        return exchangeNotFound(cause, expected.exchangeSaid)
          ? { kind: 'Pending' }
          : { kind: 'Unavailable', dependency: 'Keria' };
      }
    },
  };
}
