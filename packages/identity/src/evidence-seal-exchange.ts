import { isDeepStrictEqual } from 'node:util';

import {
  decodeEvidenceSealPayload,
  evidenceSealExchangeRoute,
  evidenceSealPayloadSchema,
  type EvidenceSealPayload,
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

export const evidenceSealExchangeEvidenceSchema = Type.Object(
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
      { i: saidSchema, ...evidenceSealPayloadSchema.properties },
      { additionalProperties: false },
    ),
    e: Type.Object({}, { additionalProperties: true }),
  },
  { additionalProperties: false },
);

export type EvidenceSealExchangeEvidence = Type.Static<typeof evidenceSealExchangeEvidenceSchema>;

export function decodeEvidenceSealExchangeEvidence(
  input: unknown,
): EvidenceSealExchangeEvidence | undefined {
  return Value.Check(evidenceSealExchangeEvidenceSchema, input) ? input : undefined;
}

export type EvidenceSealExchangeRejection =
  | 'SealExchangeMalformed'
  | 'SealExchangeSaidMismatch'
  | 'SealExchangeRouteMismatch'
  | 'SealExchangeSourceMismatch'
  | 'SealExchangeRecipientMismatch'
  | 'SealExchangePayloadMismatch';

export interface EvidenceSealExchangeExpectation {
  readonly exchangeSaid: string;
  readonly sourceAid: PersonalAgentAid;
  readonly recipientAid: IssuerAid;
  readonly payload: EvidenceSealPayload;
}

export type EvidenceSealExchangeVerification =
  | {
      readonly kind: 'Verified';
      readonly exchangeSaid: string;
      readonly sourceAid: PersonalAgentAid;
      readonly payload: EvidenceSealPayload;
    }
  | { readonly kind: 'Rejected'; readonly reason: EvidenceSealExchangeRejection };

export function verifyEvidenceSealExchangeEvidence(
  input: unknown,
  expected: EvidenceSealExchangeExpectation,
): EvidenceSealExchangeVerification {
  const evidence = decodeEvidenceSealExchangeEvidence(input);
  if (evidence === undefined) {
    return { kind: 'Rejected', reason: 'SealExchangeMalformed' };
  }
  if (evidence.d !== expected.exchangeSaid) {
    return { kind: 'Rejected', reason: 'SealExchangeSaidMismatch' };
  }
  if (evidence.r !== evidenceSealExchangeRoute) {
    return { kind: 'Rejected', reason: 'SealExchangeRouteMismatch' };
  }
  if (evidence.i !== expected.sourceAid) {
    return { kind: 'Rejected', reason: 'SealExchangeSourceMismatch' };
  }
  const { i: recipientAid, ...untrustedPayload } = evidence.a;
  if (evidence.rp !== expected.recipientAid || recipientAid !== expected.recipientAid) {
    return { kind: 'Rejected', reason: 'SealExchangeRecipientMismatch' };
  }
  const decoded = decodeEvidenceSealPayload(untrustedPayload);
  if (decoded.kind === 'Rejected' || !isDeepStrictEqual(decoded.payload, expected.payload)) {
    return { kind: 'Rejected', reason: 'SealExchangePayloadMismatch' };
  }
  try {
    if (!new Saider({ qb64: evidence.d }).verify(evidence, true, true)) {
      return { kind: 'Rejected', reason: 'SealExchangeSaidMismatch' };
    }
  } catch {
    return { kind: 'Rejected', reason: 'SealExchangeSaidMismatch' };
  }
  return {
    kind: 'Verified',
    exchangeSaid: evidence.d,
    sourceAid: expected.sourceAid,
    payload: decoded.payload,
  };
}

export interface StableEvidenceSealExchange {
  readonly senderAlias: string;
  readonly sourceAid: PersonalAgentAid;
  readonly recipientAid: IssuerAid;
  readonly payload: EvidenceSealPayload;
  readonly preparedAt: number;
}

export interface PreparedEvidenceSealExchange {
  readonly exchangeSaid: string;
}

export interface LocalEvidenceSealExchange {
  prepare(input: StableEvidenceSealExchange): Promise<PreparedEvidenceSealExchange>;
  deliver(
    input: StableEvidenceSealExchange & PreparedEvidenceSealExchange,
  ): Promise<PreparedEvidenceSealExchange>;
}

export interface LocalEvidenceSealConnection extends SignifyControllerConfiguration {
  readonly expectedControllerAid: ControllerAid;
  readonly expectedAgentAid: AgentAid;
}

export type ConnectEvidenceSealController = (
  configuration: SignifyControllerConfiguration,
) => Promise<ConnectedSignifyController>;

export async function connectLocalEvidenceSealExchange(
  input: LocalEvidenceSealConnection,
  connectController: ConnectEvidenceSealController = connectSignifyController,
): Promise<LocalEvidenceSealExchange> {
  const connected = await connectController(input);
  if (
    connected.controllerAid !== input.expectedControllerAid ||
    connected.agentAid !== input.expectedAgentAid
  ) {
    throw new IdentityFailure({
      kind: 'controller-state-invalid',
      reason: 'Evidence-seal signing custody differs from the recovered controller binding',
    });
  }
  return signifyLocalEvidenceSealExchange(connected.client);
}

