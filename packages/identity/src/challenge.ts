import { Saider, type SignifyClient } from 'signify-ts';
import Type from 'typebox';
import Value from 'typebox/value';

import { IdentityFailure, reasonFromUnknown } from './identity-error.js';
import {
  challengeResponseSaid,
  type ChallengeResponseSaid,
  type IssuerAid,
  type UserAid,
} from './keri-identifier.js';

const challengeSchema = Type.Object(
  {
    words: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
      minItems: 3,
      maxItems: 32,
    }),
  },
  { additionalProperties: true },
);

const challengeExchangeSchema = Type.Object(
  {
    v: Type.String({ minLength: 1 }),
    t: Type.Literal('exn'),
    d: Type.String({ minLength: 1 }),
    i: Type.String({ minLength: 1 }),
    rp: Type.String({ minLength: 1 }),
    p: Type.String(),
    dt: Type.String({ minLength: 1 }),
    r: Type.String({ minLength: 1 }),
    q: Type.Object({}, { additionalProperties: true }),
    a: Type.Object(
      {
        i: Type.String({ minLength: 1 }),
        words: Type.Array(Type.String({ minLength: 1, maxLength: 64 })),
      },
      { additionalProperties: false },
    ),
    e: Type.Object({}, { additionalProperties: true }),
  },
  { additionalProperties: false },
);

const completedChallengeSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    done: Type.Literal(true),
    response: Type.Object({ exn: challengeExchangeSchema }, { additionalProperties: false }),
  },
  { additionalProperties: true },
);

const challengeExchangeResourceSchema = Type.Object(
  { exn: challengeExchangeSchema },
  { additionalProperties: true },
);

export interface ChallengeResponseExpectation {
  readonly sourceAid: UserAid;
  readonly recipientAid: IssuerAid;
  readonly challengeWords: readonly string[];
  readonly responseSaid: string;
}

export interface VerifiedChallengeResponse {
  readonly responseSaid: ChallengeResponseSaid;
}

function invalidChallenge(reason: string, cause?: unknown): never {
  throw new IdentityFailure(
    { kind: 'challenge-response-invalid', reason },
    cause === undefined ? undefined : cause,
  );
}

function sameWords(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((word, index) => word === right[index]);
}

export function verifyChallengeResponseEvidence(
  evidence: unknown,
  expected: ChallengeResponseExpectation,
): VerifiedChallengeResponse {
  if (!Value.Check(challengeExchangeSchema, evidence)) {
    invalidChallenge('challenge response exchange is malformed');
  }
  if (evidence.r !== '/challenge/response') {
    invalidChallenge('challenge response route does not match the Signify challenge protocol');
  }
  if (evidence.i !== expected.sourceAid) {
    invalidChallenge('challenge response source AID does not match the registration');
  }
  if (evidence.rp !== expected.recipientAid) {
    invalidChallenge('challenge response recipient does not match the Devrandom issuer');
  }
  if (evidence.a.i !== expected.recipientAid) {
    invalidChallenge('challenge response payload recipient does not match the Devrandom issuer');
  }
  if (evidence.d !== expected.responseSaid) {
    invalidChallenge('challenge response SAID does not match the submitted exchange');
  }
  if (!sameWords(evidence.a.words, expected.challengeWords)) {
    invalidChallenge('challenge response words do not match the registration challenge');
  }
  try {
    if (!new Saider({ qb64: evidence.d }).verify(evidence, true, true)) {
      invalidChallenge('challenge response is not bound by its SAID');
    }
  } catch (cause) {
    if (cause instanceof IdentityFailure) {
      throw cause;
    }
    invalidChallenge('challenge response has an invalid SAID', cause);
  }
  return { responseSaid: challengeResponseSaid(evidence.d) };
}

export interface IssuerChallengeVerification {
  readonly sourceAid: UserAid;
  readonly challengeWords: readonly string[];
  readonly responseSaid: ChallengeResponseSaid;
  readonly operationTimeoutMs: number;
}

export interface IssuerChallengeProof {
  createChallenge(): Promise<readonly string[]>;
  verifyResponse(input: IssuerChallengeVerification): Promise<VerifiedChallengeResponse>;
}

