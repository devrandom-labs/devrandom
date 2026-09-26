import {
  promotionEvidenceClasses,
  promotionRequiredChecks,
  promotionRequiredMetrics,
  promotionRiskLimit,
  taskEvolutionClasses,
} from '@devrandom/domain';
import { Saider } from 'signify-ts';
import Type from 'typebox';
import { Value } from 'typebox/value';

import {
  evolutionClassSchema,
  evaluationExperienceSchema,
  evaluationToolCapabilitySchema,
  preparedRepositorySchema,
  taskBudgetsSchema,
  taskEvaluationBudgetsSchema,
  toolCapabilitySchema,
} from '../task/task-command.js';

const keriIdentifierSchema = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const uuidV4Schema = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const timestampSchema = Type.String({
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
});
const protocolTimestampSchema = Type.String({ minLength: 1, format: 'date-time' });
const promotionEvidenceClassSchema = Type.Union([
  Type.Literal(promotionEvidenceClasses[0]),
  Type.Literal(promotionEvidenceClasses[1]),
  Type.Literal(promotionEvidenceClasses[2]),
  Type.Literal(promotionEvidenceClasses[3]),
  Type.Literal(promotionEvidenceClasses[4]),
  Type.Literal(promotionEvidenceClasses[5]),
  Type.Literal(promotionEvidenceClasses[6]),
  Type.Literal(promotionEvidenceClasses[7]),
]);

const taskMandateAttributesSchema = Type.Object(
  {
    d: keriIdentifierSchema,
    i: keriIdentifierSchema,
    dt: protocolTimestampSchema,
    authority: Type.Literal('ExecutePrivateTask'),
    taskId: uuidV4Schema,
    taskRevisionSaid: keriIdentifierSchema,
    harnessLineageId: uuidV4Schema,
    repository: preparedRepositorySchema,
    allowedCapabilities: Type.Array(toolCapabilitySchema, {
      minItems: 1,
      maxItems: 6,
      uniqueItems: true,
    }),
    budgets: taskBudgetsSchema,
    allowedEvolutionClasses: Type.Array(evolutionClassSchema, {
      minItems: 1,
      maxItems: taskEvolutionClasses.length,
      uniqueItems: true,
    }),
    notBefore: timestampSchema,
    expiresAt: timestampSchema,
  },
  { additionalProperties: false },
);

// Historical signed schemas retain their original six-Run ceiling and exact SAIDs.
const historicalEvaluationBudgetsSchema = Type.Object(
  {
    ...taskEvaluationBudgetsSchema.properties,
    runsPerAdmittedUser: taskBudgetsSchema.properties.runsPerAdmittedUser,
  },
  { additionalProperties: false },
);

const taskMandateV2AttributesSchema = Type.Object(
  {
    ...taskMandateAttributesSchema.properties,
    allowedCapabilities: Type.Array(evaluationToolCapabilitySchema, {
      minItems: 1,
      maxItems: 7,
      uniqueItems: true,
    }),
    budgets: historicalEvaluationBudgetsSchema,
    allowedEvolutionClasses: taskMandateAttributesSchema.properties.allowedEvolutionClasses,
    experience: evaluationExperienceSchema,
    notBefore: timestampSchema,
    expiresAt: timestampSchema,
  },
  { additionalProperties: false },
);

const promotionMandateAttributesSchema = Type.Object(
  {
    d: keriIdentifierSchema,
    i: keriIdentifierSchema,
    dt: protocolTimestampSchema,
    authority: Type.Literal('ActivateEvaluatedSuccessor'),
    taskId: uuidV4Schema,
    taskRevisionSaid: keriIdentifierSchema,
    harnessLineageId: uuidV4Schema,
    capabilityCeiling: Type.Array(toolCapabilitySchema, {
      minItems: 1,
      maxItems: 6,
      uniqueItems: true,
    }),
    budgetCeiling: taskBudgetsSchema,
    evolutionClassCeiling: Type.Array(evolutionClassSchema, {
      minItems: 1,
      maxItems: taskEvolutionClasses.length,
      uniqueItems: true,
    }),
    requiredEvidenceClasses: Type.Array(promotionEvidenceClassSchema, {
      minItems: promotionEvidenceClasses.length,
      maxItems: promotionEvidenceClasses.length,
      uniqueItems: true,
    }),
    notBefore: timestampSchema,
    expiresAt: timestampSchema,
  },
  { additionalProperties: false },
);

const promotionMandateV2AttributesSchema = Type.Object(
  {
    ...promotionMandateAttributesSchema.properties,
    capabilityCeiling: Type.Array(evaluationToolCapabilitySchema, {
      minItems: 1,
      maxItems: 7,
      uniqueItems: true,
    }),
    budgetCeiling: historicalEvaluationBudgetsSchema,
    experience: evaluationExperienceSchema,
    notBefore: timestampSchema,
    expiresAt: timestampSchema,
  },
  { additionalProperties: false },
);

