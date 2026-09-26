import { promotionEvidenceClasses, taskEvolutionClasses } from '@devrandom/domain';
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

const taskMandateV2AttributesSchema = Type.Object(
  {
    ...taskMandateAttributesSchema.properties,
    allowedCapabilities: Type.Array(evaluationToolCapabilitySchema, {
      minItems: 1,
      maxItems: 7,
      uniqueItems: true,
    }),
    budgets: taskEvaluationBudgetsSchema,
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
    budgetCeiling: taskEvaluationBudgetsSchema,
    experience: evaluationExperienceSchema,
    notBefore: timestampSchema,
    expiresAt: timestampSchema,
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

export type MandateSchemaCatalogVerification =
  | { readonly kind: 'Verified' }
  | {
      readonly kind: 'Mismatch';
      readonly schema: 'TaskMandate' | 'TaskMandateV2' | 'PromotionMandate' | 'PromotionMandateV2';
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
  return { kind: 'Verified' };
}

export type TaskMandateCredential = Type.Static<typeof taskMandateSchema>;
export type TaskMandateV2Credential = Type.Static<typeof taskMandateV2Schema>;
export type TaskMandateAttributes = TaskMandateCredential['a'];
export type TaskMandateV2Attributes = TaskMandateV2Credential['a'];
export type PromotionMandateCredential = Type.Static<typeof promotionMandateSchema>;
export type PromotionMandateV2Credential = Type.Static<typeof promotionMandateV2Schema>;
export type PromotionMandateAttributes = PromotionMandateCredential['a'];
export type PromotionMandateV2Attributes = PromotionMandateV2Credential['a'];
export type MandateCredential =
  | TaskMandateCredential
  | TaskMandateV2Credential
  | PromotionMandateCredential
  | PromotionMandateV2Credential;

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
  if (!Value.Check(taskMandateV2Schema, input))
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  if (input.s !== taskMandateV2SchemaSaid) return { kind: 'Rejected', reason: 'UnexpectedSchema' };
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
  if (!Value.Check(promotionMandateV2Schema, input))
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  if (input.s !== promotionMandateV2SchemaSaid)
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
