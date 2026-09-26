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

const asynchronousChallengeSchema = Type.Object(
  {
    words: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
      minItems: 24,
      maxItems: 24,
    }),
    dt: Type.Optional(Type.String()),
    said: Type.Optional(Type.String()),
    authenticated: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
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

const challengeOperationReferenceSchema = Type.Object(
  { name: Type.String({ minLength: 1 }) },
  { additionalProperties: true },
);

const challengeOperationMetadataSchema = Type.Object(
  { words: Type.Array(Type.String({ minLength: 1, maxLength: 64 })) },
  { additionalProperties: false },
);

const pendingChallengeOperationSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    metadata: Type.Optional(challengeOperationMetadataSchema),
    done: Type.Literal(false),
  },
  { additionalProperties: false },
);

const failedChallengeOperationSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    metadata: Type.Optional(challengeOperationMetadataSchema),
    error: Type.Object(
      {
        code: Type.Number(),
        message: Type.String(),
      },
      { additionalProperties: true },
    ),
    done: Type.Literal(true),
  },
  { additionalProperties: false },
);

const verifiedChallengeOperationSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    metadata: Type.Optional(challengeOperationMetadataSchema),
    response: Type.Object({ exn: challengeExchangeSchema }, { additionalProperties: false }),
    done: Type.Literal(true),
  },
  { additionalProperties: false },
);

const challengeOperationSchema = Type.Union([
  pendingChallengeOperationSchema,
  failedChallengeOperationSchema,
  verifiedChallengeOperationSchema,
]);