const {
  notBefore: promotionV3NotBefore,
  expiresAt: promotionV3ExpiresAt,
  ...promotionV3BaseProperties
} = promotionMandateV2AttributesSchema.properties;
const promotionMandateV3AttributesSchema = Type.Object(
  {
    ...promotionV3BaseProperties,
    evaluationManifestSaid: keriIdentifierSchema,
    requiredMetrics: Type.Tuple(promotionRequiredMetrics.map((metric) => Type.Literal(metric))),
    requiredChecks: Type.Tuple(promotionRequiredChecks.map((check) => Type.Literal(check))),
    riskLimit: Type.Object(
      {
        maximumUnsafeEffects: Type.Literal(promotionRiskLimit.maximumUnsafeEffects),
        maximumDisqualifyingAttempts: Type.Literal(promotionRiskLimit.maximumDisqualifyingAttempts),
        minimumAdditionalSuccessesOverEachControl: Type.Literal(
          promotionRiskLimit.minimumAdditionalSuccessesOverEachControl,
        ),
      },
      { additionalProperties: false },
    ),
    notBefore: promotionV3NotBefore,
    expiresAt: promotionV3ExpiresAt,
  },
  { additionalProperties: false },
);

function mandateSchema<Attributes extends ReturnType<typeof Type.Object>>(
  attributes: Attributes,
  title: string,
  description: string,
  credentialType: string,
  version = '1.0.0',
) {
  return Type.Object(
    {
      v: Type.String({ description: 'Credential format version' }),
      d: keriIdentifierSchema,
      i: keriIdentifierSchema,
      ri: keriIdentifierSchema,
      s: keriIdentifierSchema,
      a: attributes,
    },
    {
      $id: '',
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      title,
      description,
      credentialType,
      version,
      additionalProperties: false,
    },
  );
}

const taskMandateSchemaDefinition = mandateSchema(
  taskMandateAttributesSchema,
  'Devrandom Task Mandate',
  'User-issued authority for one personal agent and exact Task Revision',
  'DevrandomTaskMandate',
);

const [taskMandateSchemaId] = Saider.saidify(
  taskMandateSchemaDefinition,
  undefined,
  undefined,
  '$id',
);

export const taskMandateSchemaSaid = taskMandateSchemaId.qb64;
export const taskMandateSchema = {
  ...taskMandateSchemaDefinition,
  $id: taskMandateSchemaSaid,
};

const taskMandateV2SchemaDefinition = mandateSchema(
  taskMandateV2AttributesSchema,
  'Devrandom Task Mandate v2',
  'User-issued bounded PRD03 authority for one personal agent, Task Revision and experience corpus',
  'DevrandomTaskMandate',
  '2.0.0',
);
const [taskMandateV2SchemaId] = Saider.saidify(
  taskMandateV2SchemaDefinition,
  undefined,
  undefined,
  '$id',
);
export const taskMandateV2SchemaSaid = taskMandateV2SchemaId.qb64;
export const taskMandateV2Schema = {
  ...taskMandateV2SchemaDefinition,
  $id: taskMandateV2SchemaSaid,
};

const promotionMandateSchemaDefinition = mandateSchema(
  promotionMandateAttributesSchema,
  'Devrandom Promotion Mandate',
  'User-issued authority for one Governor and bounded future activation',
  'DevrandomPromotionMandate',
);

const [promotionMandateSchemaId] = Saider.saidify(
  promotionMandateSchemaDefinition,
  undefined,
  undefined,
  '$id',
);

export const promotionMandateSchemaSaid = promotionMandateSchemaId.qb64;
export const promotionMandateSchema = {
  ...promotionMandateSchemaDefinition,
  $id: promotionMandateSchemaSaid,
};

const promotionMandateV2SchemaDefinition = mandateSchema(
  promotionMandateV2AttributesSchema,
  'Devrandom Promotion Mandate v2',
  'User-issued bounded PRD03 authority for one Governor, Task Revision and experience corpus',
  'DevrandomPromotionMandate',
  '2.0.0',
);
const [promotionMandateV2SchemaId] = Saider.saidify(
  promotionMandateV2SchemaDefinition,
  undefined,
  undefined,
  '$id',
);
export const promotionMandateV2SchemaSaid = promotionMandateV2SchemaId.qb64;
export const promotionMandateV2Schema = {
  ...promotionMandateV2SchemaDefinition,
  $id: promotionMandateV2SchemaSaid,
};

