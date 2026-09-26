import Type from 'typebox';
import Value from 'typebox/value';
import type { WorkAccessScope } from '@devrandom/protocol';

import type { StoredWorkAccessAttempt } from '../application/work-access-attempts.js';
import {
  reconstructWorkAccessAttempt,
  workAccessExpiration,
  workAccessResponseSaid,
  type WorkAccessAttemptState,
} from '../domain/work-access.js';
import { workAccessPolicy, type WorkAccessPolicy } from '../domain/work-access-policy.js';

const uuidV4 = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const keriIdentifier = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const fingerprint = Type.String({ pattern: '^sha256:[a-f0-9]{64}$' });
const words = Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
  minItems: 24,
  maxItems: 24,
});
const scope = Type.Union([
  Type.Literal('evaluation:admit'),
  Type.Literal('evaluation:append'),
  Type.Literal('evaluation:close'),
  Type.Literal('evaluation:prepare'),
  Type.Literal('evidence:append'),
  Type.Literal('evidence:read'),
  Type.Literal('evidence:seal'),
  Type.Literal('experience:retrieve'),
  Type.Literal('run:create'),
  Type.Literal('run:execute'),
  Type.Literal('run:prepare'),
  Type.Literal('run:read'),
  Type.Literal('task:create'),
  Type.Literal('task:read'),
]);
const rejectionReason = Type.Union([
  Type.Literal('ChallengeRecipientMismatch'),
  Type.Literal('ChallengeProofInvalid'),
  Type.Literal('ChallengeOperationFailed'),
  Type.Literal('ChallengeAcknowledgementRejected'),
  Type.Literal('CredentialNotCurrent'),
]);

const disposition = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('Active'),
      remainingRequests: Type.Integer({ minimum: 0, maximum: 2_000 }),
    },
    { additionalProperties: false },
  ),
  Type.Object({ kind: Type.Literal('Expired') }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('Exhausted') }, { additionalProperties: false }),
  Type.Object(
    { kind: Type.Literal('Released'), releasedAt: Type.Unknown() },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('Revoked'), reason: Type.Literal('SecurityIncident') },
    { additionalProperties: false },
  ),
]);

const state = Type.Union([
  Type.Object(
    { kind: Type.Literal('AwaitingProof'), challengeWords: words },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('VerifyingProof'),
      challengeWords: words,
      responseSaid: keriIdentifier,
      operationName: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('Granted'),
      verifiedResponseSaid: keriIdentifier,
      scopes: Type.Array(scope, { minItems: 1, maxItems: 14, uniqueItems: true }),
      policyFingerprint: fingerprint,
      grantedAt: Type.Unknown(),
      expiresAt: Type.Unknown(),
      disposition,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('Rejected'),
      responseSaid: Type.Optional(keriIdentifier),
      reason: rejectionReason,
      rejectedAt: Type.Unknown(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('Expired'), expiredAt: Type.Unknown() },
    { additionalProperties: false },
  ),
]);

export const workAccessAttemptDocumentSchema = Type.Object(
  {
    _id: uuidV4,
    revision: Type.Integer({ minimum: 0 }),
    commandFingerprint: fingerprint,
    commandId: uuidV4,
    clientInstanceId: uuidV4,
    userAid: keriIdentifier,
    credentialSaid: keriIdentifier,
    issuerRecipientAid: keriIdentifier,
    grantSecretHash: fingerprint,
    createdAt: Type.Unknown(),
    attemptExpiresAt: Type.Unknown(),
    expiresAt: Type.Unknown(),
    state,
    proofResponseSaid: Type.Optional(keriIdentifier),
    attemptSlot: Type.Optional(Type.Integer({ minimum: 0, maximum: 1 })),
    globalAttemptSlot: Type.Optional(Type.Integer({ minimum: 0, maximum: 31 })),
    grantSlot: Type.Optional(Type.Integer({ minimum: 0, maximum: 1 })),
  },
  { additionalProperties: false },
);

type StorageWorkAccessAttemptState =
  | { readonly kind: 'AwaitingProof'; readonly challengeWords: readonly string[] }
  | {
      readonly kind: 'VerifyingProof';
      readonly challengeWords: readonly string[];
      readonly responseSaid: string;
      readonly operationName: string;
    }
  | {
      readonly kind: 'Granted';
      readonly verifiedResponseSaid: string;
      readonly scopes: readonly WorkAccessScope[];
      readonly policyFingerprint: string;
      readonly grantedAt: Date;
      readonly expiresAt: Date;
      readonly disposition:
        | { readonly kind: 'Active'; readonly remainingRequests: number }
        | { readonly kind: 'Expired' }
        | { readonly kind: 'Exhausted' }
        | { readonly kind: 'Released'; readonly releasedAt: Date }
        | { readonly kind: 'Revoked'; readonly reason: 'SecurityIncident' };
    }
  | {
      readonly kind: 'Rejected';
      readonly responseSaid?: string;
      readonly reason:
        | 'ChallengeRecipientMismatch'
        | 'ChallengeProofInvalid'
        | 'ChallengeOperationFailed'
        | 'ChallengeAcknowledgementRejected'
        | 'CredentialNotCurrent';
      readonly rejectedAt: Date;
    }
  | { readonly kind: 'Expired'; readonly expiredAt: Date };

