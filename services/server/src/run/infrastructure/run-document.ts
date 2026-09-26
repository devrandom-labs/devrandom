import type { Run } from '@devrandom/domain';
import { decodeRunProjection, projectRun, runProjectionSchema } from '@devrandom/protocol';
import Type from 'typebox';
import Value from 'typebox/value';

const saidSchema = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const uuidV4Schema = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const commandFingerprintSchema = Type.String({ pattern: '^sha256:[a-f0-9]{64}$' });

export const runDocumentSchema = Type.Object(
  {
    _id: uuidV4Schema,
    commandFingerprint: commandFingerprintSchema,
    activeOwnerSlot: Type.Optional(saidSchema),
    activeGlobalSlot: Type.Optional(Type.Literal('Active')),
    ...runProjectionSchema.properties,
  },
  { additionalProperties: false },
);

export type RunDocument = Type.Static<typeof runDocumentSchema>;

export interface DecodedRunDocument {
  readonly run: Run;
  readonly commandFingerprint: string;
}

export class RunDocumentInvalid extends Error {
  constructor() {
    super('RunDocumentInvalid');
    this.name = 'RunDocumentInvalid';
  }
}

function activeSlotsMatch(
  lifecycle: RunDocument['lifecycle'],
  ownerAid: string,
  activeOwnerSlot: string | undefined,
  activeGlobalSlot: 'Active' | undefined,
): boolean {
  if (lifecycle.kind === 'Active') {
    return activeOwnerSlot === ownerAid && activeGlobalSlot === 'Active';
  }
  return activeOwnerSlot === undefined && activeGlobalSlot === undefined;
}

export function encodeRunDocument(run: Run, commandFingerprint: string): RunDocument {
  const projection = projectRun(run);
  const document: RunDocument =
    run.lifecycle.kind === 'Active'
      ? {
          _id: run.binding.runId,
          commandFingerprint,
          activeOwnerSlot: run.binding.ownerAid,
          activeGlobalSlot: 'Active',
          ...projection,
        }
      : { _id: run.binding.runId, commandFingerprint, ...projection };
  if (
    !Value.Check(runDocumentSchema, document) ||
    !activeSlotsMatch(
      document.lifecycle,
      document.ownerAid,
      document.activeOwnerSlot,
      document.activeGlobalSlot,
    )
  ) {
    throw new RunDocumentInvalid();
  }
  return document;
}

export function decodeRunDocument(input: unknown): DecodedRunDocument {
  if (!Value.Check(runDocumentSchema, input)) {
    throw new RunDocumentInvalid();
  }
  const { _id, commandFingerprint, activeOwnerSlot, activeGlobalSlot, ...projection } = input;
  if (
    _id !== projection.runId ||
    !activeSlotsMatch(projection.lifecycle, projection.ownerAid, activeOwnerSlot, activeGlobalSlot)
  ) {
    throw new RunDocumentInvalid();
  }
  const decoded = decodeRunProjection(projection);
  if (decoded.kind === 'Rejected') {
    throw new RunDocumentInvalid();
  }
  return { run: decoded.run, commandFingerprint };
}