const promotionMandateV3SchemaDefinition = mandateSchema(
  promotionMandateV3AttributesSchema,
  'Devrandom Promotion Mandate v3',
  'User-confirmed exact E4 authority for one Governor, Task Revision and evaluation manifest',
  'DevrandomPromotionMandate',
  '3.0.0',
);
const [promotionMandateV3SchemaId] = Saider.saidify(
  promotionMandateV3SchemaDefinition,
  undefined,
  undefined,
  '$id',
);
export const promotionMandateV3SchemaSaid = promotionMandateV3SchemaId.qb64;
export const promotionMandateV3Schema = {
  ...promotionMandateV3SchemaDefinition,
  $id: promotionMandateV3SchemaSaid,
};

// Eight-Run credential versions remain immutable when the supported Task ceiling grows.
const eightRunEvaluationBudgetsSchema = Type.Object(
  {
    ...taskEvaluationBudgetsSchema.properties,
    runsPerAdmittedUser: Type.Integer({ minimum: 0, maximum: 8 }),
  },
  { additionalProperties: false },
);

const taskMandateV3SchemaDefinition = mandateSchema(
  Type.Object(
    { ...taskMandateV2AttributesSchema.properties, budgets: eightRunEvaluationBudgetsSchema },
    { additionalProperties: false },
  ),
  'Devrandom Task Mandate v3',
  'User-issued bounded PRD03 authority with an explicit eight-Run owner ceiling',
  'DevrandomTaskMandate',
  '3.0.0',
);
const [taskMandateV3SchemaId] = Saider.saidify(
  taskMandateV3SchemaDefinition,
  undefined,
  undefined,
  '$id',
);
export const taskMandateV3SchemaSaid = taskMandateV3SchemaId.qb64;
export const taskMandateV3Schema = {
  ...taskMandateV3SchemaDefinition,
  $id: taskMandateV3SchemaSaid,
};

const promotionMandateV4SchemaDefinition = mandateSchema(
  Type.Object(
    {
      ...promotionMandateV2AttributesSchema.properties,
      budgetCeiling: eightRunEvaluationBudgetsSchema,
    },
    { additionalProperties: false },
  ),
  'Devrandom Promotion Mandate v4',
  'User-issued bounded PRD03 future activation authority with an explicit eight-Run owner ceiling',
  'DevrandomPromotionMandate',
  '4.0.0',
);
const [promotionMandateV4SchemaId] = Saider.saidify(
  promotionMandateV4SchemaDefinition,
  undefined,
  undefined,
  '$id',
);
export const promotionMandateV4SchemaSaid = promotionMandateV4SchemaId.qb64;
export const promotionMandateV4Schema = {
  ...promotionMandateV4SchemaDefinition,
  $id: promotionMandateV4SchemaSaid,
};

const promotionMandateV5SchemaDefinition = mandateSchema(
  Type.Object(
    {
      ...promotionMandateV3AttributesSchema.properties,
      budgetCeiling: eightRunEvaluationBudgetsSchema,
    },
    { additionalProperties: false },
  ),
  'Devrandom Promotion Mandate v5',
  'User-confirmed exact E4 authority with an explicit eight-Run owner ceiling',
  'DevrandomPromotionMandate',
  '5.0.0',
);
const [promotionMandateV5SchemaId] = Saider.saidify(
  promotionMandateV5SchemaDefinition,
  undefined,
  undefined,
  '$id',
);
export const promotionMandateV5SchemaSaid = promotionMandateV5SchemaId.qb64;
export const promotionMandateV5Schema = {
  ...promotionMandateV5SchemaDefinition,
  $id: promotionMandateV5SchemaSaid,
};

const taskMandateV4SchemaDefinition = mandateSchema(
  Type.Object(
    { ...taskMandateV2AttributesSchema.properties, budgets: taskEvaluationBudgetsSchema },
    { additionalProperties: false },
  ),
  'Devrandom Task Mandate v4',
  'User-issued bounded PRD03 authority with an explicit nine-Run owner ceiling',
  'DevrandomTaskMandate',
  '4.0.0',
);
const [taskMandateV4SchemaId] = Saider.saidify(
  taskMandateV4SchemaDefinition,
  undefined,
  undefined,
  '$id',
);
export const taskMandateV4SchemaSaid = taskMandateV4SchemaId.qb64;
export const taskMandateV4Schema = {
  ...taskMandateV4SchemaDefinition,
  $id: taskMandateV4SchemaSaid,
};

const promotionMandateV6SchemaDefinition = mandateSchema(
  Type.Object(
    {
      ...promotionMandateV2AttributesSchema.properties,
      budgetCeiling: taskEvaluationBudgetsSchema,
    },
    { additionalProperties: false },
  ),
  'Devrandom Promotion Mandate v6',
  'User-issued bounded PRD03 future activation authority with an explicit nine-Run owner ceiling',
  'DevrandomPromotionMandate',
  '6.0.0',
);
const [promotionMandateV6SchemaId] = Saider.saidify(
  promotionMandateV6SchemaDefinition,
  undefined,
  undefined,
  '$id',
);
export const promotionMandateV6SchemaSaid = promotionMandateV6SchemaId.qb64;
export const promotionMandateV6Schema = {
  ...promotionMandateV6SchemaDefinition,
  $id: promotionMandateV6SchemaSaid,
};

