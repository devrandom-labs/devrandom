import Type from 'typebox';
import Value from 'typebox/value';

import type { RunAdmissionReservationInput } from '../application/run-admissions.js';

const uuidV4Schema = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const saidSchema = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const timestampSchema = Type.String({
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
});
const fingerprintSchema = Type.String({ pattern: '^sha256:[a-f0-9]{64}$' });

export const runAdmissionDocumentSchema = Type.Object(
  {
    _id: Type.String({ minLength: 1, maxLength: 128 }),
    ownerAid: saidSchema,
    commandId: uuidV4Schema,
    commandFingerprint: fingerprintSchema,
    admissionExchangeSaid: saidSchema,
    reservedAt: timestampSchema,
    state: Type.Union([
      Type.Object({ kind: Type.Literal('AwaitingExchange') }, { additionalProperties: false }),
      Type.Object(
        { kind: Type.Literal('Accepted'), runId: uuidV4Schema, acceptedAt: timestampSchema },
        { additionalProperties: false },
      ),
    ]),
  },
  { additionalProperties: false },
);

export type RunAdmissionDocument = Type.Static<typeof runAdmissionDocumentSchema>;
export type StoredRunAdmission = Omit<RunAdmissionDocument, '_id'>;

export class RunAdmissionDocumentInvalid extends Error {
  constructor() {
    super('RunAdmissionDocumentInvalid');
    this.name = 'RunAdmissionDocumentInvalid';
  }
}

function documentId(ownerAid: string, commandId: string): string {
  return `${ownerAid}:${commandId}`;
}

export function encodeAwaitingRunAdmission(
  input: RunAdmissionReservationInput,
): RunAdmissionDocument {
  const document: RunAdmissionDocument = {
    _id: documentId(input.ownerAid, input.commandId),
    ...input,
    state: { kind: 'AwaitingExchange' },
  };
  if (!Value.Check(runAdmissionDocumentSchema, document)) {
    throw new RunAdmissionDocumentInvalid();
  }
  return document;
}

export function encodeCompletedRunAdmission(
  current: RunAdmissionDocument,
  input: { readonly runId: string; readonly acceptedAt: string },
): RunAdmissionDocument {
  if (
    !Value.Check(runAdmissionDocumentSchema, current) ||
    current.state.kind !== 'AwaitingExchange'
  ) {
    throw new RunAdmissionDocumentInvalid();
  }
  const document: RunAdmissionDocument = { ...current, state: { kind: 'Accepted', ...input } };
  if (!Value.Check(runAdmissionDocumentSchema, document)) {
    throw new RunAdmissionDocumentInvalid();
  }
  return document;
}

export function decodeRunAdmissionDocument(input: unknown): StoredRunAdmission {
  if (!Value.Check(runAdmissionDocumentSchema, input)) {
    throw new RunAdmissionDocumentInvalid();
  }
  const { _id, ...stored } = input;
  if (_id !== documentId(stored.ownerAid, stored.commandId)) {
    throw new RunAdmissionDocumentInvalid();
  }
  return stored;
}
