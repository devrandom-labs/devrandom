import { isDeepStrictEqual } from 'node:util';

import {
  promotionRequiredChecks,
  promotionRequiredMetrics,
  promotionRiskLimit,
  type ExactPromotionMandateClaims,
  type MandateExperienceScope,
  type MandateRepository,
  type PromotionEvidenceClass,
  type TaskBudgets,
  type TaskEvolutionClass,
  type TaskEvaluationCapability,
} from '@devrandom/domain';
import {
  decodePromotionMandateCredential,
  decodePromotionMandateCredentialV2,
  decodePromotionMandateCredentialV3,
  decodeTaskMandateCredential,
  decodeTaskMandateCredentialV2,
  promotionMandateSchema,
  promotionMandateSchemaSaid,
  promotionMandateV2Schema,
  promotionMandateV2SchemaSaid,
  promotionMandateV3Schema,
  promotionMandateV3SchemaSaid,
  promotionMandateV4Schema,
  promotionMandateV4SchemaSaid,
  promotionMandateV5Schema,
  promotionMandateV5SchemaSaid,
  taskMandateSchema,
  taskMandateSchemaSaid,
  taskMandateV2Schema,
  taskMandateV2SchemaSaid,
  taskMandateV3Schema,
  taskMandateV3SchemaSaid,
} from '@devrandom/protocol';
import { Serder, type SignifyClient } from 'signify-ts';
import Type from 'typebox';
import Value from 'typebox/value';

import {
  provisionNamedCredentialRegistry,
  type CredentialRegistryOutcome,
  type CredentialRegistryPolicy,
} from './credential-registry.js';
import { signifyCredentialSchemaAvailability } from './credential-schema.js';
import { IdentityFailure, reasonFromUnknown } from './identity-error.js';
import {
  correlateIpexGrantNotification,
  mergeIpexGrantCorrelations,
  verifyIpexAdmitEvidence,
  verifyMandateIpexGrantEvidence,
} from './ipex.js';
import {
  credentialSaid,
  governorAid,
  ipexGrantSaid,
  personalAgentAid,
  type AgentAid,
  type ControllerAid,
  type CredentialRegistryId,
  type CredentialSaid,
  type GovernorAid,
  type IpexGrantSaid,
  type IssuerAid,
  type PersonalAgentAid,
  type UserAid,
} from './keri-identifier.js';
import {
  inspectMandateCredentialEvidence,
  type MandateCredentialEvidenceSources,
  type MandateInspection,
} from './mandate-credential.js';
import {
  connectSignifyController,
  type SignifyControllerConfiguration,
} from './signify-controller.js';

export const MANDATE_REGISTRY_NAME = 'devrandom-mandates';

export interface TaskMandateSchemaOobi {
  readonly kind: 'TaskMandateSchemaOobi';
  readonly url: string;
}

export interface PromotionMandateSchemaOobi {
  readonly kind: 'PromotionMandateSchemaOobi';
  readonly url: string;
}

function exactMandateSchemaOobi(value: string, expectedSaid: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (cause) {
    return invalidExchange('mandate schema OOBI is not a URL', cause);
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.pathname !== `/oobi/${expectedSaid}` ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    return invalidExchange('mandate schema OOBI does not identify the exact schema SAID');
  }
  return parsed.href;
}

export function taskMandateSchemaOobi(value: string): TaskMandateSchemaOobi {
  return {
    kind: 'TaskMandateSchemaOobi',
    url: exactMandateSchemaOobi(value, taskMandateSchemaSaid),
  };
}

export function promotionMandateSchemaOobi(value: string): PromotionMandateSchemaOobi {
  return {
    kind: 'PromotionMandateSchemaOobi',
    url: exactMandateSchemaOobi(value, promotionMandateSchemaSaid),
  };
}

export interface TaskMandateClaims {
  readonly authority: 'ExecutePrivateTask';
  readonly taskId: string;
  readonly taskRevisionSaid: string;
  readonly harnessLineageId: string;
  readonly repository: MandateRepository;
  readonly allowedCapabilities: readonly TaskEvaluationCapability[];
  readonly budgets: TaskBudgets;
  readonly allowedEvolutionClasses: readonly TaskEvolutionClass[];
  readonly notBefore: string;
  readonly expiresAt: string;
  readonly experience?: MandateExperienceScope;
}

interface PromotionMandateBaseClaims {
  readonly authority: 'ActivateEvaluatedSuccessor';
  readonly taskId: string;
  readonly taskRevisionSaid: string;
  readonly harnessLineageId: string;
  readonly capabilityCeiling: readonly TaskEvaluationCapability[];
  readonly budgetCeiling: TaskBudgets;
  readonly evolutionClassCeiling: readonly TaskEvolutionClass[];
  readonly requiredEvidenceClasses: readonly PromotionEvidenceClass[];
  readonly notBefore: string;
  readonly expiresAt: string;
  readonly experience?: MandateExperienceScope;
}

export type PromotionMandateClaims = PromotionMandateBaseClaims &
  (
    | {
        readonly evaluationManifestSaid?: never;
        readonly requiredMetrics?: never;
        readonly requiredChecks?: never;
        readonly riskLimit?: never;
      }
    | (ExactPromotionMandateClaims & { readonly experience: MandateExperienceScope })
  );

export interface StableTaskMandateIssuance {
  readonly kind: 'TaskMandate';
  readonly userAlias: string;
  readonly userAid: UserAid;
  readonly holderAid: PersonalAgentAid;
  readonly registryId: CredentialRegistryId;
  readonly issuedAt: number;
  readonly claims: TaskMandateClaims;
}

export interface StablePromotionMandateIssuance {
  readonly kind: 'PromotionMandate';
  readonly userAlias: string;
  readonly userAid: UserAid;
  readonly holderAid: GovernorAid;
  readonly registryId: CredentialRegistryId;
  readonly issuedAt: number;
  readonly claims: PromotionMandateClaims;
}

export type StableMandateIssuance = StableTaskMandateIssuance | StablePromotionMandateIssuance;

export type MandateIssuanceReconciliation =
  | { readonly kind: 'NotFound' }
  | { readonly kind: 'Materialized'; readonly credentialSaid: CredentialSaid }
  | {
      readonly kind: 'Submitted';
      readonly credentialSaid: CredentialSaid;
      readonly operationName: string;
    };

export interface SubmittedMandateCredential {
  readonly credentialSaid: CredentialSaid;
  readonly operationName: string;
}

export type MandateIssuanceObservation = StableMandateIssuance & {
  readonly credentialSaid: CredentialSaid;
  readonly operationName: string;
};

export type MandateIssuanceState =
  | { readonly kind: 'Pending' }
  | { readonly kind: 'Completed'; readonly inspection: MandateInspection }
  | { readonly kind: 'Failed'; readonly status: number; readonly reason: string };

export interface StableMandateGrant {
  readonly senderAlias: string;
  readonly exchangeSenderAid: string;
  readonly exchangeRecipientAid: string;
  readonly credentialIssuerAid: UserAid;
  readonly credentialIssueeAid: PersonalAgentAid | GovernorAid;
  readonly credentialSaid: CredentialSaid;
  readonly preparedAt: number;
}

export interface PreparedMandateGrant {
  readonly grantSaid: IpexGrantSaid;
}

export type MandateGrantReconciliation =
  | { readonly kind: 'NotFound' }
  | { readonly kind: 'Materialized'; readonly grantSaid: IpexGrantSaid }
  | {
      readonly kind: 'Submitted';
      readonly grantSaid: IpexGrantSaid;
      readonly operationName: string;
    };

export interface MandateGrantSubmission extends StableMandateGrant {
  readonly grantSaid: IpexGrantSaid;
}

export interface MandateGrantObservation extends MandateGrantSubmission {
  readonly operationName: string;
}

export type MandateGrantState =
  | { readonly kind: 'Pending' }
  | { readonly kind: 'Completed'; readonly grantSaid: IpexGrantSaid }
  | { readonly kind: 'Failed'; readonly status: number; readonly reason: string };

export interface MandateHolderAdmissionInput {
  readonly holderAlias: string;
  readonly holderAid: PersonalAgentAid | GovernorAid;
  readonly userAid: UserAid;
  readonly credentialSaid: CredentialSaid;
  readonly registryId: CredentialRegistryId;
  readonly grantSaid: IpexGrantSaid;
  readonly mandateKind: StableMandateIssuance['kind'];
  readonly preparedAt: number;
}