const promotionMandateV7SchemaDefinition = mandateSchema(
  Type.Object(
    {
      ...promotionMandateV3AttributesSchema.properties,
      budgetCeiling: taskEvaluationBudgetsSchema,
    },
    { additionalProperties: false },
  ),
  'Devrandom Promotion Mandate v7',
  'User-confirmed exact E4 authority with an explicit nine-Run owner ceiling',
  'DevrandomPromotionMandate',
  '7.0.0',
);
const [promotionMandateV7SchemaId] = Saider.saidify(
  promotionMandateV7SchemaDefinition,
  undefined,
  undefined,
  '$id',
);
export const promotionMandateV7SchemaSaid = promotionMandateV7SchemaId.qb64;
export const promotionMandateV7Schema = {
  ...promotionMandateV7SchemaDefinition,
  $id: promotionMandateV7SchemaSaid,
};

export type MandateSchemaCatalogVerification =
  | { readonly kind: 'Verified' }
  | {
      readonly kind: 'Mismatch';
      readonly schema:
        | 'TaskMandate'
        | 'TaskMandateV2'
        | 'PromotionMandate'
        | 'PromotionMandateV2'
        | 'PromotionMandateV3'
        | 'TaskMandateV3'
        | 'PromotionMandateV4'
        | 'PromotionMandateV5'
        | 'TaskMandateV4'
        | 'PromotionMandateV6'
        | 'PromotionMandateV7';
      readonly expectedSaid: string;
    };

function schemaMatchesSaid(schema: object, expectedSaid: string): boolean {
  if (Reflect.get(schema, '$id') !== expectedSaid) {
    return false;
  }
  try {
    return new Saider({ qb64: expectedSaid }).verify(schema, true, false, undefined, '$id');
  } catch {
    return false;
  }
}

export function verifyMandateSchemaCatalog(): MandateSchemaCatalogVerification {
  if (!schemaMatchesSaid(taskMandateSchema, taskMandateSchemaSaid)) {
    return {
      kind: 'Mismatch',
      schema: 'TaskMandate',
      expectedSaid: taskMandateSchemaSaid,
    };
  }
  if (!schemaMatchesSaid(promotionMandateSchema, promotionMandateSchemaSaid)) {
    return {
      kind: 'Mismatch',
      schema: 'PromotionMandate',
      expectedSaid: promotionMandateSchemaSaid,
    };
  }
  if (!schemaMatchesSaid(taskMandateV2Schema, taskMandateV2SchemaSaid)) {
    return { kind: 'Mismatch', schema: 'TaskMandateV2', expectedSaid: taskMandateV2SchemaSaid };
  }
  if (!schemaMatchesSaid(promotionMandateV2Schema, promotionMandateV2SchemaSaid)) {
    return {
      kind: 'Mismatch',
      schema: 'PromotionMandateV2',
      expectedSaid: promotionMandateV2SchemaSaid,
    };
  }
  if (!schemaMatchesSaid(promotionMandateV3Schema, promotionMandateV3SchemaSaid)) {
    return {
      kind: 'Mismatch',
      schema: 'PromotionMandateV3',
      expectedSaid: promotionMandateV3SchemaSaid,
    };
  }
  if (!schemaMatchesSaid(taskMandateV3Schema, taskMandateV3SchemaSaid))
    return { kind: 'Mismatch', schema: 'TaskMandateV3', expectedSaid: taskMandateV3SchemaSaid };
  if (!schemaMatchesSaid(promotionMandateV4Schema, promotionMandateV4SchemaSaid))
    return {
      kind: 'Mismatch',
      schema: 'PromotionMandateV4',
      expectedSaid: promotionMandateV4SchemaSaid,
    };
  if (!schemaMatchesSaid(promotionMandateV5Schema, promotionMandateV5SchemaSaid))
    return {
      kind: 'Mismatch',
      schema: 'PromotionMandateV5',
      expectedSaid: promotionMandateV5SchemaSaid,
    };
  if (!schemaMatchesSaid(taskMandateV4Schema, taskMandateV4SchemaSaid))
    return { kind: 'Mismatch', schema: 'TaskMandateV4', expectedSaid: taskMandateV4SchemaSaid };
  if (!schemaMatchesSaid(promotionMandateV6Schema, promotionMandateV6SchemaSaid))
    return {
      kind: 'Mismatch',
      schema: 'PromotionMandateV6',
      expectedSaid: promotionMandateV6SchemaSaid,
    };
  if (!schemaMatchesSaid(promotionMandateV7Schema, promotionMandateV7SchemaSaid))
    return {
      kind: 'Mismatch',
      schema: 'PromotionMandateV7',
      expectedSaid: promotionMandateV7SchemaSaid,
    };
  return { kind: 'Verified' };
}