export interface WorkAccessAttemptDocument {
  readonly _id: string;
  readonly revision: number;
  readonly commandFingerprint: string;
  readonly commandId: string;
  readonly clientInstanceId: string;
  readonly userAid: string;
  readonly credentialSaid: string;
  readonly issuerRecipientAid: string;
  readonly grantSecretHash: string;
  readonly createdAt: Date;
  readonly attemptExpiresAt: Date;
  readonly expiresAt: Date;
  readonly state: StorageWorkAccessAttemptState;
  readonly proofResponseSaid?: string;
  readonly attemptSlot?: 0 | 1;
  readonly globalAttemptSlot?: number;
  readonly grantSlot?: 0 | 1;
}

export type WorkAccessCapacityAllocation =
  | { readonly kind: 'AttemptCapacity'; readonly userSlot: 0 | 1; readonly globalSlot: number }
  | { readonly kind: 'GrantCapacity'; readonly userSlot: 0 | 1 }
  | { readonly kind: 'ReleasedCapacity' };

export interface DecodedWorkAccessAttemptDocument {
  readonly stored: StoredWorkAccessAttempt;
  readonly allocation: WorkAccessCapacityAllocation;
}

function instant(date: Date): string {
  if (Number.isNaN(date.valueOf())) {
    throw new Error('Mongo Work Access document contains an invalid date');
  }
  return date.toISOString();
}

function requiredDate(value: unknown, field: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new Error(`Mongo Work Access document ${field} is not a BSON date`);
  }
  return value;
}

function requiredUserSlot(value: number, field: string): 0 | 1 {
  if (value !== 0 && value !== 1) {
    throw new Error(`Mongo Work Access document ${field} is not a user slot`);
  }
  return value;
}

function domainState(value: StorageWorkAccessAttemptState): WorkAccessAttemptState {
  switch (value.kind) {
    case 'AwaitingProof':
      return { kind: 'AwaitingProof', challengeWords: value.challengeWords };
    case 'VerifyingProof':
      return {
        kind: 'VerifyingProof',
        challengeWords: value.challengeWords,
        responseSaid: value.responseSaid,
        operationName: value.operationName,
      };
    case 'Granted':
      return {
        kind: 'Granted',
        verifiedResponseSaid: value.verifiedResponseSaid,
        scopes: value.scopes,
        policyFingerprint: value.policyFingerprint,
        grantedAt: instant(value.grantedAt),
        expiresAt: instant(value.expiresAt),
        disposition:
          value.disposition.kind === 'Released'
            ? { kind: 'Released', releasedAt: instant(value.disposition.releasedAt) }
            : value.disposition,
      };
    case 'Rejected':
      return {
        kind: 'Rejected',
        ...(value.responseSaid === undefined ? {} : { responseSaid: value.responseSaid }),
        reason: value.reason,
        rejectedAt: instant(value.rejectedAt),
      };
    case 'Expired':
      return { kind: 'Expired', expiredAt: instant(value.expiredAt) };
  }
}

function allocation(document: WorkAccessAttemptDocument): WorkAccessCapacityAllocation {
  if (document.state.kind === 'AwaitingProof' || document.state.kind === 'VerifyingProof') {
    if (
      document.attemptSlot === undefined ||
      document.globalAttemptSlot === undefined ||
      document.grantSlot !== undefined
    ) {
      throw new Error('Mongo Work Access document has invalid attempt capacity metadata');
    }
    return {
      kind: 'AttemptCapacity',
      userSlot: document.attemptSlot,
      globalSlot: document.globalAttemptSlot,
    };
  }
  if (document.state.kind === 'Granted' && document.state.disposition.kind === 'Active') {
    if (
      document.grantSlot === undefined ||
      document.attemptSlot !== undefined ||
      document.globalAttemptSlot !== undefined
    ) {
      throw new Error('Mongo Work Access document has invalid grant capacity metadata');
    }
    return { kind: 'GrantCapacity', userSlot: document.grantSlot };
  }
  if (
    document.attemptSlot !== undefined ||
    document.globalAttemptSlot !== undefined ||
    document.grantSlot !== undefined
  ) {
    throw new Error('Mongo Work Access terminal document retains capacity metadata');
  }
  return { kind: 'ReleasedCapacity' };
}