export function signifyIssuerChallengeProof(
  client: SignifyClient,
  recipientAid: IssuerAid,
): IssuerChallengeProof {
  return {
    async createChallenge() {
      let untrusted: unknown;
      try {
        untrusted = await client.challenges().generate(128);
      } catch (cause) {
        throw new IdentityFailure(
          {
            kind: 'keria-unavailable',
            stage: 'challenge generation',
            reason: reasonFromUnknown(cause),
          },
          cause,
        );
      }
      if (!Value.Check(challengeSchema, untrusted)) {
        invalidChallenge('generated challenge is malformed');
      }
      return [...untrusted.words];
    },

    async verifyResponse(input) {
      try {
        const pending = await client
          .challenges()
          .verify(input.sourceAid, [...input.challengeWords]);
        const completed = await client.operations().wait(pending, {
          signal: AbortSignal.timeout(input.operationTimeoutMs),
          maxSleep: Math.min(1_000, input.operationTimeoutMs),
        });
        if (!Value.Check(completedChallengeSchema, completed)) {
          invalidChallenge('challenge verification did not return a completed response exchange');
        }
        const verified = verifyChallengeResponseEvidence(completed.response.exn, {
          sourceAid: input.sourceAid,
          recipientAid,
          challengeWords: input.challengeWords,
          responseSaid: input.responseSaid,
        });
        const accepted = await client
          .challenges()
          .responded(input.sourceAid, verified.responseSaid);
        if (!accepted.ok) {
          invalidChallenge('KERIA rejected the exact challenge response exchange');
        }
        await client.operations().delete(completed.name);
        return verified;
      } catch (cause) {
        if (cause instanceof IdentityFailure) {
          throw cause;
        }
        throw new IdentityFailure(
          {
            kind: 'keria-unavailable',
            stage: 'challenge response verification',
            reason: reasonFromUnknown(cause),
          },
          cause,
        );
      }
    },
  };
}

export interface UserChallengeProof {
  prepare(input: UserChallengePreparation): Promise<VerifiedChallengeResponse>;
  deliver(input: UserChallengeDelivery): Promise<VerifiedChallengeResponse>;
}

export interface UserChallengePreparation {
  readonly alias: string;
  readonly sourceAid: UserAid;
  readonly recipientAid: IssuerAid;
  readonly challengeWords: readonly string[];
  readonly preparedAt: number;
}

export interface UserChallengeDelivery extends UserChallengePreparation {
  readonly responseSaid: ChallengeResponseSaid;
}

export function signifyUserChallengeProof(client: SignifyClient): UserChallengeProof {
  return {
    async prepare(input) {
      const prepared = await prepareChallengeResponse(client, input);
      return verifyChallengeResponseEvidence(prepared[0].sad, {
        sourceAid: input.sourceAid,
        recipientAid: input.recipientAid,
        challengeWords: input.challengeWords,
        responseSaid: prepared[0].said,
      });
    },

    async deliver(input) {
      const existing = await retrieveChallengeResponse(client, input.responseSaid);
      if (existing !== undefined) {
        return verifyChallengeResponseEvidence(existing, input);
      }
      const prepared = await prepareChallengeResponse(client, input);
      const verified = verifyChallengeResponseEvidence(prepared[0].sad, input);
      let submitted: unknown;
      try {
        submitted = await client
          .exchanges()
          .sendFromEvents(input.alias, 'challenge', prepared[0], prepared[1], prepared[2], [
            input.recipientAid,
          ]);
      } catch (cause) {
        const reconciled = await retrieveChallengeResponse(client, input.responseSaid);
        if (reconciled !== undefined) {
          return verifyChallengeResponseEvidence(reconciled, input);
        }
        throw new IdentityFailure(
          {
            kind: 'keria-unavailable',
            stage: 'challenge response submission',
            reason: reasonFromUnknown(cause),
          },
          cause,
        );
      }
      const delivered = verifyChallengeResponseEvidence(submitted, input);
      if (delivered.responseSaid !== verified.responseSaid) {
        invalidChallenge('delivered challenge response differs from its prepared exchange');
      }
      return delivered;
    },
  };
}

async function prepareChallengeResponse(
  client: SignifyClient,
  input: UserChallengePreparation,
): Promise<Awaited<ReturnType<ReturnType<SignifyClient['exchanges']>['createExchangeMessage']>>> {
  if (!Number.isSafeInteger(input.preparedAt) || input.preparedAt < 0) {
    return invalidChallenge('challenge response preparation time is invalid');
  }
  try {
    const sender = await client.identifiers().get(input.alias);
    return await client
      .exchanges()
      .createExchangeMessage(
        sender,
        '/challenge/response',
        { words: [...input.challengeWords] },
        {},
        input.recipientAid,
        new Date(input.preparedAt).toISOString().replace('Z', '000+00:00'),
      );
  } catch (cause) {
    throw new IdentityFailure(
      {
        kind: 'keria-unavailable',
        stage: 'challenge response preparation',
        reason: reasonFromUnknown(cause),
      },
      cause,
    );
  }
}

async function retrieveChallengeResponse(
  client: SignifyClient,
  responseSaid: ChallengeResponseSaid,
): Promise<Type.Static<typeof challengeExchangeSchema> | undefined> {
  let resource: unknown;
  try {
    resource = await client.exchanges().get(responseSaid);
  } catch (cause) {
    if (challengeResponseNotFound(cause, responseSaid)) {
      return undefined;
    }
    throw new IdentityFailure(
      {
        kind: 'keria-unavailable',
        stage: 'challenge response reconciliation',
        reason: reasonFromUnknown(cause),
      },
      cause,
    );
  }
  if (!Value.Check(challengeExchangeResourceSchema, resource)) {
    return invalidChallenge('reconciled challenge response exchange is malformed');
  }
  return resource.exn;
}

function challengeResponseNotFound(cause: unknown, responseSaid: string): boolean {
  return (
    cause instanceof Error && cause.message.startsWith(`HTTP GET /exchanges/${responseSaid} - 404 `)
  );
}