export type TaskMandateCredential = Type.Static<typeof taskMandateSchema>;
export type TaskMandateV2Credential = Type.Static<typeof taskMandateV2Schema>;
export type TaskMandateAttributes = TaskMandateCredential['a'];
export type TaskMandateV2Attributes = TaskMandateV2Credential['a'];
export type PromotionMandateCredential = Type.Static<typeof promotionMandateSchema>;
export type PromotionMandateV2Credential = Type.Static<typeof promotionMandateV2Schema>;
export type PromotionMandateV3Credential = Type.Static<typeof promotionMandateV3Schema>;
export type PromotionMandateAttributes = PromotionMandateCredential['a'];
export type PromotionMandateV2Attributes = PromotionMandateV2Credential['a'];
export type PromotionMandateV3Attributes = PromotionMandateV3Credential['a'];
export type MandateCredential =
  | TaskMandateCredential
  | TaskMandateV2Credential
  | PromotionMandateCredential
  | PromotionMandateV2Credential
  | PromotionMandateV3Credential;

export type MandateCredentialInvalidity =
  | 'SchemaInvalid'
  | 'UnexpectedSchema'
  | 'NonCanonical'
  | 'AttributeSaidMismatch'
  | 'CredentialSaidMismatch';

export type TaskMandateCredentialDecoding =
  | { readonly kind: 'Accepted'; readonly credential: TaskMandateCredential }
  | { readonly kind: 'Rejected'; readonly reason: MandateCredentialInvalidity };

export type TaskMandateV2CredentialDecoding =
  | { readonly kind: 'Accepted'; readonly credential: TaskMandateV2Credential }
  | { readonly kind: 'Rejected'; readonly reason: MandateCredentialInvalidity };

export type PromotionMandateCredentialDecoding =
  | { readonly kind: 'Accepted'; readonly credential: PromotionMandateCredential }
  | { readonly kind: 'Rejected'; readonly reason: MandateCredentialInvalidity };

export type PromotionMandateV2CredentialDecoding =
  | { readonly kind: 'Accepted'; readonly credential: PromotionMandateV2Credential }
  | { readonly kind: 'Rejected'; readonly reason: MandateCredentialInvalidity };

export type PromotionMandateV3CredentialDecoding =
  | { readonly kind: 'Accepted'; readonly credential: PromotionMandateV3Credential }
  | { readonly kind: 'Rejected'; readonly reason: MandateCredentialInvalidity };

function compareUtf8(left: string, right: string): number {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const sharedLength = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const leftByte = leftBytes[index];
    const rightByte = rightBytes[index];
    if (leftByte !== undefined && rightByte !== undefined && leftByte !== rightByte) {
      return leftByte - rightByte;
    }
  }
  return leftBytes.length - rightBytes.length;
}

function sorted<Value extends string>(values: readonly Value[]): Value[] {
  return [...values].sort(compareUtf8);
}

function rebuildBudgets(budgets: Type.Static<typeof taskBudgetsSchema>) {
  return {
    workAccessAttemptLifetimeSeconds: budgets.workAccessAttemptLifetimeSeconds,
    workAccessGrantLifetimeSeconds: budgets.workAccessGrantLifetimeSeconds,
    nonterminalAttemptsPerUserClient: budgets.nonterminalAttemptsPerUserClient,
    activeGrantsPerUserClient: budgets.activeGrantsPerUserClient,
    publicAttemptCreationsPerMinutePerLoopbackSource:
      budgets.publicAttemptCreationsPerMinutePerLoopbackSource,
    nonterminalAttemptsGlobally: budgets.nonterminalAttemptsGlobally,
    requestsPerGrant: budgets.requestsPerGrant,
    tasksPerAdmittedUser: budgets.tasksPerAdmittedUser,
    runsPerAdmittedUser: budgets.runsPerAdmittedUser,
    activeRunsPerAdmittedUser: budgets.activeRunsPerAdmittedUser,
    hostedWorkTasksGlobally: budgets.hostedWorkTasksGlobally,
    hostedWorkRunsGlobally: budgets.hostedWorkRunsGlobally,
    activeHostedWorkRunsGlobally: budgets.activeHostedWorkRunsGlobally,
    ordinaryJsonRequestBodyBytes: budgets.ordinaryJsonRequestBodyBytes,
    evidenceBatchBodyBytes: budgets.evidenceBatchBodyBytes,
    artifactRequestBodyBytes: budgets.artifactRequestBodyBytes,
    evidencePlusArtifactsPerRunBytes: budgets.evidencePlusArtifactsPerRunBytes,
    acceptedEvidencePlusArtifactsGloballyBytes: budgets.acceptedEvidencePlusArtifactsGloballyBytes,
    runWallTimeSeconds: budgets.runWallTimeSeconds,
    providerRequests: budgets.providerRequests,
    providerInputTokens: budgets.providerInputTokens,
    providerOutputTokens: budgets.providerOutputTokens,
    toolProposals: budgets.toolProposals,
    aggregateChildCommandTimeSeconds: budgets.aggregateChildCommandTimeSeconds,
    oneChildCommandTimeSeconds: budgets.oneChildCommandTimeSeconds,
    changedFiles: budgets.changedFiles,
    changedWorktreeBytes: budgets.changedWorktreeBytes,
    providerSpendMicroUsd: budgets.providerSpendMicroUsd,
  };
}

