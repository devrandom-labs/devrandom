import Type from 'typebox';

import {
  workAccessGrantConcurrentUpdateProblemSchema,
  workAccessGrantExhaustedProblemSchema,
  workAccessGrantExpiredProblemSchema,
  workAccessGrantReleasedProblemSchema,
  workAccessGrantRevokedProblemSchema,
  workAccessGrantScopeRejectedProblemSchema,
} from '../work-access.js';
import { rfc8785Sha256 } from '../rfc-8785.js';
import { baselineHarnessRevisionSchema } from './harness-revision.js';

const uuidV4Schema = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const saidSchema = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const timestampSchema = Type.String({
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
});

export const harnessRevisionParametersSchema = Type.Object(
  { harnessSaid: saidSchema },
  { additionalProperties: false },
);

export type HarnessRevisionParameters = Type.Static<typeof harnessRevisionParametersSchema>;

export const admitBaselineHarnessBodySchema = Type.Object(
  {
    version: Type.Literal(1),
    commandId: uuidV4Schema,
    revision: baselineHarnessRevisionSchema,
  },
  { additionalProperties: false },
);

export type AdmitBaselineHarnessBody = Type.Static<typeof admitBaselineHarnessBodySchema>;

export const baselineHarnessProjectionSchema = Type.Object(
  {
    version: Type.Literal(1),
    ownerAid: saidSchema,
    commandId: uuidV4Schema,
    acceptedAt: timestampSchema,
    revision: baselineHarnessRevisionSchema,
  },
  { additionalProperties: false },
);

export type BaselineHarnessProjection = Type.Static<typeof baselineHarnessProjectionSchema>;

const correlationIdSchema = uuidV4Schema;

function problem<
  Code extends string,
  Status extends number,
  Title extends string,
  Path extends string,
>(code: Code, status: Status, title: Title, path: Path) {
  return {
    type: Type.Literal(`https://devrandom.example/problems/${path}`),
    title: Type.Literal(title),
    status: Type.Literal(status),
    code: Type.Literal(code),
    correlationId: correlationIdSchema,
  };
}

export const harnessRequestInvalidProblemSchema = Type.Object(
  problem('HarnessRequestInvalid', 400, 'Harness request is invalid', 'harness-request-invalid'),
  { additionalProperties: false },
);

export const harnessCapabilityInvalidProblemSchema = Type.Object(
  problem(
    'HarnessCapabilityInvalid',
    401,
    'Work Access capability is invalid',
    'harness-capability-invalid',
  ),
  { additionalProperties: false },
);

export const harnessAdmissionForbiddenProblemSchema = Type.Object(
  {
    ...problem(
      'HarnessAdmissionForbidden',
      403,
      'Harness admission is not permitted',
      'harness-admission-forbidden',
    ),
    reason: Type.Union([
      Type.Literal('UserCredentialNotCurrent'),
      Type.Literal('TaskMandateNotAdmitted'),
      Type.Literal('TaskMandatePending'),
      Type.Literal('TaskMandateNotYetValid'),
      Type.Literal('TaskMandateExpired'),
      Type.Literal('TaskMandateRevoked'),
      Type.Literal('TaskMandateBindingRejected'),
    ]),
  },
  { additionalProperties: false },
);

export const harnessTaskNotFoundProblemSchema = Type.Object(
  problem('HarnessTaskNotFound', 404, 'Harness Task was not found', 'harness-task-not-found'),
  { additionalProperties: false },
);

export const harnessAdmissionConflictProblemSchema = Type.Object(
  {
    ...problem(
      'HarnessAdmissionConflict',
      409,
      'Harness admission conflicts with durable state',
      'harness-admission-conflict',
    ),
    reason: Type.Union([Type.Literal('CommandConflict'), Type.Literal('LineageConflict')]),
  },
  { additionalProperties: false },
);

export const harnessBodyTooLargeProblemSchema = Type.Object(
  problem(
    'HarnessBodyTooLarge',
    413,
    'Harness request body is too large',
    'harness-body-too-large',
  ),
  { additionalProperties: false },
);

export const harnessRevisionRejectedProblemSchema = Type.Object(
  {
    ...problem(
      'HarnessRevisionRejected',
      422,
      'Harness Revision was rejected',
      'harness-revision-rejected',
    ),
    reason: Type.Union([
      Type.Literal('HarnessSaidMismatch'),
      Type.Literal('ManifestInvalid'),
      Type.Literal('TaskBindingMismatch'),
      Type.Literal('HarnessLineageMismatch'),
      Type.Literal('RepositoryBindingMismatch'),
      Type.Literal('PrincipalBindingMismatch'),
      Type.Literal('MandateBindingMismatch'),
      Type.Literal('CapabilityMismatch'),
      Type.Literal('BudgetCeilingMismatch'),
      Type.Literal('CompletionCommandMismatch'),
      Type.Literal('ToolCommandMismatch'),
      Type.Literal('SecretDetected'),
    ]),
  },
  { additionalProperties: false },
);

export const harnessUnavailableProblemSchema = Type.Object(
  {
    ...problem(
      'HarnessUnavailable',
      503,
      'Harness dependency is unavailable',
      'harness-unavailable',
    ),
    dependency: Type.Union([
      Type.Literal('HostedMongoDB'),
      Type.Literal('Keria'),
      Type.Literal('Witness'),
    ]),
  },
  { additionalProperties: false },
);

export const harnessProblemSchema = Type.Union([
  harnessRequestInvalidProblemSchema,
  harnessCapabilityInvalidProblemSchema,
  harnessAdmissionForbiddenProblemSchema,
  harnessTaskNotFoundProblemSchema,
  harnessAdmissionConflictProblemSchema,
  harnessBodyTooLargeProblemSchema,
  harnessRevisionRejectedProblemSchema,
  harnessUnavailableProblemSchema,
  workAccessGrantExpiredProblemSchema,
  workAccessGrantReleasedProblemSchema,
  workAccessGrantRevokedProblemSchema,
  workAccessGrantScopeRejectedProblemSchema,
  workAccessGrantConcurrentUpdateProblemSchema,
  workAccessGrantExhaustedProblemSchema,
]);

export type HarnessProblem = Type.Static<typeof harnessProblemSchema>;

export function harnessCommandFingerprint(command: AdmitBaselineHarnessBody): string {
  return rfc8785Sha256({ version: command.version, revision: command.revision });
}
