import Type from 'typebox';
import Value from 'typebox/value';

import {
  mandatePresentationRejectionValues,
  reconstructMandatePresentation,
  type MandatePresentationRejection,
  type MandatePresentationState,
  type AcceptedMandateReference,
} from '../domain/presentation.js';
import type { StoredMandatePresentation } from '../application/presentations.js';

const keriIdentifierSchema = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const mandatePresentationRejectionSchema = Type.Union(
  mandatePresentationRejectionValues.map((reason) => Type.Literal(reason)),
);
const mandatePresentationStateSchema = Type.Union([
  Type.Object({ kind: Type.Literal('AwaitingGrant') }, { additionalProperties: false }),
  Type.Object(
    {
      kind: Type.Literal('Admitting'),
      operationName: Type.String({ minLength: 1, maxLength: 512 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('Admitted'),
      credentialSaid: keriIdentifierSchema,
      admittedAt: Type.Unknown(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('Rejected'), reason: mandatePresentationRejectionSchema },
    { additionalProperties: false },
  ),
  Type.Object({ kind: Type.Literal('Expired') }, { additionalProperties: false }),
]);

const mandatePresentationDocumentSchema = Type.Object(
  {
    _id: keriIdentifierSchema,
    revision: Type.Integer({ minimum: 0 }),
    ownerAid: keriIdentifierSchema,
    userCredentialSaid: keriIdentifierSchema,
    mandateKind: Type.Union([Type.Literal('TaskMandate'), Type.Literal('PromotionMandate')]),
    credentialSaid: keriIdentifierSchema,
    grantSaid: keriIdentifierSchema,
    requestedAt: Type.Unknown(),
    expiresAt: Type.Unknown(),
    cleanupAt: Type.Optional(Type.Unknown()),
    acceptedReference: Type.Union([
      Type.Null(),
      Type.Object(
        {
          issueeAid: keriIdentifierSchema,
          registryId: keriIdentifierSchema,
          taskId: Type.String({
            pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
          }),
          taskRevisionSaid: keriIdentifierSchema,
        },
        { additionalProperties: false },
      ),
    ]),
    state: mandatePresentationStateSchema,
  },
  { additionalProperties: false },
);

export interface MandatePresentationDocument {
  readonly _id: string;
  readonly revision: number;
  readonly ownerAid: string;
  readonly userCredentialSaid: string;
  readonly mandateKind: 'TaskMandate' | 'PromotionMandate';
  readonly credentialSaid: string;
  readonly grantSaid: string;
  readonly requestedAt: Date;
  readonly expiresAt: Date;
  readonly cleanupAt?: Date;
  readonly acceptedReference: AcceptedMandateReference | null;
  readonly state:
    | { readonly kind: 'AwaitingGrant' }
    | { readonly kind: 'Admitting'; readonly operationName: string }
    | { readonly kind: 'Admitted'; readonly credentialSaid: string; readonly admittedAt: Date }
    | { readonly kind: 'Rejected'; readonly reason: MandatePresentationRejection }
    | { readonly kind: 'Expired' };
}

export class MandatePresentationDocumentInvalid extends Error {
  constructor() {
    super('MandatePresentationDocumentInvalid');
    this.name = 'MandatePresentationDocumentInvalid';
  }
}

function encodeState(state: MandatePresentationState): MandatePresentationDocument['state'] {
  return state.kind === 'Admitted' ? { ...state, admittedAt: new Date(state.admittedAt) } : state;
}

export function encodeMandatePresentationDocument(
  stored: StoredMandatePresentation,
): MandatePresentationDocument {
  const binding = stored.presentation.binding;
  if (
    reconstructMandatePresentation(
      binding,
      stored.presentation.state,
      stored.presentation.acceptedReference,
    ) === undefined
  ) {
    throw new MandatePresentationDocumentInvalid();
  }
  const deadline = new Date(binding.expiresAt);
  const document: MandatePresentationDocument = {
    _id: binding.credentialSaid,
    revision: stored.revision,
    ownerAid: binding.ownerAid,
    userCredentialSaid: binding.userCredentialSaid,
    mandateKind: binding.mandateKind,
    credentialSaid: binding.credentialSaid,
    grantSaid: binding.grantSaid,
    requestedAt: new Date(binding.requestedAt),
    expiresAt: deadline,
    acceptedReference: stored.presentation.acceptedReference,
    ...(stored.presentation.state.kind === 'Admitted' ? {} : { cleanupAt: deadline }),
    state: encodeState(stored.presentation.state),
  };
  if (!Value.Check(mandatePresentationDocumentSchema, document)) {
    throw new MandatePresentationDocumentInvalid();
  }
  return document;
}

export function decodeMandatePresentationDocument(input: unknown): StoredMandatePresentation {
  if (
    !Value.Check(mandatePresentationDocumentSchema, input) ||
    !(input.requestedAt instanceof Date) ||
    !(input.expiresAt instanceof Date) ||
    (input.cleanupAt !== undefined && !(input.cleanupAt instanceof Date)) ||
    input._id !== input.credentialSaid
  ) {
    throw new MandatePresentationDocumentInvalid();
  }
  const admitted = input.state.kind === 'Admitted';
  if (
    (admitted && (input.cleanupAt !== undefined || input.acceptedReference === null)) ||
    (!admitted &&
      (input.acceptedReference !== null ||
        input.cleanupAt === undefined ||
        input.cleanupAt.valueOf() !== input.expiresAt.valueOf()))
  ) {
    throw new MandatePresentationDocumentInvalid();
  }
  let state: MandatePresentationState;
  if (input.state.kind === 'Admitted') {
    if (!(input.state.admittedAt instanceof Date)) {
      throw new MandatePresentationDocumentInvalid();
    }
    state = {
      kind: 'Admitted',
      credentialSaid: input.state.credentialSaid,
      admittedAt: input.state.admittedAt.toISOString(),
    };
  } else {
    state = input.state;
  }
  const presentation = reconstructMandatePresentation(
    {
      ownerAid: input.ownerAid,
      userCredentialSaid: input.userCredentialSaid,
      mandateKind: input.mandateKind,
      credentialSaid: input.credentialSaid,
      grantSaid: input.grantSaid,
      requestedAt: input.requestedAt.toISOString(),
      expiresAt: input.expiresAt.toISOString(),
    },
    state,
    input.acceptedReference,
  );
  if (presentation === undefined) {
    throw new MandatePresentationDocumentInvalid();
  }
  return { revision: input.revision, presentation };
}