function rebuildRepository(repository: Type.Static<typeof preparedRepositorySchema>) {
  return {
    objectFormat: repository.objectFormat,
    commit: repository.commit,
    tree: repository.tree,
  };
}

function rebuildTaskMandateCredential(credential: TaskMandateCredential) {
  return {
    v: credential.v,
    d: credential.d,
    i: credential.i,
    ri: credential.ri,
    s: credential.s,
    a: {
      d: credential.a.d,
      i: credential.a.i,
      dt: credential.a.dt,
      authority: credential.a.authority,
      taskId: credential.a.taskId,
      taskRevisionSaid: credential.a.taskRevisionSaid,
      harnessLineageId: credential.a.harnessLineageId,
      repository: rebuildRepository(credential.a.repository),
      allowedCapabilities: sorted(credential.a.allowedCapabilities),
      budgets: rebuildBudgets(credential.a.budgets),
      allowedEvolutionClasses: sorted(credential.a.allowedEvolutionClasses),
      notBefore: credential.a.notBefore,
      expiresAt: credential.a.expiresAt,
    },
  };
}

function rebuildTaskMandateV2Credential(credential: TaskMandateV2Credential) {
  return {
    v: credential.v,
    d: credential.d,
    i: credential.i,
    ri: credential.ri,
    s: credential.s,
    a: {
      d: credential.a.d,
      i: credential.a.i,
      dt: credential.a.dt,
      authority: credential.a.authority,
      taskId: credential.a.taskId,
      taskRevisionSaid: credential.a.taskRevisionSaid,
      harnessLineageId: credential.a.harnessLineageId,
      repository: rebuildRepository(credential.a.repository),
      allowedCapabilities: sorted(credential.a.allowedCapabilities),
      budgets: rebuildBudgets(credential.a.budgets),
      allowedEvolutionClasses: sorted(credential.a.allowedEvolutionClasses),
      experience: {
        corpusSaid: credential.a.experience.corpusSaid,
        repositoryResourceSaid: credential.a.experience.repositoryResourceSaid,
        disclosure: credential.a.experience.disclosure,
      },
      notBefore: credential.a.notBefore,
      expiresAt: credential.a.expiresAt,
    },
  };
}

function rebuildPromotionMandateCredential(credential: PromotionMandateCredential) {
  return {
    v: credential.v,
    d: credential.d,
    i: credential.i,
    ri: credential.ri,
    s: credential.s,
    a: {
      d: credential.a.d,
      i: credential.a.i,
      dt: credential.a.dt,
      authority: credential.a.authority,
      taskId: credential.a.taskId,
      taskRevisionSaid: credential.a.taskRevisionSaid,
      harnessLineageId: credential.a.harnessLineageId,
      capabilityCeiling: sorted(credential.a.capabilityCeiling),
      budgetCeiling: rebuildBudgets(credential.a.budgetCeiling),
      evolutionClassCeiling: sorted(credential.a.evolutionClassCeiling),
      requiredEvidenceClasses: [...promotionEvidenceClasses],
      notBefore: credential.a.notBefore,
      expiresAt: credential.a.expiresAt,
    },
  };
}

function rebuildPromotionMandateV2Credential(credential: PromotionMandateV2Credential) {
  return {
    v: credential.v,
    d: credential.d,
    i: credential.i,
    ri: credential.ri,
    s: credential.s,
    a: {
      d: credential.a.d,
      i: credential.a.i,
      dt: credential.a.dt,
      authority: credential.a.authority,
      taskId: credential.a.taskId,
      taskRevisionSaid: credential.a.taskRevisionSaid,
      harnessLineageId: credential.a.harnessLineageId,
      capabilityCeiling: sorted(credential.a.capabilityCeiling),
      budgetCeiling: rebuildBudgets(credential.a.budgetCeiling),
      evolutionClassCeiling: sorted(credential.a.evolutionClassCeiling),
      requiredEvidenceClasses: [...promotionEvidenceClasses],
      experience: {
        corpusSaid: credential.a.experience.corpusSaid,
        repositoryResourceSaid: credential.a.experience.repositoryResourceSaid,
        disclosure: credential.a.experience.disclosure,
      },
      notBefore: credential.a.notBefore,
      expiresAt: credential.a.expiresAt,
    },
  };
}

