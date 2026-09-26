import type { InitialSpecializationActivation } from '@devrandom/domain';
import {
  baselineHarnessProjectionSchema,
  baselineHarnessRevisionSchema,
  decodeBaselineHarnessRevision,
  harnessCommandFingerprint,
  type BaselineHarnessProjection,
  type BaselineHarnessRevision,
} from '@devrandom/protocol';
import Type from 'typebox';
import Value from 'typebox/value';

const uuidV4Schema = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const saidSchema = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });

const harnessDocumentSchema = Type.Object(
  {
    _id: saidSchema,
    kind: Type.Literal('InitialSpecialization'),
    ownerAid: saidSchema,
    taskId: uuidV4Schema,
    taskRevisionSaid: saidSchema,
    harnessLineageId: uuidV4Schema,
    commandId: uuidV4Schema,
    commandFingerprint: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
    acceptedAt: Type.Unknown(),
    activation: Type.Union([
      Type.Object(
        {
          kind: Type.Literal('AwaitingRunAdmission'),
          harnessLineageId: uuidV4Schema,
          harnessRevisionSaid: saidSchema,
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          kind: Type.Literal('InitialSpecializationAccepted'),
          harnessLineageId: uuidV4Schema,
          harnessRevisionSaid: saidSchema,
          runId: uuidV4Schema,
          acceptedAt: Type.Unknown(),
        },
        { additionalProperties: false },
      ),
    ]),
    revision: baselineHarnessRevisionSchema,
  },
  { additionalProperties: false },
);

export interface HarnessDocument {
  readonly _id: string;
  readonly kind: 'InitialSpecialization';
  readonly ownerAid: string;
  readonly taskId: string;
  readonly taskRevisionSaid: string;
  readonly harnessLineageId: string;
  readonly commandId: string;
  readonly commandFingerprint: string;
  readonly acceptedAt: Date;
  readonly activation:
    | {
        readonly kind: 'AwaitingRunAdmission';
        readonly harnessLineageId: string;
        readonly harnessRevisionSaid: string;
      }
    | {
        readonly kind: 'InitialSpecializationAccepted';
        readonly harnessLineageId: string;
        readonly harnessRevisionSaid: string;
        readonly runId: string;
        readonly acceptedAt: Date;
      };
  readonly revision: BaselineHarnessRevision;
}

export interface DecodedHarnessDocument {
  readonly projection: BaselineHarnessProjection;
  readonly commandFingerprint: string;
  readonly activation: InitialSpecializationActivation;
}

export class HarnessDocumentInvalid extends Error {
  constructor() {
    super('HarnessDocumentInvalid');
    this.name = 'HarnessDocumentInvalid';
  }
}

function fingerprintMatches(
  projection: BaselineHarnessProjection,
  commandFingerprint: string,
): boolean {
  return (
    harnessCommandFingerprint({
      version: 1,
      commandId: projection.commandId,
      revision: projection.revision,
    }) === commandFingerprint
  );
}

export function encodeHarnessDocument(
  projection: BaselineHarnessProjection,
  commandFingerprint: string,
): HarnessDocument {
  if (
    !Value.Check(baselineHarnessProjectionSchema, projection) ||
    decodeBaselineHarnessRevision(projection.revision).kind !== 'Accepted' ||
    !fingerprintMatches(projection, commandFingerprint)
  ) {
    throw new HarnessDocumentInvalid();
  }
  const document: HarnessDocument = {
    _id: projection.revision.d,
    kind: 'InitialSpecialization',
    ownerAid: projection.ownerAid,
    taskId: projection.revision.task.taskId,
    taskRevisionSaid: projection.revision.task.revisionSaid,
    harnessLineageId: projection.revision.task.harnessLineageId,
    commandId: projection.commandId,
    commandFingerprint,
    acceptedAt: new Date(projection.acceptedAt),
    activation: {
      kind: 'AwaitingRunAdmission',
      harnessLineageId: projection.revision.task.harnessLineageId,
      harnessRevisionSaid: projection.revision.d,
    },
    revision: projection.revision,
  };
  if (
    !Value.Check(harnessDocumentSchema, document) ||
    Number.isNaN(document.acceptedAt.valueOf()) ||
    document.acceptedAt.toISOString() !== projection.acceptedAt
  ) {
    throw new HarnessDocumentInvalid();
  }
  return document;
}

export function decodeHarnessDocument(input: unknown): DecodedHarnessDocument {
  if (
    !Value.Check(harnessDocumentSchema, input) ||
    !(input.acceptedAt instanceof Date) ||
    input._id !== input.revision.d ||
    input.taskId !== input.revision.task.taskId ||
    input.taskRevisionSaid !== input.revision.task.revisionSaid ||
    input.harnessLineageId !== input.revision.task.harnessLineageId
  ) {
    throw new HarnessDocumentInvalid();
  }
  if (decodeBaselineHarnessRevision(input.revision).kind !== 'Accepted') {
    throw new HarnessDocumentInvalid();
  }
  if (
    input.activation.harnessLineageId !== input.harnessLineageId ||
    input.activation.harnessRevisionSaid !== input._id ||
    (input.activation.kind === 'InitialSpecializationAccepted' &&
      (!(input.activation.acceptedAt instanceof Date) ||
        Number.isNaN(input.activation.acceptedAt.valueOf())))
  ) {
    throw new HarnessDocumentInvalid();
  }
  const projection = {
    version: 1,
    ownerAid: input.ownerAid,
    commandId: input.commandId,
    acceptedAt: input.acceptedAt.toISOString(),
    revision: input.revision,
  };
  if (
    !Value.Check(baselineHarnessProjectionSchema, projection) ||
    !fingerprintMatches(projection, input.commandFingerprint)
  ) {
    throw new HarnessDocumentInvalid();
  }
  let activation: InitialSpecializationActivation;
  if (input.activation.kind === 'AwaitingRunAdmission') {
    activation = { ...input.activation };
  } else {
    const acceptedAt = input.activation.acceptedAt;
    if (!(acceptedAt instanceof Date)) {
      throw new HarnessDocumentInvalid();
    }
    activation = { ...input.activation, acceptedAt: acceptedAt.toISOString() };
  }
  return { projection, commandFingerprint: input.commandFingerprint, activation };
}