export type MandateHolderAdmissionStart =
  | { readonly kind: 'GrantPending' }
  | {
      readonly kind: 'Started';
      readonly admitSaid: string;
      readonly operationName: string;
    }
  | { readonly kind: 'AwaitingMaterialization'; readonly admitSaid: string }
  | {
      readonly kind: 'Verified';
      readonly admitSaid: string;
      readonly inspection: MandateInspection;
    };

export type MandateHolderAdmissionObservation =
  | (MandateHolderAdmissionInput & {
      readonly kind: 'Submitted';
      readonly admitSaid: string;
      readonly operationName: string;
    })
  | (MandateHolderAdmissionInput & {
      readonly kind: 'ExchangeMaterialized';
      readonly admitSaid: string;
    });

export type MandateHolderAdmissionState =
  | { readonly kind: 'Pending' }
  | { readonly kind: 'Verified'; readonly inspection: MandateInspection }
  | { readonly kind: 'Failed'; readonly status: number; readonly reason: string };

export interface LocalMandateCustody {
  readonly controllerAid: ControllerAid;
  readonly agentAid: AgentAid;
  prepareSchemas(): Promise<void>;
  provisionRegistry(input: {
    readonly userAlias: string;
    readonly userAid: UserAid;
    readonly policy: CredentialRegistryPolicy;
    readonly operationTimeoutMs: number;
  }): Promise<CredentialRegistryOutcome<UserAid>>;
  reconcileIssuance(input: StableMandateIssuance): Promise<MandateIssuanceReconciliation>;
  submitIssuance(input: StableMandateIssuance): Promise<SubmittedMandateCredential>;
  observeIssuance(input: MandateIssuanceObservation): Promise<MandateIssuanceState>;
  inspectCredential(input: { readonly credentialSaid: CredentialSaid }): Promise<MandateInspection>;
  prepareGrant(input: StableMandateGrant): Promise<PreparedMandateGrant>;
  reconcileGrant(input: MandateGrantSubmission): Promise<MandateGrantReconciliation>;
  submitGrant(input: MandateGrantSubmission): Promise<MandateGrantReconciliation>;
  observeGrant(input: MandateGrantObservation): Promise<MandateGrantState>;
  beginHolderAdmission(input: MandateHolderAdmissionInput): Promise<MandateHolderAdmissionStart>;
  observeHolderAdmission(
    input: MandateHolderAdmissionObservation,
  ): Promise<MandateHolderAdmissionState>;
}

export interface LocalMandateCustodyConnection extends SignifyControllerConfiguration {
  readonly expectedControllerAid: ControllerAid;
  readonly expectedAgentAid: AgentAid;
  readonly taskMandateSchemaOobi: TaskMandateSchemaOobi;
  readonly promotionMandateSchemaOobi: PromotionMandateSchemaOobi;
  readonly operationTimeoutMs: number;
}

export interface MandateGrantInspection {
  readonly grantSenderAid: string;
  readonly grantRecipientAid: string;
  readonly inspection: MandateInspection;
}

export interface MandateAdmissionInput {
  readonly ownerAid: string;
  readonly credentialSaid: string;
  readonly grantSaid: string;
}

export interface MandateAdmissionPreparation extends MandateAdmissionInput {
  readonly preparedAt: number;
}

export type MandateAdmissionRejection =
  | 'GrantEvidenceInvalid'
  | 'GrantSenderMismatch'
  | 'GrantRecipientMismatch'
  | 'CredentialSaidMismatch'
  | 'CredentialIssuerMismatch'
  | 'CredentialIssueeMismatch'
  | 'CredentialSchemaMismatch'
  | 'CredentialRegistryInvalid'
  | 'IncompatibleCredentialState'
  | 'AdmissionOperationFailed';

type MandateAdmissionFailure =
  | { readonly kind: 'Rejected'; readonly reason: MandateAdmissionRejection }
  | { readonly kind: 'Forbidden'; readonly reason: 'MandateRevoked' }
  | { readonly kind: 'Unavailable'; readonly dependency: 'Keria' | 'Witness' };

export type MandateAdmissionInspection =
  | { readonly kind: 'GrantPending' }
  | { readonly kind: 'Inspected'; readonly evidence: MandateGrantInspection }
  | MandateAdmissionFailure;

export type MandateAdmissionStart =
  | { readonly kind: 'GrantPending' }
  | { readonly kind: 'Started'; readonly operationName: string }
  | MandateAdmissionFailure;

export type MandateAdmissionObservation =
  | { readonly kind: 'GrantPending' }
  | { readonly kind: 'Pending' }
  | {
      readonly kind: 'Verified';
      readonly credentialSaid: string;
      readonly evidence: MandateGrantInspection;
    }
  | MandateAdmissionFailure;

export interface MandateAdmission {
  inspect(input: MandateAdmissionInput): Promise<MandateAdmissionInspection>;
  begin(input: MandateAdmissionPreparation): Promise<MandateAdmissionStart>;
  observe(
    input: MandateAdmissionInput & { readonly operationName: string },
  ): Promise<MandateAdmissionObservation>;
}