function rebuildPromotionMandateV3Credential(credential: PromotionMandateV3Credential) {
  return {
    v: credential.v,
    d: credential.d,
    i: credential.i,
    ri: credential.ri,
    s: credential.s,
    a: {
      d: credential.a.d,
      i: credential.a.i,
      dt: credential.a.dt,
      authority: credential.a.authority,
      taskId: credential.a.taskId,
      taskRevisionSaid: credential.a.taskRevisionSaid,
      harnessLineageId: credential.a.harnessLineageId,
      capabilityCeiling: sorted(credential.a.capabilityCeiling),
      budgetCeiling: rebuildBudgets(credential.a.budgetCeiling),
      evolutionClassCeiling: sorted(credential.a.evolutionClassCeiling),
      requiredEvidenceClasses: [...promotionEvidenceClasses],
      experience: {
        corpusSaid: credential.a.experience.corpusSaid,
        repositoryResourceSaid: credential.a.experience.repositoryResourceSaid,
        disclosure: credential.a.experience.disclosure,
      },
      evaluationManifestSaid: credential.a.evaluationManifestSaid,
      requiredMetrics: [...promotionRequiredMetrics],
      requiredChecks: [...promotionRequiredChecks],
      riskLimit: { ...promotionRiskLimit },
      notBefore: credential.a.notBefore,
      expiresAt: credential.a.expiresAt,
    },
  };
}

type SaidDocumentKind = 'Credential' | 'Attributes';

function saidIsValid(document: object, said: string, documentKind: SaidDocumentKind): boolean {
  try {
    return new Saider({ qb64: said }).verify(document, true, documentKind === 'Credential');
  } catch {
    return false;
  }
}

export function decodeTaskMandateCredential(input: unknown): TaskMandateCredentialDecoding {
  if (!Value.Check(taskMandateSchema, input)) {
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  }
  if (input.s !== taskMandateSchemaSaid) {
    return { kind: 'Rejected', reason: 'UnexpectedSchema' };
  }
  const canonical = rebuildTaskMandateCredential(input);
  if (JSON.stringify(input) !== JSON.stringify(canonical)) {
    return { kind: 'Rejected', reason: 'NonCanonical' };
  }
  if (!saidIsValid(input.a, input.a.d, 'Attributes')) {
    return { kind: 'Rejected', reason: 'AttributeSaidMismatch' };
  }
  if (!saidIsValid(input, input.d, 'Credential')) {
    return { kind: 'Rejected', reason: 'CredentialSaidMismatch' };
  }
  return { kind: 'Accepted', credential: input };
}

export function decodeTaskMandateCredentialV2(input: unknown): TaskMandateV2CredentialDecoding {
  const schema =
    typeof input === 'object' &&
    input !== null &&
    Reflect.get(input, 's') === taskMandateV4SchemaSaid
      ? taskMandateV4Schema
      : typeof input === 'object' &&
          input !== null &&
          Reflect.get(input, 's') === taskMandateV3SchemaSaid
        ? taskMandateV3Schema
        : taskMandateV2Schema;
  if (!Value.Check(schema, input)) return { kind: 'Rejected', reason: 'SchemaInvalid' };
  if (
    input.s !== taskMandateV2SchemaSaid &&
    input.s !== taskMandateV3SchemaSaid &&
    input.s !== taskMandateV4SchemaSaid
  )
    return { kind: 'Rejected', reason: 'UnexpectedSchema' };
  const canonical = rebuildTaskMandateV2Credential(input);
  if (JSON.stringify(input) !== JSON.stringify(canonical))
    return { kind: 'Rejected', reason: 'NonCanonical' };
  if (!saidIsValid(input.a, input.a.d, 'Attributes'))
    return { kind: 'Rejected', reason: 'AttributeSaidMismatch' };
  if (!saidIsValid(input, input.d, 'Credential'))
    return { kind: 'Rejected', reason: 'CredentialSaidMismatch' };
  return { kind: 'Accepted', credential: input };
}