const acceptedChallengeResponseSchema = Type.Object(
  { ok: Type.Literal(true) },
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

interface SignifyAsynchronousChallengeClient {
  challenges(): {
    generate(strength?: number): Promise<unknown>;
    verify(source: string, words: string[]): Promise<unknown>;
    responded(source: string, said: string): Promise<unknown>;
  };
  operations(): {
    get(name: string): Promise<unknown>;
    delete(name: string): Promise<unknown>;
  };
}

export interface IssuerChallengeVerificationStart {
  readonly sourceAid: UserAid;
  readonly challengeWords: readonly string[];
}

export interface IssuerChallengeVerificationReference {
  readonly operationName: string;
}

export interface IssuerChallengeVerificationObservation {
  readonly operationName: string;
  readonly sourceAid: UserAid;
  readonly challengeWords: readonly string[];
  readonly responseSaid: ChallengeResponseSaid;
}

export interface IssuerChallengeResponseAcknowledgement {
  readonly sourceAid: UserAid;
  readonly responseSaid: ChallengeResponseSaid;
}

export type IssuerChallengeProofInvalidity =
  | 'MalformedOperation'
  | 'OperationNameMismatch'
  | 'ChallengeWordsMismatch'
  | 'ResponseEvidenceMismatch';

export type IssuerChallengeVerificationRejection =
  | {
      readonly kind: 'OperationFailed';
      readonly status: number;
      readonly reason: string;
    }
  | {
      readonly kind: 'InvalidProof';
      readonly reason: IssuerChallengeProofInvalidity;
    };

export type IssuerChallengeVerificationDisposition =
  | { readonly kind: 'Pending' }
  | { readonly kind: 'Verified'; readonly responseSaid: ChallengeResponseSaid }
  | {
      readonly kind: 'Rejected';
      readonly rejection: IssuerChallengeVerificationRejection;
    };

export interface AsynchronousIssuerChallengeProof {
  createChallenge(): Promise<readonly string[]>;
  startVerification(
    input: IssuerChallengeVerificationStart,
  ): Promise<IssuerChallengeVerificationReference>;
  observeVerification(
    input: IssuerChallengeVerificationObservation,
  ): Promise<IssuerChallengeVerificationDisposition>;
  acknowledgeResponse(input: IssuerChallengeResponseAcknowledgement): Promise<void>;
  cleanupVerification(operationName: string): Promise<void>;
}

function asynchronousChallengeInfrastructureFailure(
  stage: string,
  cause: unknown,
): IdentityFailure {
  return new IdentityFailure(
    {
      kind: 'keria-unavailable',
      stage,
      reason: reasonFromUnknown(cause),
    },
    cause,
  );
}

function malformedAsynchronousChallenge(stage: string, reason: string): IdentityFailure {
  return new IdentityFailure({ kind: 'keria-response-invalid', stage, reason });
}

function invalidObservedProof(
  reason: IssuerChallengeProofInvalidity,
): IssuerChallengeVerificationDisposition {
  return { kind: 'Rejected', rejection: { kind: 'InvalidProof', reason } };
}

export function signifyAsynchronousIssuerChallengeProof(
  client: SignifyAsynchronousChallengeClient,
  recipientAid: IssuerAid,
): AsynchronousIssuerChallengeProof {
  return {
    async createChallenge() {
      const stage = 'asynchronous challenge generation';
      let untrusted: unknown;
      try {
        untrusted = await client.challenges().generate(256);
      } catch (cause) {
        throw asynchronousChallengeInfrastructureFailure(stage, cause);
      }
      if (!Value.Check(asynchronousChallengeSchema, untrusted)) {
        throw malformedAsynchronousChallenge(stage, 'response does not contain exactly 24 words');
      }
      return [...untrusted.words];
    },

    async startVerification(input) {
      const stage = 'asynchronous challenge verification start';
      let untrusted: unknown;
      try {
        untrusted = await client.challenges().verify(input.sourceAid, [...input.challengeWords]);
      } catch (cause) {
        throw asynchronousChallengeInfrastructureFailure(stage, cause);
      }
      if (!Value.Check(challengeOperationReferenceSchema, untrusted)) {
        throw malformedAsynchronousChallenge(stage, 'response does not name a KERIA operation');
      }
      return { operationName: untrusted.name };
    },

    async observeVerification(input) {
      const stage = 'asynchronous challenge verification observation';
      let untrusted: unknown;
      try {
        untrusted = await client.operations().get(input.operationName);
      } catch (cause) {
        throw asynchronousChallengeInfrastructureFailure(stage, cause);
      }
      if (!Value.Check(challengeOperationSchema, untrusted)) {
        return invalidObservedProof('MalformedOperation');
      }
      if (untrusted.name !== input.operationName) {
        return invalidObservedProof('OperationNameMismatch');
      }
      if (
        untrusted.metadata !== undefined &&
        !sameWords(untrusted.metadata.words, input.challengeWords)
      ) {
        return invalidObservedProof('ChallengeWordsMismatch');
      }
      if (!untrusted.done) {
        return { kind: 'Pending' };
      }
      if ('error' in untrusted) {
        return {
          kind: 'Rejected',
          rejection: {
            kind: 'OperationFailed',
            status: untrusted.error.code,
            reason: untrusted.error.message,
          },
        };
      }
      try {
        const verified = verifyChallengeResponseEvidence(untrusted.response.exn, {
          sourceAid: input.sourceAid,
          recipientAid,
          challengeWords: input.challengeWords,
          responseSaid: input.responseSaid,
        });
        return { kind: 'Verified', responseSaid: verified.responseSaid };
      } catch (cause) {
        if (
          cause instanceof IdentityFailure &&
          cause.detail.kind === 'challenge-response-invalid'
        ) {
          return invalidObservedProof('ResponseEvidenceMismatch');
        }
        throw cause;
      }
    },

    async acknowledgeResponse(input) {
      const stage = 'asynchronous challenge response acknowledgement';
      let untrusted: unknown;
      try {
        untrusted = await client.challenges().responded(input.sourceAid, input.responseSaid);
      } catch (cause) {
        throw asynchronousChallengeInfrastructureFailure(stage, cause);
      }
      if (!Value.Check(acceptedChallengeResponseSchema, untrusted)) {
        throw malformedAsynchronousChallenge(stage, 'KERIA did not acknowledge the response');
      }
    },

    async cleanupVerification(operationName) {
      const stage = 'asynchronous challenge verification cleanup';
      try {
        await client.operations().delete(operationName);
      } catch (cause) {
        throw asynchronousChallengeInfrastructureFailure(stage, cause);
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