export function decodeWorkAccessAttemptDocument(
  input: unknown,
  policy: WorkAccessPolicy = workAccessPolicy,
): DecodedWorkAccessAttemptDocument {
  if (!Value.Check(workAccessAttemptDocumentSchema, input)) {
    throw new Error('Mongo Work Access document is malformed');
  }
  const storageState: StorageWorkAccessAttemptState = (() => {
    switch (input.state.kind) {
      case 'AwaitingProof':
      case 'VerifyingProof':
        return input.state;
      case 'Granted':
        return {
          ...input.state,
          grantedAt: requiredDate(input.state.grantedAt, 'state.grantedAt'),
          expiresAt: requiredDate(input.state.expiresAt, 'state.expiresAt'),
          disposition:
            input.state.disposition.kind === 'Released'
              ? {
                  kind: 'Released',
                  releasedAt: requiredDate(
                    input.state.disposition.releasedAt,
                    'state.disposition.releasedAt',
                  ),
                }
              : input.state.disposition,
        };
      case 'Rejected':
        return {
          ...input.state,
          rejectedAt: requiredDate(input.state.rejectedAt, 'state.rejectedAt'),
        };
      case 'Expired':
        return {
          ...input.state,
          expiredAt: requiredDate(input.state.expiredAt, 'state.expiredAt'),
        };
    }
  })();
  const document: WorkAccessAttemptDocument = {
    _id: input._id,
    revision: input.revision,
    commandFingerprint: input.commandFingerprint,
    commandId: input.commandId,
    clientInstanceId: input.clientInstanceId,
    userAid: input.userAid,
    credentialSaid: input.credentialSaid,
    issuerRecipientAid: input.issuerRecipientAid,
    grantSecretHash: input.grantSecretHash,
    createdAt: requiredDate(input.createdAt, 'createdAt'),
    attemptExpiresAt: requiredDate(input.attemptExpiresAt, 'attemptExpiresAt'),
    expiresAt: requiredDate(input.expiresAt, 'expiresAt'),
    state: storageState,
    ...(input.proofResponseSaid === undefined
      ? {}
      : { proofResponseSaid: input.proofResponseSaid }),
    ...(input.attemptSlot === undefined
      ? {}
      : { attemptSlot: requiredUserSlot(input.attemptSlot, 'attemptSlot') }),
    ...(input.globalAttemptSlot === undefined
      ? {}
      : { globalAttemptSlot: input.globalAttemptSlot }),
    ...(input.grantSlot === undefined
      ? {}
      : { grantSlot: requiredUserSlot(input.grantSlot, 'grantSlot') }),
  };
  const attempt = reconstructWorkAccessAttempt(
    {
      attemptId: document._id,
      commandId: document.commandId,
      clientInstanceId: document.clientInstanceId,
      userAid: document.userAid,
      credentialSaid: document.credentialSaid,
      issuerRecipientAid: document.issuerRecipientAid,
      grantSecretHash: document.grantSecretHash,
      createdAt: instant(document.createdAt),
      attemptExpiresAt: instant(document.attemptExpiresAt),
    },
    domainState(document.state),
    policy,
  );
  if (
    document.expiresAt.toISOString() !== workAccessExpiration(attempt) ||
    document.proofResponseSaid !== workAccessResponseSaid(attempt)
  ) {
    throw new Error('Mongo Work Access indexed metadata does not match the aggregate');
  }
  return {
    stored: {
      revision: document.revision,
      commandFingerprint: document.commandFingerprint,
      attempt,
    },
    allocation: allocation(document),
  };
}

function storageState(stateValue: WorkAccessAttemptState): StorageWorkAccessAttemptState {
  switch (stateValue.kind) {
    case 'AwaitingProof':
    case 'VerifyingProof':
      return { ...stateValue, challengeWords: [...stateValue.challengeWords] };
    case 'Granted':
      return {
        ...stateValue,
        scopes: [...stateValue.scopes],
        grantedAt: new Date(stateValue.grantedAt),
        expiresAt: new Date(stateValue.expiresAt),
        disposition:
          stateValue.disposition.kind === 'Released'
            ? {
                kind: 'Released',
                releasedAt: new Date(stateValue.disposition.releasedAt),
              }
            : stateValue.disposition,
      };
    case 'Rejected':
      return { ...stateValue, rejectedAt: new Date(stateValue.rejectedAt) };
    case 'Expired':
      return { ...stateValue, expiredAt: new Date(stateValue.expiredAt) };
  }
}

export function encodeWorkAccessAttemptDocument(
  stored: StoredWorkAccessAttempt,
  allocationValue: WorkAccessCapacityAllocation,
): WorkAccessAttemptDocument {
  const { binding } = stored.attempt;
  const responseSaid = workAccessResponseSaid(stored.attempt);
  return {
    _id: binding.attemptId,
    revision: stored.revision,
    commandFingerprint: stored.commandFingerprint,
    commandId: binding.commandId,
    clientInstanceId: binding.clientInstanceId,
    userAid: binding.userAid,
    credentialSaid: binding.credentialSaid,
    issuerRecipientAid: binding.issuerRecipientAid,
    grantSecretHash: binding.grantSecretHash,
    createdAt: new Date(binding.createdAt),
    attemptExpiresAt: new Date(binding.attemptExpiresAt),
    expiresAt: new Date(workAccessExpiration(stored.attempt)),
    state: storageState(stored.attempt.state),
    ...(responseSaid === undefined ? {} : { proofResponseSaid: responseSaid }),
    ...(allocationValue.kind === 'AttemptCapacity'
      ? {
          attemptSlot: allocationValue.userSlot,
          globalAttemptSlot: allocationValue.globalSlot,
        }
      : allocationValue.kind === 'GrantCapacity'
        ? { grantSlot: allocationValue.userSlot }
        : {}),
  };
}