export function decodePromotionMandateCredential(
  input: unknown,
): PromotionMandateCredentialDecoding {
  if (!Value.Check(promotionMandateSchema, input)) {
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  }
  if (input.s !== promotionMandateSchemaSaid) {
    return { kind: 'Rejected', reason: 'UnexpectedSchema' };
  }
  const canonical = rebuildPromotionMandateCredential(input);
  if (JSON.stringify(input) !== JSON.stringify(canonical)) {
    return { kind: 'Rejected', reason: 'NonCanonical' };
  }
  if (!saidIsValid(input.a, input.a.d, 'Attributes')) {
    return { kind: 'Rejected', reason: 'AttributeSaidMismatch' };
  }
  if (!saidIsValid(input, input.d, 'Credential')) {
    return { kind: 'Rejected', reason: 'CredentialSaidMismatch' };
  }
  return { kind: 'Accepted', credential: input };
}

export function decodePromotionMandateCredentialV2(
  input: unknown,
): PromotionMandateV2CredentialDecoding {
  const schema =
    typeof input === 'object' &&
    input !== null &&
    Reflect.get(input, 's') === promotionMandateV6SchemaSaid
      ? promotionMandateV6Schema
      : typeof input === 'object' &&
          input !== null &&
          Reflect.get(input, 's') === promotionMandateV4SchemaSaid
        ? promotionMandateV4Schema
        : promotionMandateV2Schema;
  if (!Value.Check(schema, input)) return { kind: 'Rejected', reason: 'SchemaInvalid' };
  if (
    input.s !== promotionMandateV2SchemaSaid &&
    input.s !== promotionMandateV4SchemaSaid &&
    input.s !== promotionMandateV6SchemaSaid
  )
    return { kind: 'Rejected', reason: 'UnexpectedSchema' };
  const canonical = rebuildPromotionMandateV2Credential(input);
  if (JSON.stringify(input) !== JSON.stringify(canonical))
    return { kind: 'Rejected', reason: 'NonCanonical' };
  if (!saidIsValid(input.a, input.a.d, 'Attributes'))
    return { kind: 'Rejected', reason: 'AttributeSaidMismatch' };
  if (!saidIsValid(input, input.d, 'Credential'))
    return { kind: 'Rejected', reason: 'CredentialSaidMismatch' };
  return { kind: 'Accepted', credential: input };
}

export function decodePromotionMandateCredentialV3(
  input: unknown,
): PromotionMandateV3CredentialDecoding {
  const schema =
    typeof input === 'object' &&
    input !== null &&
    Reflect.get(input, 's') === promotionMandateV7SchemaSaid
      ? promotionMandateV7Schema
      : typeof input === 'object' &&
          input !== null &&
          Reflect.get(input, 's') === promotionMandateV5SchemaSaid
        ? promotionMandateV5Schema
        : promotionMandateV3Schema;
  if (!Value.Check(schema, input)) return { kind: 'Rejected', reason: 'SchemaInvalid' };
  if (
    input.s !== promotionMandateV3SchemaSaid &&
    input.s !== promotionMandateV5SchemaSaid &&
    input.s !== promotionMandateV7SchemaSaid
  )
    return { kind: 'Rejected', reason: 'UnexpectedSchema' };
  if (JSON.stringify(input) !== JSON.stringify(rebuildPromotionMandateV3Credential(input)))
    return { kind: 'Rejected', reason: 'NonCanonical' };
  if (!saidIsValid(input.a, input.a.d, 'Attributes'))
    return { kind: 'Rejected', reason: 'AttributeSaidMismatch' };
  if (!saidIsValid(input, input.d, 'Credential'))
    return { kind: 'Rejected', reason: 'CredentialSaidMismatch' };
  return { kind: 'Accepted', credential: input };
}

/** Selects the immutable wire schema; callers still verify all budget and current-authority laws. */
export function selectTaskMandateSchemaSaid(version: 1 | 2, runsPerAdmittedUser: number): string {
  return version === 1
    ? taskMandateSchemaSaid
    : runsPerAdmittedUser > 8
      ? taskMandateV4SchemaSaid
      : runsPerAdmittedUser > 6
        ? taskMandateV3SchemaSaid
        : taskMandateV2SchemaSaid;
}
export function selectInitialPromotionMandateSchemaSaid(
  version: 1 | 2,
  runsPerAdmittedUser: number,
): string {
  return version === 1
    ? promotionMandateSchemaSaid
    : runsPerAdmittedUser > 8
      ? promotionMandateV6SchemaSaid
      : runsPerAdmittedUser > 6
        ? promotionMandateV4SchemaSaid
        : promotionMandateV2SchemaSaid;
}
export function selectExactPromotionMandateSchemaSaid(runsPerAdmittedUser: number): string {
  return runsPerAdmittedUser > 8
    ? promotionMandateV7SchemaSaid
    : runsPerAdmittedUser > 6
      ? promotionMandateV5SchemaSaid
      : promotionMandateV3SchemaSaid;
}
