import Type from 'typebox';
import Value from 'typebox/value';

import { rfc8785Sha256 } from '../rfc-8785.js';
import { preparedRepositorySchema, taskBudgetsSchema } from '../task/task-command.js';
import { runPurposeSchema } from './run-purpose.js';

const uuidV4Schema = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const saidSchema = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });

export const runAdmissionExchangeRoute = '/devrandom/run/admission/1' as const;

export const runAdmissionPayloadSchema = Type.Object(
  {
    version: Type.Literal(1),
    kind: Type.Literal('RunAdmission'),
    commandId: uuidV4Schema,
    taskId: uuidV4Schema,
    taskRevisionSaid: saidSchema,
    harnessLineageId: uuidV4Schema,
    harnessRevisionSaid: saidSchema,
    taskMandateSaid: saidSchema,
    governorAid: saidSchema,
    promotionMandateSaid: saidSchema,
    purpose: runPurposeSchema,
    repository: preparedRepositorySchema,
    requestedBudget: taskBudgetsSchema,
  },
  { additionalProperties: false },
);

export type RunAdmissionPayload = Type.Static<typeof runAdmissionPayloadSchema>;

export type RunAdmissionPayloadDecoding =
  | { readonly kind: 'Accepted'; readonly payload: RunAdmissionPayload }
  | { readonly kind: 'Rejected'; readonly reason: 'SchemaInvalid' };

export function decodeRunAdmissionPayload(input: unknown): RunAdmissionPayloadDecoding {
  return Value.Check(runAdmissionPayloadSchema, input)
    ? { kind: 'Accepted', payload: input }
    : { kind: 'Rejected', reason: 'SchemaInvalid' };
}

export const runAdmissionCommandSchema = Type.Object(
  {
    version: Type.Literal(1),
    commandId: uuidV4Schema,
    admissionExchangeSaid: saidSchema,
  },
  { additionalProperties: false },
);

export type RunAdmissionCommand = Type.Static<typeof runAdmissionCommandSchema>;

export function runAdmissionCommandFingerprint(command: RunAdmissionCommand): string {
  if (!Value.Check(runAdmissionCommandSchema, command)) {
    throw new TypeError('Run admission fingerprint requires a valid command');
  }
  return rfc8785Sha256({
    version: command.version,
    admissionExchangeSaid: command.admissionExchangeSaid,
  });
}
