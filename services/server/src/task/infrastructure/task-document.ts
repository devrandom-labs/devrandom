import {
  decodeTaskProjection,
  authorizedTaskCommandFingerprint,
  taskLifecycleSchema,
  authorizedTaskRevisionSchema,
  type TaskProjection,
  type AuthorizedTaskRevision,
} from '@devrandom/protocol';
import Type from 'typebox';
import Value from 'typebox/value';

const uuidV4Schema = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const keriIdentifierSchema = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const commandFingerprintSchema = Type.String({ pattern: '^sha256:[a-f0-9]{64}$' });
const taskLabelSchema = Type.String({
  minLength: 1,
  maxLength: 63,
  pattern: '^[a-z][a-z0-9-]{0,62}$',
});

const taskDocumentValueSchema = Type.Object(
  {
    _id: uuidV4Schema,
    ownerAid: keriIdentifierSchema,
    label: taskLabelSchema,
    harnessLineageId: uuidV4Schema,
    revision: authorizedTaskRevisionSchema,
    lifecycle: taskLifecycleSchema,
    commandId: uuidV4Schema,
    commandFingerprint: commandFingerprintSchema,
    createdAt: Type.Unknown(),
    expectedVersion: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    ownerSlot: Type.Integer({ minimum: 0, maximum: 4 }),
    globalSlot: Type.Integer({ minimum: 0, maximum: 15 }),
  },
  { additionalProperties: false },
);

export interface TaskDocument {
  readonly _id: string;
  readonly ownerAid: string;
  readonly label: string;
  readonly harnessLineageId: string;
  readonly revision: AuthorizedTaskRevision;
  readonly lifecycle: TaskProjection['lifecycle'];
  readonly commandId: string;
  readonly commandFingerprint: string;
  readonly createdAt: Date;
  readonly expectedVersion: number;
  readonly ownerSlot: number;
  readonly globalSlot: number;
}

export interface TaskCapacityAllocation {
  readonly ownerSlot: number;
  readonly globalSlot: number;
}

export interface DecodedTaskDocument {
  readonly task: TaskProjection;
  readonly commandFingerprint: string;
  readonly allocation: TaskCapacityAllocation;
}

export class TaskDocumentInvalid extends Error {
  constructor() {
    super('TaskDocumentInvalid');
    this.name = 'TaskDocumentInvalid';
  }
}

export function encodeTaskDocument(
  task: TaskProjection,
  commandFingerprint: string,
  allocation: TaskCapacityAllocation,
): TaskDocument {
  const decodedTask = decodeTaskProjection(task);
  if (decodedTask.kind === 'Rejected') {
    throw new TaskDocumentInvalid();
  }
  const projection = decodedTask.projection;
  const document: TaskDocument = {
    _id: projection.taskId,
    ownerAid: projection.ownerAid,
    label: projection.label,
    harnessLineageId: projection.harnessLineageId,
    revision: projection.revision,
    lifecycle: projection.lifecycle,
    commandId: projection.commandId,
    commandFingerprint,
    createdAt: new Date(projection.createdAt),
    expectedVersion: projection.expectedVersion,
    ownerSlot: allocation.ownerSlot,
    globalSlot: allocation.globalSlot,
  };
  if (
    !Value.Check(taskDocumentValueSchema, document) ||
    document.ownerSlot >= projection.revision.budgets.tasksPerAdmittedUser ||
    Number.isNaN(document.createdAt.valueOf()) ||
    document.createdAt.toISOString() !== projection.createdAt
  ) {
    throw new TaskDocumentInvalid();
  }
  const recomputedFingerprint = authorizedTaskCommandFingerprint({
    version: document.revision.version,
    commandId: document.commandId,
    label: document.label,
    revision: document.revision,
  });
  if (document.commandFingerprint !== recomputedFingerprint) {
    throw new TaskDocumentInvalid();
  }
  return document;
}

export function decodeTaskDocument(input: unknown): DecodedTaskDocument {
  if (!Value.Check(taskDocumentValueSchema, input) || !(input.createdAt instanceof Date)) {
    throw new TaskDocumentInvalid();
  }
  if (input.ownerSlot >= input.revision.budgets.tasksPerAdmittedUser) {
    throw new TaskDocumentInvalid();
  }
  const decodedTask = decodeTaskProjection({
    version: 1,
    taskId: input._id,
    ownerAid: input.ownerAid,
    label: input.label,
    harnessLineageId: input.harnessLineageId,
    revisionSaid: input.revision.d,
    revision: input.revision,
    lifecycle: input.lifecycle,
    commandId: input.commandId,
    createdAt: input.createdAt.toISOString(),
    expectedVersion: input.expectedVersion,
  });
  if (decodedTask.kind === 'Rejected') {
    throw new TaskDocumentInvalid();
  }
  const recomputedFingerprint = authorizedTaskCommandFingerprint({
    version: decodedTask.projection.revision.version,
    commandId: decodedTask.projection.commandId,
    label: decodedTask.projection.label,
    revision: decodedTask.projection.revision,
  });
  if (input.commandFingerprint !== recomputedFingerprint) {
    throw new TaskDocumentInvalid();
  }
  return {
    task: decodedTask.projection,
    commandFingerprint: input.commandFingerprint,
    allocation: { ownerSlot: input.ownerSlot, globalSlot: input.globalSlot },
  };
}