const nonEmptyString = Type.String({ minLength: 1 });
const unknownArraySchema = Type.Array(Type.Unknown());
const operationSchema = Type.Object(
  {
    name: nonEmptyString,
    done: Type.Boolean(),
    metadata: Type.Object({ said: nonEmptyString }, { additionalProperties: true }),
    error: Type.Optional(
      Type.Object({ code: Type.Number(), message: nonEmptyString }, { additionalProperties: true }),
    ),
  },
  { additionalProperties: true },
);
const operationReferenceSchema = Type.Object(
  {
    name: nonEmptyString,
    metadata: Type.Object({ said: nonEmptyString }, { additionalProperties: true }),
  },
  { additionalProperties: true },
);
const credentialOperationSchema = Type.Object(
  {
    name: nonEmptyString,
    metadata: Type.Object(
      {
        ced: Type.Object({ d: nonEmptyString }, { additionalProperties: true }),
      },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: true },
);
const issuanceOperationObservationSchema = Type.Object(
  {
    name: nonEmptyString,
    done: Type.Boolean(),
    metadata: Type.Object(
      {
        ced: Type.Object({ d: nonEmptyString }, { additionalProperties: true }),
      },
      { additionalProperties: true },
    ),
    error: Type.Optional(
      Type.Object({ code: Type.Number(), message: nonEmptyString }, { additionalProperties: true }),
    ),
  },
  { additionalProperties: true },
);
const credentialRecordSchema = Type.Object(
  {
    sad: Type.Object(
      {
        d: nonEmptyString,
        i: nonEmptyString,
        ri: nonEmptyString,
        s: nonEmptyString,
        a: Type.Object(
          { d: nonEmptyString, i: nonEmptyString, dt: nonEmptyString },
          { additionalProperties: true },
        ),
      },
      { additionalProperties: true },
    ),
    iss: Type.Object({ d: nonEmptyString }, { additionalProperties: true }),
    anc: Type.Object({ d: nonEmptyString }, { additionalProperties: true }),
    ancatc: Type.Array(Type.String()),
  },
  { additionalProperties: true },
);
const grantBindingsSchema = Type.Object(
  {
    exn: Type.Object(
      {
        d: nonEmptyString,
        i: nonEmptyString,
        rp: nonEmptyString,
        e: Type.Object(
          {
            acdc: Type.Object(
              {
                d: nonEmptyString,
                i: nonEmptyString,
                ri: nonEmptyString,
                s: nonEmptyString,
                a: Type.Object({ i: nonEmptyString }, { additionalProperties: true }),
              },
              { additionalProperties: true },
            ),
            iss: Type.Unknown(),
            anc: Type.Unknown(),
          },
          { additionalProperties: true },
        ),
      },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: true },
);
const notificationPageSchema = Type.Object(
  {
    start: Type.Integer({ minimum: 0 }),
    end: Type.Integer({ minimum: 0 }),
    total: Type.Integer({ minimum: 0 }),
    notes: Type.Array(Type.Unknown()),
  },
  { additionalProperties: true },
);

export function decodeMandateOperation(
  response: unknown,
  exchangeSaid: string,
): { readonly operationName: string } {
  if (!Value.Check(operationReferenceSchema, response) || response.metadata.said !== exchangeSaid) {
    return invalidExchange('mandate exchange operation response is inconsistent');
  }
  return { operationName: response.name };
}

export type MandateOperationReconciliation =
  { readonly kind: 'NotFound' } | { readonly kind: 'Submitted'; readonly operationName: string };

export function reconcileMandateOperationEvidence(
  evidence: unknown,
  exchangeSaid: string,
): MandateOperationReconciliation {
  if (!Value.Check(unknownArraySchema, evidence)) {
    return invalidExchange('mandate exchange operation list is malformed');
  }
  const matching = evidence.filter(
    (operation) =>
      Value.Check(operationReferenceSchema, operation) && operation.metadata.said === exchangeSaid,
  );
  if (matching.length > 1) {
    return invalidExchange('mandate exchange has more than one matching operation');
  }
  const operation = matching[0];
  return operation !== undefined && Value.Check(operationReferenceSchema, operation)
    ? { kind: 'Submitted', operationName: operation.name }
    : { kind: 'NotFound' };
}

export type HolderCredentialMaterialization =
  | { readonly kind: 'Pending' }
  | { readonly kind: 'Verified'; readonly inspection: MandateInspection };

export type MandateHolderAdmissionRecovery = Exclude<
  MandateHolderAdmissionStart,
  { readonly kind: 'GrantPending' }
>;

export function reconcileHolderAdmissionEvidence(
  operationEvidence: unknown,
  admitSaid: string,
  materialization: HolderCredentialMaterialization,
): MandateHolderAdmissionRecovery {
  const operation = reconcileMandateOperationEvidence(operationEvidence, admitSaid);
  if (operation.kind === 'Submitted') {
    return { kind: 'Started', admitSaid, operationName: operation.operationName };
  }
  return materialization.kind === 'Verified'
    ? { kind: 'Verified', admitSaid, inspection: materialization.inspection }
    : { kind: 'AwaitingMaterialization', admitSaid };
}

export type MandateOperationObservation =
  | { readonly kind: 'Pending' }
  | { readonly kind: 'Completed' }
  | { readonly kind: 'Failed'; readonly status: number; readonly reason: string };

export function observeMandateOperation(
  response: unknown,
  operationName: string,
  exchangeSaid: string,
): MandateOperationObservation {
  if (
    !Value.Check(operationSchema, response) ||
    response.name !== operationName ||
    response.metadata.said !== exchangeSaid
  ) {
    return invalidExchange('mandate exchange operation observation is inconsistent');
  }
  if (response.error !== undefined) {
    return { kind: 'Failed', status: response.error.code, reason: response.error.message };
  }
  return response.done ? { kind: 'Completed' } : { kind: 'Pending' };
}

export type HolderAdmitExchangeEvidence =
  { readonly kind: 'Pending' } | { readonly kind: 'Verified' };

export type HolderAdmissionOperationEvidence =
  MandateOperationObservation | { readonly kind: 'RecoveredWithoutOperation' };

export function convergeHolderAdmissionEvidence(
  operation: HolderAdmissionOperationEvidence,
  exchange: HolderAdmitExchangeEvidence,
  credential: HolderCredentialMaterialization,
): MandateHolderAdmissionState {
  if (operation.kind === 'Failed') {
    return operation;
  }
  if (
    operation.kind === 'Pending' ||
    exchange.kind === 'Pending' ||
    credential.kind === 'Pending'
  ) {
    return { kind: 'Pending' };
  }
  return { kind: 'Verified', inspection: credential.inspection };
}

export function observeMandateIssuanceOperation(
  response: unknown,
  operationName: string,
  credentialSaid: string,
): MandateOperationObservation {
  if (
    !Value.Check(issuanceOperationObservationSchema, response) ||
    response.name !== operationName ||
    response.metadata.ced.d !== credentialSaid
  ) {
    return invalidExchange('mandate issuance operation observation is inconsistent');
  }
  if (response.error !== undefined) {
    return { kind: 'Failed', status: response.error.code, reason: response.error.message };
  }
  return response.done ? { kind: 'Completed' } : { kind: 'Pending' };
}

export function mandateProtocolDatetime(instant: number): string {
  if (!Number.isSafeInteger(instant) || instant < 0) {
    return invalidExchange('protocol timestamp is invalid');
  }
  return new Date(instant).toISOString().replace('Z', '000+00:00');
}

function invalidExchange(reason: string, cause?: unknown): never {
  throw new IdentityFailure(
    { kind: 'credential-delivery-invalid', reason },
    cause === undefined ? undefined : cause,
  );
}

function unavailable(stage: string, cause: unknown): IdentityFailure {
  return new IdentityFailure(
    { kind: 'keria-unavailable', stage, reason: reasonFromUnknown(cause) },
    cause,
  );
}

function exactPromotionClaims(
  claims: PromotionMandateClaims,
): claims is PromotionMandateBaseClaims &
  ExactPromotionMandateClaims & { readonly experience: MandateExperienceScope } {
  const supplied = [
    claims.evaluationManifestSaid,
    claims.requiredMetrics,
    claims.requiredChecks,
    claims.riskLimit,
  ];
  if (supplied.every((value) => value === undefined)) return false;
  if (
    supplied.some((value) => value === undefined) ||
    claims.experience === undefined ||
    !/^[A-Z][A-Za-z0-9_-]{43}$/u.test(claims.evaluationManifestSaid ?? '') ||
    !isDeepStrictEqual(claims.requiredMetrics, promotionRequiredMetrics) ||
    !isDeepStrictEqual(claims.requiredChecks, promotionRequiredChecks) ||
    !isDeepStrictEqual(claims.riskLimit, promotionRiskLimit)
  )
    return invalidExchange('exact Promotion Mandate claims differ from the frozen E4 scope');
  return true;
}

function issuanceArguments(input: StableMandateIssuance) {
  switch (input.kind) {
    case 'TaskMandate':
      return {
        i: input.userAid,
        ri: input.registryId,
        s:
          input.claims.budgets.runsPerAdmittedUser > 6
            ? taskMandateV3SchemaSaid
            : input.claims.experience === undefined
              ? taskMandateSchemaSaid
              : taskMandateV2SchemaSaid,
        a: {
          i: input.holderAid,
          dt: mandateProtocolDatetime(input.issuedAt),
          authority: input.claims.authority,
          taskId: input.claims.taskId,
          taskRevisionSaid: input.claims.taskRevisionSaid,
          harnessLineageId: input.claims.harnessLineageId,
          repository: input.claims.repository,
          allowedCapabilities: [...input.claims.allowedCapabilities],
          budgets: input.claims.budgets,
          allowedEvolutionClasses: [...input.claims.allowedEvolutionClasses],
          ...(input.claims.experience === undefined ? {} : { experience: input.claims.experience }),
          notBefore: input.claims.notBefore,
          expiresAt: input.claims.expiresAt,
        },
      };
    case 'PromotionMandate': {
      const exact = exactPromotionClaims(input.claims);
      return {
        i: input.userAid,
        ri: input.registryId,
        s: exact
          ? input.claims.budgetCeiling.runsPerAdmittedUser > 6
            ? promotionMandateV5SchemaSaid
            : promotionMandateV3SchemaSaid
          : input.claims.budgetCeiling.runsPerAdmittedUser > 6
            ? promotionMandateV4SchemaSaid
            : input.claims.experience === undefined
              ? promotionMandateSchemaSaid
              : promotionMandateV2SchemaSaid,
        a: {
          i: input.holderAid,
          dt: mandateProtocolDatetime(input.issuedAt),
          authority: input.claims.authority,
          taskId: input.claims.taskId,
          taskRevisionSaid: input.claims.taskRevisionSaid,
          harnessLineageId: input.claims.harnessLineageId,
          capabilityCeiling: [...input.claims.capabilityCeiling],
          budgetCeiling: input.claims.budgetCeiling,
          evolutionClassCeiling: [...input.claims.evolutionClassCeiling],
          requiredEvidenceClasses: [...input.claims.requiredEvidenceClasses],
          ...(input.claims.experience === undefined ? {} : { experience: input.claims.experience }),
          ...(exact
            ? {
                evaluationManifestSaid: input.claims.evaluationManifestSaid,
                requiredMetrics: [...input.claims.requiredMetrics],
                requiredChecks: [...input.claims.requiredChecks],
                riskLimit: { ...input.claims.riskLimit },
              }
            : {}),
          notBefore: input.claims.notBefore,
          expiresAt: input.claims.expiresAt,
        },
      };
    }
  }
}

type StableIssuanceMatch =
  | { readonly kind: 'Matched' }
  | {
      readonly kind: 'Mismatch';
      readonly field:
        | 'EnvelopeSchema'
        | 'IssuerAid'
        | 'RegistryId'
        | 'SchemaSaid'
        | 'IssueeAid'
        | 'IssuedAt'
        | 'CredentialContent';
      readonly reason?: string;
    };

function stableIssuanceMatch(
  credential: unknown,
  input: StableMandateIssuance,
): StableIssuanceMatch {
  if (!Value.Check(credentialRecordSchema.properties.sad, credential)) {
    return { kind: 'Mismatch', field: 'EnvelopeSchema' };
  }
  const expected = issuanceArguments(input);
  if (credential.i !== expected.i) {
    return { kind: 'Mismatch', field: 'IssuerAid' };
  }
  if (credential.ri !== expected.ri) {
    return { kind: 'Mismatch', field: 'RegistryId' };
  }
  if (credential.s !== expected.s) {
    return { kind: 'Mismatch', field: 'SchemaSaid' };
  }
  if (credential.a.i !== expected.a.i) {
    return { kind: 'Mismatch', field: 'IssueeAid' };
  }
  if (credential.a.dt !== expected.a.dt) {
    return { kind: 'Mismatch', field: 'IssuedAt' };
  }
  switch (input.kind) {
    case 'TaskMandate': {
      const decoding =
        input.claims.experience === undefined
          ? decodeTaskMandateCredential(credential)
          : decodeTaskMandateCredentialV2(credential);
      if (decoding.kind === 'Rejected') {
        return { kind: 'Mismatch', field: 'CredentialContent', reason: decoding.reason };
      }
      return isDeepStrictEqual(
        {
          authority: decoding.credential.a.authority,
          taskId: decoding.credential.a.taskId,
          taskRevisionSaid: decoding.credential.a.taskRevisionSaid,
          harnessLineageId: decoding.credential.a.harnessLineageId,
          repository: decoding.credential.a.repository,
          allowedCapabilities: decoding.credential.a.allowedCapabilities,
          budgets: decoding.credential.a.budgets,
          allowedEvolutionClasses: decoding.credential.a.allowedEvolutionClasses,
          ...('experience' in decoding.credential.a
            ? { experience: decoding.credential.a.experience }
            : {}),
          notBefore: decoding.credential.a.notBefore,
          expiresAt: decoding.credential.a.expiresAt,
        },
        {
          authority: input.claims.authority,
          taskId: input.claims.taskId,
          taskRevisionSaid: input.claims.taskRevisionSaid,
          harnessLineageId: input.claims.harnessLineageId,
          repository: input.claims.repository,
          allowedCapabilities: input.claims.allowedCapabilities,
          budgets: input.claims.budgets,
          allowedEvolutionClasses: input.claims.allowedEvolutionClasses,
          ...(input.claims.experience === undefined ? {} : { experience: input.claims.experience }),
          notBefore: input.claims.notBefore,
          expiresAt: input.claims.expiresAt,
        },
      )
        ? { kind: 'Matched' }
        : { kind: 'Mismatch', field: 'CredentialContent' };
    }
    case 'PromotionMandate': {
      const exact = exactPromotionClaims(input.claims);
      const v3 = decodePromotionMandateCredentialV3(credential);
      const decoding = exact
        ? v3
        : input.claims.experience === undefined
          ? decodePromotionMandateCredential(credential)
          : decodePromotionMandateCredentialV2(credential);
      if (decoding.kind === 'Rejected') {
        return { kind: 'Mismatch', field: 'CredentialContent', reason: decoding.reason };
      }
      return isDeepStrictEqual(
        {
          authority: decoding.credential.a.authority,
          taskId: decoding.credential.a.taskId,
          taskRevisionSaid: decoding.credential.a.taskRevisionSaid,
          harnessLineageId: decoding.credential.a.harnessLineageId,
          capabilityCeiling: decoding.credential.a.capabilityCeiling,
          budgetCeiling: decoding.credential.a.budgetCeiling,
          evolutionClassCeiling: decoding.credential.a.evolutionClassCeiling,
          requiredEvidenceClasses: decoding.credential.a.requiredEvidenceClasses,
          ...('experience' in decoding.credential.a
            ? { experience: decoding.credential.a.experience }
            : {}),
          ...(v3.kind === 'Accepted'
            ? {
                evaluationManifestSaid: v3.credential.a.evaluationManifestSaid,
                requiredMetrics: v3.credential.a.requiredMetrics,
                requiredChecks: v3.credential.a.requiredChecks,
                riskLimit: v3.credential.a.riskLimit,
              }
            : {}),
          notBefore: decoding.credential.a.notBefore,
          expiresAt: decoding.credential.a.expiresAt,
        },
        {
          authority: input.claims.authority,
          taskId: input.claims.taskId,
          taskRevisionSaid: input.claims.taskRevisionSaid,
          harnessLineageId: input.claims.harnessLineageId,
          capabilityCeiling: input.claims.capabilityCeiling,
          budgetCeiling: input.claims.budgetCeiling,
          evolutionClassCeiling: input.claims.evolutionClassCeiling,
          requiredEvidenceClasses: input.claims.requiredEvidenceClasses,
          ...(input.claims.experience === undefined ? {} : { experience: input.claims.experience }),
          ...(exact
            ? {
                evaluationManifestSaid: input.claims.evaluationManifestSaid,
                requiredMetrics: input.claims.requiredMetrics,
                requiredChecks: input.claims.requiredChecks,
                riskLimit: input.claims.riskLimit,
              }
            : {}),
          notBefore: input.claims.notBefore,
          expiresAt: input.claims.expiresAt,
        },
      )
        ? { kind: 'Matched' }
        : { kind: 'Mismatch', field: 'CredentialContent' };
    }
  }
}

async function allCredentials(client: SignifyClient): Promise<readonly unknown[]> {
  const found: unknown[] = [];
  const pageSize = 1_000;
  for (let skip = 0; ; skip += pageSize) {
    const page: unknown = await client.credentials().list({ skip, limit: pageSize });
    if (!Value.Check(unknownArraySchema, page)) {
      return invalidExchange('mandate credential reconciliation page is malformed');
    }
    found.push(...page);
    if (page.length < pageSize) {
      return found;
    }
  }
}

async function reconcileIssuance(
  client: SignifyClient,
  input: StableMandateIssuance,
): Promise<MandateIssuanceReconciliation> {
  let credentials: readonly unknown[];
  let operations: unknown;
  try {
    [credentials, operations] = await Promise.all([
      allCredentials(client),
      client.operations().list('credential'),
    ]);
  } catch (cause) {
    throw unavailable('mandate credential reconciliation', cause);
  }
  return reconcileMandateIssuanceEvidence(credentials, operations, input);
}

export function reconcileMandateIssuanceEvidence(
  credentialEvidence: unknown,
  operationEvidence: unknown,
  input: StableMandateIssuance,
): MandateIssuanceReconciliation {
  if (
    !Value.Check(unknownArraySchema, credentialEvidence) ||
    !Value.Check(unknownArraySchema, operationEvidence)
  ) {
    return invalidExchange('mandate credential operation list is malformed');
  }
  const matches = credentialEvidence.flatMap((record) =>
    Value.Check(credentialRecordSchema, record) &&
    stableIssuanceMatch(record.sad, input).kind === 'Matched'
      ? [credentialSaid(record.sad.d)]
      : [],
  );
  const submitted = operationEvidence.flatMap((operation) => {
    if (!Value.Check(credentialOperationSchema, operation)) {
      return [];
    }
    const envelope = operation.metadata.ced;
    return stableIssuanceMatch(envelope, input).kind === 'Matched'
      ? [{ credentialSaid: credentialSaid(envelope.d), operationName: operation.name }]
      : [];
  });
  if (matches.length > 1 || submitted.length > 1) {
    return invalidExchange('stable mandate issuance identifies more than one credential');
  }
  const materialized = matches[0];
  const operation = submitted[0];
  if (
    materialized !== undefined &&
    operation !== undefined &&
    materialized !== operation.credentialSaid
  ) {
    return invalidExchange('mandate credential and operation identities disagree');
  }
  if (materialized !== undefined) {
    return { kind: 'Materialized', credentialSaid: materialized };
  }
  return operation === undefined ? { kind: 'NotFound' } : { kind: 'Submitted', ...operation };
}

async function submitIssuance(
  client: SignifyClient,
  input: StableMandateIssuance,
): Promise<SubmittedMandateCredential> {
  let result;
  try {
    result = await client.credentials().issue(input.userAlias, issuanceArguments(input));
  } catch (cause) {
    throw unavailable('mandate credential issuance submission', cause);
  }
  const said = credentialSaid(result.acdc.said);
  let serializedCredential: unknown;
  try {
    serializedCredential = JSON.parse(result.acdc.raw);
  } catch (cause) {
    return invalidExchange('issued mandate serialization is invalid', cause);
  }
  const match = stableIssuanceMatch(serializedCredential, input);
  if (match.kind === 'Mismatch') {
    return invalidExchange(
      `issued mandate does not match stable issuance inputs: ${match.field}${match.reason === undefined ? '' : `.${match.reason}`}`,
    );
  }
  if (!Value.Check(credentialOperationSchema, result.op) || result.op.metadata.ced.d !== said) {
    return invalidExchange('mandate credential operation response is inconsistent');
  }
  return { credentialSaid: said, operationName: result.op.name };
}

function issuanceInspectionMatches(
  inspection: MandateInspection,
  expected: StableMandateIssuance,
): boolean {
  const credential = inspection.value.credential;
  const exactPromotion =
    expected.kind === 'PromotionMandate' && exactPromotionClaims(expected.claims);
  const expectedSchema = issuanceArguments(expected).s;
  if (
    inspection.kind !== expected.kind ||
    credential.issuerAid !== expected.userAid ||
    credential.issueeAid !== expected.holderAid ||
    credential.registryId !== expected.registryId ||
    credential.schemaSaid !== expectedSchema ||
    credential.schemaDocument.schemaSaid !== expectedSchema ||
    credential.issuedAt !== mandateProtocolDatetime(expected.issuedAt) ||
    credential.telState.kind !== 'Issued' ||
    credential.issuerAnchor.kind !== 'Anchored'
  ) {
    return false;
  }
  if (inspection.kind === 'TaskMandate' && expected.kind === 'TaskMandate') {
    return (
      JSON.stringify({
        authority: inspection.value.authority,
        taskId: inspection.value.taskId,
        taskRevisionSaid: inspection.value.taskRevisionSaid,
        harnessLineageId: inspection.value.harnessLineageId,
        repository: inspection.value.repository,
        allowedCapabilities: inspection.value.allowedCapabilities,
        budgets: inspection.value.budgets,
        allowedEvolutionClasses: inspection.value.allowedEvolutionClasses,
        ...(inspection.value.experience === undefined
          ? {}
          : { experience: inspection.value.experience }),
        notBefore: inspection.value.notBefore,
        expiresAt: inspection.value.expiresAt,
      }) ===
      JSON.stringify({
        authority: expected.claims.authority,
        taskId: expected.claims.taskId,
        taskRevisionSaid: expected.claims.taskRevisionSaid,
        harnessLineageId: expected.claims.harnessLineageId,
        repository: expected.claims.repository,
        allowedCapabilities: expected.claims.allowedCapabilities,
        budgets: expected.claims.budgets,
        allowedEvolutionClasses: expected.claims.allowedEvolutionClasses,
        ...(expected.claims.experience === undefined
          ? {}
          : { experience: expected.claims.experience }),
        notBefore: expected.claims.notBefore,
        expiresAt: expected.claims.expiresAt,
      })
    );
  }
  if (inspection.kind === 'PromotionMandate' && expected.kind === 'PromotionMandate') {
    return (
      JSON.stringify({
        authority: inspection.value.authority,
        taskId: inspection.value.taskId,
        taskRevisionSaid: inspection.value.taskRevisionSaid,
        harnessLineageId: inspection.value.harnessLineageId,
        capabilityCeiling: inspection.value.capabilityCeiling,
        budgetCeiling: inspection.value.budgetCeiling,
        evolutionClassCeiling: inspection.value.evolutionClassCeiling,
        requiredEvidenceClasses: inspection.value.requiredEvidenceClasses,
        ...(inspection.value.experience === undefined
          ? {}
          : { experience: inspection.value.experience }),
        ...('evaluationManifestSaid' in inspection.value &&
        'requiredMetrics' in inspection.value &&
        'requiredChecks' in inspection.value &&
        'riskLimit' in inspection.value
          ? {
              evaluationManifestSaid: inspection.value.evaluationManifestSaid,
              requiredMetrics: inspection.value.requiredMetrics,
              requiredChecks: inspection.value.requiredChecks,
              riskLimit: inspection.value.riskLimit,
            }
          : {}),
        notBefore: inspection.value.notBefore,
        expiresAt: inspection.value.expiresAt,
      }) ===
      JSON.stringify({
        authority: expected.claims.authority,
        taskId: expected.claims.taskId,
        taskRevisionSaid: expected.claims.taskRevisionSaid,
        harnessLineageId: expected.claims.harnessLineageId,
        capabilityCeiling: expected.claims.capabilityCeiling,
        budgetCeiling: expected.claims.budgetCeiling,
        evolutionClassCeiling: expected.claims.evolutionClassCeiling,
        requiredEvidenceClasses: expected.claims.requiredEvidenceClasses,
        ...(expected.claims.experience === undefined
          ? {}
          : { experience: expected.claims.experience }),
        ...(exactPromotion
          ? {
              evaluationManifestSaid: expected.claims.evaluationManifestSaid,
              requiredMetrics: expected.claims.requiredMetrics,
              requiredChecks: expected.claims.requiredChecks,
              riskLimit: expected.claims.riskLimit,
            }
          : {}),
        notBefore: expected.claims.notBefore,
        expiresAt: expected.claims.expiresAt,
      })
    );
  }
  return false;
}

async function observeIssuance(
  client: SignifyClient,
  input: MandateIssuanceObservation,
): Promise<MandateIssuanceState> {
  let operation: unknown;
  try {
    operation = await client.operations().get(input.operationName);
  } catch (cause) {
    throw unavailable('mandate credential issuance observation', cause);
  }
  const operationState = observeMandateIssuanceOperation(
    operation,
    input.operationName,
    input.credentialSaid,
  );
  if (operationState.kind !== 'Completed') {
    return operationState;
  }
  let inspection: MandateInspection;
  try {
    inspection = await inspectCredential(client, input.credentialSaid);
  } catch (cause) {
    if (missingCredential(cause, input.credentialSaid)) {
      return { kind: 'Pending' };
    }
    throw cause;
  }
  if (!issuanceInspectionMatches(inspection, input)) {
    return invalidExchange('completed mandate issuance differs from its durable inputs');
  }
  return { kind: 'Completed', inspection };
}

async function credentialSources(
  client: SignifyClient,
  said: CredentialSaid,
): Promise<MandateCredentialEvidenceSources> {
  let credential: unknown;
  try {
    credential = await client.credentials().get(said);
  } catch (cause) {
    throw unavailable('mandate credential retrieval', cause);
  }
  if (!Value.Check(credentialRecordSchema, credential)) {
    return invalidExchange('mandate credential record is malformed');
  }
  let credentialState: unknown;
  let issuerKeyEvents: unknown;
  let resolvedSchema: unknown;
  try {
    [credentialState, issuerKeyEvents, resolvedSchema] = await Promise.all([
      client.credentials().state(credential.sad.ri, said),
      client.keyEvents().get(credential.sad.i),
      client.schemas().get(credential.sad.s),
    ]);
  } catch (cause) {
    throw unavailable('mandate credential verification evidence retrieval', cause);
  }
  return {
    expectedCredentialSaid: said,
    credential,
    credentialState,
    issuerKeyEvents,
    resolvedSchema,
  };
}

async function inspectCredential(
  client: SignifyClient,
  said: CredentialSaid,
): Promise<MandateInspection> {
  return inspectMandateCredentialEvidence(await credentialSources(client, said));
}

async function inspectEmbeddedCredential(
  client: SignifyClient,
  grant: Type.Static<typeof grantBindingsSchema>,
): Promise<MandateInspection> {
  const { acdc, iss, anc } = grant.exn.e;
  let credentialState: unknown;
  let issuerKeyEvents: unknown;
  let resolvedSchema: unknown;
  try {
    [credentialState, issuerKeyEvents, resolvedSchema] = await Promise.all([
      client.credentials().state(acdc.ri, acdc.d),
      client.keyEvents().get(acdc.i),
      client.schemas().get(acdc.s),
    ]);
  } catch (cause) {
    throw unavailable('embedded mandate credential verification evidence retrieval', cause);
  }
  return inspectMandateCredentialEvidence({
    expectedCredentialSaid: acdc.d,
    credential: { sad: acdc, iss, anc },
    credentialState,
    issuerKeyEvents,
    resolvedSchema,
  });
}

async function preparedGrant(client: SignifyClient, input: StableMandateGrant) {
  let credential: unknown;
  try {
    credential = await client.credentials().get(input.credentialSaid);
  } catch (cause) {
    throw unavailable('mandate grant credential retrieval', cause);
  }
  if (!Value.Check(credentialRecordSchema, credential)) {
    return invalidExchange('mandate grant credential record is malformed');
  }
  if (
    credential.sad.d !== input.credentialSaid ||
    credential.sad.i !== input.credentialIssuerAid ||
    credential.sad.a.i !== input.credentialIssueeAid ||
    (input.exchangeSenderAid !== input.credentialIssuerAid &&
      input.exchangeSenderAid !== input.credentialIssueeAid)
  ) {
    return invalidExchange('mandate grant roles do not bind the credential');
  }
  try {
    return await client.ipex().grant({
      senderName: input.senderAlias,
      recipient: input.exchangeRecipientAid,
      message: '',
      datetime: mandateProtocolDatetime(input.preparedAt),
      acdc: new Serder(credential.sad),
      iss: new Serder(credential.iss),
      anc: new Serder(credential.anc),
      ancAttachment: credential.ancatc.join(''),
    });
  } catch (cause) {
    throw unavailable('mandate IPEX grant preparation', cause);
  }
}

async function retrieveGrant(client: SignifyClient, said: IpexGrantSaid): Promise<unknown> {
  try {
    return await client.exchanges().get(said);
  } catch (cause) {
    throw unavailable('mandate IPEX grant retrieval', cause);
  }
}

async function verifyGrant(client: SignifyClient, input: MandateGrantSubmission): Promise<void> {
  verifyMandateIpexGrantEvidence(await retrieveGrant(client, input.grantSaid), {
    grantSaid: input.grantSaid,
    exchangeSenderAid: input.exchangeSenderAid,
    exchangeRecipientAid: input.exchangeRecipientAid,
    credentialIssuerAid: input.credentialIssuerAid,
    credentialIssueeAid: input.credentialIssueeAid,
    credentialSaid: input.credentialSaid,
  });
}

function operationNotFound(cause: unknown, path: string): boolean {
  return cause instanceof Error && cause.message.startsWith(`HTTP GET ${path} - 404 `);
}

async function reconcileGrant(
  client: SignifyClient,
  input: MandateGrantSubmission,
): Promise<MandateGrantReconciliation> {
  let operations: unknown;
  try {
    operations = await client.operations().list('exchange');
  } catch (cause) {
    throw unavailable('mandate IPEX grant operation reconciliation', cause);
  }
  if (!Value.Check(unknownArraySchema, operations)) {
    return invalidExchange('mandate exchange operation list is malformed');
  }
  const matching = operations.filter(
    (operation) =>
      Value.Check(operationReferenceSchema, operation) &&
      operation.metadata.said === input.grantSaid,
  );
  if (matching.length > 1) {
    return invalidExchange('mandate grant has more than one exchange operation');
  }
  const operation = matching[0];
  try {
    await verifyGrant(client, input);
    return { kind: 'Materialized', grantSaid: input.grantSaid };
  } catch (cause) {
    if (missingExchange(cause, input.grantSaid)) {
      return operation !== undefined && Value.Check(operationReferenceSchema, operation)
        ? { kind: 'Submitted', grantSaid: input.grantSaid, operationName: operation.name }
        : { kind: 'NotFound' };
    }
    throw cause;
  }
}

async function submitGrant(
  client: SignifyClient,
  input: MandateGrantSubmission,
): Promise<MandateGrantReconciliation> {
  const [grant, signatures, attachment] = await preparedGrant(client, input);
  if (grant.said !== input.grantSaid) {
    return invalidExchange('prepared mandate grant differs from the durable grant SAID');
  }
  let operation: unknown;
  try {
    operation = await client
      .ipex()
      .submitGrant(input.senderAlias, grant, signatures, attachment, [input.exchangeRecipientAid]);
  } catch (cause) {
    throw unavailable('mandate IPEX grant submission', cause);
  }
  return {
    kind: 'Submitted',
    grantSaid: input.grantSaid,
    operationName: decodeMandateOperation(operation, input.grantSaid).operationName,
  };
}

async function observeGrant(
  client: SignifyClient,
  input: MandateGrantObservation,
): Promise<MandateGrantState> {
  let operation: unknown;
  try {
    operation = await client.operations().get(input.operationName);
  } catch (cause) {
    throw unavailable('mandate IPEX grant operation observation', cause);
  }
  const operationState = observeMandateOperation(operation, input.operationName, input.grantSaid);
  if (operationState.kind !== 'Completed') {
    return operationState;
  }
  try {
    await verifyGrant(client, input);
  } catch (cause) {
    if (missingExchange(cause, input.grantSaid)) {
      return { kind: 'Pending' };
    }
    throw cause;
  }
  return { kind: 'Completed', grantSaid: input.grantSaid };
}

async function exactGrantNotification(client: SignifyClient, grantSaid: IpexGrantSaid) {
  let start = 0;
  let matched: ReturnType<typeof correlateIpexGrantNotification> = {
    kind: 'expected-grant-pending',
  };
  for (;;) {
    let page: unknown;
    try {
      page = await client.notifications().list(start, start + 24);
    } catch (cause) {
      throw unavailable('mandate IPEX notification retrieval', cause);
    }
    if (!Value.Check(notificationPageSchema, page)) {
      return invalidExchange('mandate IPEX notification page is malformed');
    }
    const correlation = correlateIpexGrantNotification({ notes: page.notes }, grantSaid);
    matched = mergeIpexGrantCorrelations(matched, correlation);
    if (page.total === 0 || page.end + 1 >= page.total) {
      return matched;
    }
    if (page.end < start) {
      return invalidExchange('mandate IPEX notification range did not advance');
    }
    start = page.end + 1;
  }
}

async function holderCredentialMaterialization(
  client: SignifyClient,
  input: MandateHolderAdmissionInput,
): Promise<HolderCredentialMaterialization> {
  let inspection: MandateInspection;
  try {
    inspection = await inspectCredential(client, input.credentialSaid);
  } catch (cause) {
    if (missingCredential(cause, input.credentialSaid)) {
      return { kind: 'Pending' };
    }
    throw cause;
  }
  verifyHolderInspection(inspection, input);
  return { kind: 'Verified', inspection };
}

async function holderAdmitExchangeEvidence(
  client: SignifyClient,
  input: MandateHolderAdmissionInput & { readonly admitSaid: string },
): Promise<HolderAdmitExchangeEvidence> {
  let existing: unknown;
  try {
    existing = await client.exchanges().get(input.admitSaid);
  } catch (cause) {
    if (missingExchange(cause, input.admitSaid)) {
      return { kind: 'Pending' };
    }
    throw unavailable('holder mandate admit exchange retrieval', cause);
  }
  if (typeof existing !== 'object' || existing === null || !('exn' in existing)) {
    return invalidExchange('holder mandate admit exchange is malformed');
  }
  verifyIpexAdmitEvidence(existing.exn, {
    admitSaid: input.admitSaid,
    grantSaid: input.grantSaid,
    sourceAid: input.holderAid,
    recipientAid: input.userAid,
  });
  return { kind: 'Verified' };
}

async function acknowledgeGrantNotification(
  client: SignifyClient,
  notification: Exclude<
    Awaited<ReturnType<typeof exactGrantNotification>>,
    { readonly kind: 'expected-grant-pending' }
  >,
): Promise<void> {
  if (notification.kind !== 'expected-grant-available') {
    return;
  }
  for (const notificationId of notification.notificationIds) {
    try {
      await client.notifications().mark(notificationId);
    } catch (cause) {
      throw unavailable('holder mandate grant notification acknowledgement', cause);
    }
  }
}

async function beginHolderAdmission(
  client: SignifyClient,
  input: MandateHolderAdmissionInput,
): Promise<MandateHolderAdmissionStart> {
  const notification = await exactGrantNotification(client, input.grantSaid);
  if (notification.kind === 'expected-grant-pending') {
    return { kind: 'GrantPending' };
  }
  verifyMandateIpexGrantEvidence(await retrieveGrant(client, input.grantSaid), {
    grantSaid: input.grantSaid,
    exchangeSenderAid: input.userAid,
    exchangeRecipientAid: input.holderAid,
    credentialIssuerAid: input.userAid,
    credentialIssueeAid: input.holderAid,
    credentialSaid: input.credentialSaid,
  });
  let prepared;
  try {
    prepared = await client.ipex().admit({
      senderName: input.holderAlias,
      recipient: input.userAid,
      message: '',
      grantSaid: input.grantSaid,
      datetime: mandateProtocolDatetime(input.preparedAt),
    });
  } catch (cause) {
    throw unavailable('holder mandate IPEX admit preparation', cause);
  }
  const [admit, signatures, attachment] = prepared;
  verifyIpexAdmitEvidence(admit.sad, {
    admitSaid: admit.said,
    grantSaid: input.grantSaid,
    sourceAid: input.holderAid,
    recipientAid: input.userAid,
  });
  const exchangeEvidence = await holderAdmitExchangeEvidence(client, {
    ...input,
    admitSaid: admit.said,
  });
  if (exchangeEvidence.kind === 'Verified') {
    let operations: unknown;
    try {
      operations = await client.operations().list('exchange');
    } catch (cause) {
      throw unavailable('holder mandate admit operation reconciliation', cause);
    }
    const recovery = reconcileHolderAdmissionEvidence(
      operations,
      admit.said,
      await holderCredentialMaterialization(client, input),
    );
    await acknowledgeGrantNotification(client, notification);
    return recovery;
  }
  let operation: unknown;
  try {
    operation = await client
      .ipex()
      .submitAdmit(input.holderAlias, admit, signatures, attachment, [input.userAid]);
  } catch (cause) {
    throw unavailable('holder mandate IPEX admit submission', cause);
  }
  await acknowledgeGrantNotification(client, notification);
  return {
    kind: 'Started',
    admitSaid: admit.said,
    operationName: decodeMandateOperation(operation, admit.said).operationName,
  };
}

async function observeHolderAdmission(
  client: SignifyClient,
  input: MandateHolderAdmissionObservation,
): Promise<MandateHolderAdmissionState> {
  let operation: HolderAdmissionOperationEvidence;
  switch (input.kind) {
    case 'ExchangeMaterialized':
      operation = { kind: 'RecoveredWithoutOperation' };
      break;
    case 'Submitted': {
      let untrustedOperation: unknown;
      try {
        untrustedOperation = await client.operations().get(input.operationName);
      } catch (cause) {
        throw unavailable('holder mandate admission observation', cause);
      }
      operation = observeMandateOperation(untrustedOperation, input.operationName, input.admitSaid);
      if (operation.kind === 'Failed' || operation.kind === 'Pending') {
        return operation;
      }
      break;
    }
  }
  const exchange = await holderAdmitExchangeEvidence(client, input);
  if (exchange.kind === 'Pending') {
    return { kind: 'Pending' };
  }
  return convergeHolderAdmissionEvidence(
    operation,
    exchange,
    await holderCredentialMaterialization(client, input),
  );
}

function verifyHolderInspection(
  inspection: MandateInspection,
  expected: MandateHolderAdmissionInput,
): void {
  const evidence = inspection.value.credential;
  const expectedSchemas =
    expected.mandateKind === 'TaskMandate'
      ? [taskMandateSchemaSaid, taskMandateV2SchemaSaid, taskMandateV3SchemaSaid]
      : [
          promotionMandateSchemaSaid,
          promotionMandateV2SchemaSaid,
          promotionMandateV3SchemaSaid,
          promotionMandateV4SchemaSaid,
          promotionMandateV5SchemaSaid,
        ];
  if (
    inspection.kind !== expected.mandateKind ||
    evidence.credentialSaid !== expected.credentialSaid ||
    evidence.issuerAid !== expected.userAid ||
    evidence.issueeAid !== expected.holderAid ||
    evidence.registryId !== expected.registryId ||
    !expectedSchemas.includes(evidence.schemaSaid) ||
    evidence.schemaDocument.schemaSaid !== evidence.schemaSaid ||
    evidence.telState.kind !== 'Issued' ||
    evidence.issuerAnchor.kind !== 'Anchored'
  ) {
    return invalidExchange('materialized mandate does not match exact holder admission state');
  }
}

export async function connectLocalMandateCustody(
  input: LocalMandateCustodyConnection,
): Promise<LocalMandateCustody> {
  const controller = await connectSignifyController(input);
  if (
    controller.controllerAid !== input.expectedControllerAid ||
    controller.agentAid !== input.expectedAgentAid
  ) {
    return invalidExchange('local mandate controller or KERIA agent differs from the profile');
  }
  const { client } = controller;
  const taskSchemaAvailability = signifyCredentialSchemaAvailability(
    client,
    taskMandateSchema,
    input.operationTimeoutMs,
  );
  const taskV2SchemaAvailability = signifyCredentialSchemaAvailability(
    client,
    taskMandateV2Schema,
    input.operationTimeoutMs,
  );
  const promotionSchemaAvailability = signifyCredentialSchemaAvailability(
    client,
    promotionMandateSchema,
    input.operationTimeoutMs,
  );
  const promotionV2SchemaAvailability = signifyCredentialSchemaAvailability(
    client,
    promotionMandateV2Schema,
    input.operationTimeoutMs,
  );
  const prepareSchemas = async (): Promise<void> => {
    await taskSchemaAvailability.resolve(input.taskMandateSchemaOobi.url);
    const taskV2Oobi = new URL(input.taskMandateSchemaOobi.url);
    taskV2Oobi.pathname = `/oobi/${taskMandateV2SchemaSaid}`;
    await taskV2SchemaAvailability.resolve(taskV2Oobi.href);
    await promotionSchemaAvailability.resolve(input.promotionMandateSchemaOobi.url);
    const promotionV2Oobi = new URL(input.promotionMandateSchemaOobi.url);
    promotionV2Oobi.pathname = `/oobi/${promotionMandateV2SchemaSaid}`;
    await promotionV2SchemaAvailability.resolve(promotionV2Oobi.href);
  };
  return {
    controllerAid: controller.controllerAid,
    agentAid: controller.agentAid,
    prepareSchemas,
    provisionRegistry: (request) =>
      provisionNamedCredentialRegistry(
        client,
        request.userAlias,
        request.userAid,
        MANDATE_REGISTRY_NAME,
        request.policy,
        request.operationTimeoutMs,
      ),
    reconcileIssuance: (request) => reconcileIssuance(client, request),
    async submitIssuance(request) {
      const schemaSaid = issuanceArguments(request).s;
      await prepareSchemas();
      const schema = [
        taskMandateV3Schema,
        promotionMandateV3Schema,
        promotionMandateV4Schema,
        promotionMandateV5Schema,
      ].find((schema) => schema.$id === schemaSaid);
      if (schema !== undefined) {
        const oobi = new URL(
          request.kind === 'TaskMandate'
            ? input.taskMandateSchemaOobi.url
            : input.promotionMandateSchemaOobi.url,
        );
        oobi.pathname = `/oobi/${schema.$id}`;
        await signifyCredentialSchemaAvailability(client, schema, input.operationTimeoutMs).resolve(
          oobi.href,
        );
      }
      return submitIssuance(client, request);
    },
    observeIssuance: (request) => observeIssuance(client, request),
    inspectCredential: (request) => inspectCredential(client, request.credentialSaid),
    async prepareGrant(request) {
      const [grant] = await preparedGrant(client, request);
      return { grantSaid: ipexGrantSaid(grant.said) };
    },
    reconcileGrant: (request) => reconcileGrant(client, request),
    submitGrant: (request) => submitGrant(client, request),
    observeGrant: (request) => observeGrant(client, request),
    beginHolderAdmission: (request) => beginHolderAdmission(client, request),
    observeHolderAdmission: (request) => observeHolderAdmission(client, request),
  };
}

function admissionUnavailable(): MandateAdmissionFailure {
  return { kind: 'Unavailable', dependency: 'Keria' };
}

function credentialStateIsIncompatible(inspection: MandateInspection): boolean {
  return (
    inspection.value.credential.telState.kind === 'IncompatibleCredentialState' ||
    inspection.value.credential.telState.kind === 'NotIssued'
  );
}

function mandateHolderAid(inspection: MandateInspection): PersonalAgentAid | GovernorAid {
  switch (inspection.kind) {
    case 'TaskMandate':
      return personalAgentAid(inspection.value.credential.issueeAid);
    case 'PromotionMandate':
      return governorAid(inspection.value.credential.issueeAid);
  }
}

function missingCredential(cause: unknown, said: string): boolean {
  return (
    cause instanceof IdentityFailure &&
    cause.detail.kind === 'keria-unavailable' &&
    cause.detail.reason.startsWith(`HTTP GET /credentials/${said} - 404 `)
  );
}

function missingExchange(cause: unknown, said: string): boolean {
  return (
    operationNotFound(cause, `/exchanges/${said}`) ||
    (cause instanceof IdentityFailure &&
      cause.detail.kind === 'keria-unavailable' &&
      cause.detail.reason.startsWith(`HTTP GET /exchanges/${said} - 404 `))
  );
}

async function inspectAdmission(
  client: SignifyClient,
  issuerAid: IssuerAid,
  input: MandateAdmissionInput,
): Promise<MandateAdmissionInspection> {
  let grant: unknown;
  try {
    grant = await client.exchanges().get(input.grantSaid);
  } catch (cause) {
    return missingExchange(cause, input.grantSaid)
      ? { kind: 'GrantPending' }
      : admissionUnavailable();
  }
  if (!Value.Check(grantBindingsSchema, grant)) {
    return { kind: 'Rejected', reason: 'GrantEvidenceInvalid' };
  }
  const bindings = grant.exn;
  if (bindings.rp !== issuerAid) {
    return { kind: 'Rejected', reason: 'GrantRecipientMismatch' };
  }
  if (bindings.e.acdc.d !== input.credentialSaid) {
    return { kind: 'Rejected', reason: 'CredentialSaidMismatch' };
  }
  if (bindings.e.acdc.i !== input.ownerAid) {
    return { kind: 'Rejected', reason: 'CredentialIssuerMismatch' };
  }
  if (bindings.i !== bindings.e.acdc.a.i) {
    return { kind: 'Rejected', reason: 'GrantSenderMismatch' };
  }
  try {
    verifyMandateIpexGrantEvidence(grant, {
      grantSaid: ipexGrantSaid(input.grantSaid),
      exchangeSenderAid: bindings.i,
      exchangeRecipientAid: issuerAid,
      credentialIssuerAid: input.ownerAid,
      credentialIssueeAid: bindings.e.acdc.a.i,
      credentialSaid: input.credentialSaid,
    });
    const inspection = await inspectEmbeddedCredential(client, grant);
    if (inspection.value.credential.issueeAid !== bindings.i) {
      return { kind: 'Rejected', reason: 'CredentialIssueeMismatch' };
    }
    if (
      inspection.value.credential.schemaSaid !== taskMandateSchemaSaid &&
      inspection.value.credential.schemaSaid !== taskMandateV2SchemaSaid &&
      inspection.value.credential.schemaSaid !== taskMandateV3SchemaSaid &&
      inspection.value.credential.schemaSaid !== promotionMandateSchemaSaid &&
      inspection.value.credential.schemaSaid !== promotionMandateV2SchemaSaid &&
      inspection.value.credential.schemaSaid !== promotionMandateV3SchemaSaid &&
      inspection.value.credential.schemaSaid !== promotionMandateV4SchemaSaid &&
      inspection.value.credential.schemaSaid !== promotionMandateV5SchemaSaid
    ) {
      return { kind: 'Rejected', reason: 'CredentialSchemaMismatch' };
    }
    if (credentialStateIsIncompatible(inspection)) {
      return { kind: 'Rejected', reason: 'IncompatibleCredentialState' };
    }
    if (
      inspection.value.credential.schemaDocument.schemaSaid !==
        inspection.value.credential.schemaSaid ||
      inspection.value.credential.issuerAnchor.kind !== 'Anchored'
    ) {
      return { kind: 'Rejected', reason: 'CredentialRegistryInvalid' };
    }
    return {
      kind: 'Inspected',
      evidence: {
        grantSenderAid: bindings.i,
        grantRecipientAid: issuerAid,
        inspection,
      },
    };
  } catch (cause) {
    if (cause instanceof IdentityFailure && cause.detail.kind === 'keria-unavailable') {
      return admissionUnavailable();
    }
    return { kind: 'Rejected', reason: 'GrantEvidenceInvalid' };
  }
}

export function signifyMandateAdmission(
  client: SignifyClient,
  issuerAlias: string,
  issuerAid: IssuerAid,
): MandateAdmission {
  return {
    inspect: (input) => inspectAdmission(client, issuerAid, input),
    async begin(input) {
      const inspected = await inspectAdmission(client, issuerAid, input);
      if (inspected.kind !== 'Inspected') {
        return inspected;
      }
      let prepared;
      try {
        prepared = await client.ipex().admit({
          senderName: issuerAlias,
          recipient: inspected.evidence.grantSenderAid,
          message: '',
          grantSaid: input.grantSaid,
          datetime: mandateProtocolDatetime(input.preparedAt),
        });
      } catch {
        return admissionUnavailable();
      }
      const [admit, signatures, attachment] = prepared;
      try {
        const recipientAid = mandateHolderAid(inspected.evidence.inspection);
        verifyIpexAdmitEvidence(admit.sad, {
          admitSaid: admit.said,
          grantSaid: ipexGrantSaid(input.grantSaid),
          sourceAid: issuerAid,
          recipientAid,
        });
      } catch {
        return { kind: 'Rejected', reason: 'AdmissionOperationFailed' };
      }
      let operations: unknown;
      try {
        operations = await client.operations().list('exchange');
      } catch {
        return admissionUnavailable();
      }
      let reconciliation: MandateOperationReconciliation;
      try {
        reconciliation = reconcileMandateOperationEvidence(operations, admit.said);
      } catch {
        return { kind: 'Rejected', reason: 'AdmissionOperationFailed' };
      }
      if (reconciliation.kind === 'Submitted') {
        return { kind: 'Started', operationName: reconciliation.operationName };
      }
      let operation: unknown;
      try {
        operation = await client
          .ipex()
          .submitAdmit(issuerAlias, admit, signatures, attachment, [
            inspected.evidence.grantSenderAid,
          ]);
        return {
          kind: 'Started',
          operationName: decodeMandateOperation(operation, admit.said).operationName,
        };
      } catch (cause) {
        return cause instanceof IdentityFailure
          ? { kind: 'Rejected', reason: 'AdmissionOperationFailed' }
          : admissionUnavailable();
      }
    },
    async observe(input) {
      let operation: unknown;
      try {
        operation = await client.operations().get(input.operationName);
      } catch {
        return admissionUnavailable();
      }
      if (!Value.Check(operationSchema, operation) || operation.name !== input.operationName) {
        return { kind: 'Rejected', reason: 'AdmissionOperationFailed' };
      }
      if (operation.error !== undefined) {
        return { kind: 'Rejected', reason: 'AdmissionOperationFailed' };
      }
      if (!operation.done) {
        return { kind: 'Pending' };
      }
      const inspected = await inspectAdmission(client, issuerAid, input);
      if (inspected.kind !== 'Inspected') {
        return inspected;
      }
      let admit: unknown;
      try {
        admit = await client.exchanges().get(operation.metadata.said);
      } catch {
        return admissionUnavailable();
      }
      if (typeof admit !== 'object' || admit === null || !('exn' in admit)) {
        return { kind: 'Rejected', reason: 'AdmissionOperationFailed' };
      }
      try {
        const recipientAid = mandateHolderAid(inspected.evidence.inspection);
        verifyIpexAdmitEvidence(admit.exn, {
          admitSaid: operation.metadata.said,
          grantSaid: ipexGrantSaid(input.grantSaid),
          sourceAid: issuerAid,
          recipientAid,
        });
      } catch {
        return { kind: 'Rejected', reason: 'AdmissionOperationFailed' };
      }
      let materialized: MandateInspection;
      try {
        materialized = await inspectCredential(client, credentialSaid(input.credentialSaid));
      } catch (cause) {
        if (missingCredential(cause, input.credentialSaid)) {
          return { kind: 'Pending' };
        }
        return admissionUnavailable();
      }
      if (JSON.stringify(materialized) !== JSON.stringify(inspected.evidence.inspection)) {
        return { kind: 'Rejected', reason: 'CredentialSaidMismatch' };
      }
      return {
        kind: 'Verified',
        credentialSaid: input.credentialSaid,
        evidence: { ...inspected.evidence, inspection: materialized },
      };
    },
  };
}