export type IssuerEvidenceSealInspection =
  | { readonly kind: 'Pending' }
  | Extract<EvidenceSealExchangeVerification, { readonly kind: 'Verified' }>
  | Extract<EvidenceSealExchangeVerification, { readonly kind: 'Rejected' }>
  | { readonly kind: 'Unavailable'; readonly dependency: 'Keria' };

export interface IssuerEvidenceSealExchange {
  inspect(expected: EvidenceSealExchangeExpectation): Promise<IssuerEvidenceSealInspection>;
}

function protocolDatetime(instant: number): string {
  if (!Number.isSafeInteger(instant) || instant < 0) {
    throw new IdentityFailure({
      kind: 'keria-response-invalid',
      stage: 'Evidence-seal exchange preparation',
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
    stage: 'Evidence-seal exchange',
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
    if (exchangeNotFound(cause, exchangeSaid)) {
      return undefined;
    }
    throw unavailable('Evidence-seal exchange retrieval', cause);
  }
  if (!Value.Check(exchangeResourceSchema, resource)) {
    return invalidPrepared('retrieved resource is malformed');
  }
  return resource.exn;
}

async function prepareExchange(client: SignifyClient, input: StableEvidenceSealExchange) {
  let prepared;
  try {
    const sender = await client.identifiers().get(input.senderAlias);
    prepared = await client
      .exchanges()
      .createExchangeMessage(
        sender,
        evidenceSealExchangeRoute,
        input.payload,
        {},
        input.recipientAid,
        protocolDatetime(input.preparedAt),
      );
  } catch (cause) {
    if (cause instanceof IdentityFailure) {
      throw cause;
    }
    throw unavailable('Evidence-seal exchange preparation', cause);
  }
  const verified = verifyEvidenceSealExchangeEvidence(prepared[0].sad, {
    exchangeSaid: prepared[0].said,
    sourceAid: input.sourceAid,
    recipientAid: input.recipientAid,
    payload: input.payload,
  });
  if (verified.kind === 'Rejected') {
    return invalidPrepared('prepared exchange does not match its local authority binding');
  }
  return prepared;
}

function verifyExactExchange(
  evidence: unknown,
  input: StableEvidenceSealExchange & PreparedEvidenceSealExchange,
): PreparedEvidenceSealExchange {
  const verified = verifyEvidenceSealExchangeEvidence(evidence, {
    exchangeSaid: input.exchangeSaid,
    sourceAid: input.sourceAid,
    recipientAid: input.recipientAid,
    payload: input.payload,
  });
  if (verified.kind === 'Rejected') {
    return invalidPrepared('exchange differs from its stable local inputs');
  }
  return { exchangeSaid: verified.exchangeSaid };
}

export function signifyLocalEvidenceSealExchange(client: SignifyClient): LocalEvidenceSealExchange {
  return {
    async prepare(input) {
      const prepared = await prepareExchange(client, input);
      return { exchangeSaid: prepared[0].said };
    },
    async deliver(input) {
      const existing = await retrieveExchange(client, input.exchangeSaid);
      if (existing !== undefined) {
        return verifyExactExchange(existing, input);
      }
      const [exchange, signatures, attachment] = await prepareExchange(client, input);
      if (exchange.said !== input.exchangeSaid) {
        return invalidPrepared('prepared exchange SAID changed before delivery');
      }
      let delivered: unknown;
      try {
        delivered = await client
          .exchanges()
          .sendFromEvents(input.senderAlias, 'evidence-seal', exchange, signatures, attachment, [
            input.recipientAid,
          ]);
      } catch (cause) {
        const reconciled = await retrieveExchange(client, input.exchangeSaid);
        if (reconciled !== undefined) {
          return verifyExactExchange(reconciled, input);
        }
        throw unavailable('Evidence-seal exchange delivery', cause);
      }
      try {
        return verifyExactExchange(delivered, input);
      } catch (cause) {
        if (!(cause instanceof IdentityFailure) || cause.detail.kind !== 'keria-response-invalid') {
          throw cause;
        }
        const reconciled = await retrieveExchange(client, input.exchangeSaid);
        if (reconciled === undefined) throw cause;
        return verifyExactExchange(reconciled, input);
      }
    },
  };
}

export function signifyIssuerEvidenceSealExchange(
  client: SignifyClient,
): IssuerEvidenceSealExchange {
  return {
    async inspect(expected) {
      let evidence: unknown;
      try {
        const resource = await client.exchanges().get(expected.exchangeSaid);
        if (!Value.Check(exchangeResourceSchema, resource)) {
          return { kind: 'Rejected', reason: 'SealExchangeMalformed' };
        }
        evidence = resource.exn;
      } catch (cause) {
        return exchangeNotFound(cause, expected.exchangeSaid)
          ? { kind: 'Pending' }
          : { kind: 'Unavailable', dependency: 'Keria' };
      }
      return verifyEvidenceSealExchangeEvidence(evidence, expected);
    },
  };
}
