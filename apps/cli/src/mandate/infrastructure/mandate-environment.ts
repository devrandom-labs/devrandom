import {
  promotionMandateSchemaOobi,
  taskMandateSchemaOobi,
  type PromotionMandateSchemaOobi,
  type TaskMandateSchemaOobi,
} from '@devrandom/identity';
import { promotionMandateSchemaSaid, taskMandateSchemaSaid } from '@devrandom/protocol';

const localComposeMandateSchemas = {
  task: `http://server:3211/oobi/${taskMandateSchemaSaid}`,
  promotion: `http://server:3211/oobi/${promotionMandateSchemaSaid}`,
} as const;

export interface MandateEnvironment {
  readonly DEVRANDOM_TASK_MANDATE_SCHEMA_OOBI_URL?: string | undefined;
  readonly DEVRANDOM_PROMOTION_MANDATE_SCHEMA_OOBI_URL?: string | undefined;
}

export interface MandateConfiguration {
  readonly taskMandateSchemaOobi: TaskMandateSchemaOobi;
  readonly promotionMandateSchemaOobi: PromotionMandateSchemaOobi;
}

export type MandateConfigurationField = Exclude<keyof MandateEnvironment, symbol | number>;

export class MandateConfigurationFailure extends Error {
  readonly field: MandateConfigurationField;

  constructor(field: MandateConfigurationField, cause: unknown) {
    super(`${field} is invalid`, { cause });
    this.name = 'MandateConfigurationFailure';
    this.field = field;
  }
}

export function mandateEnvironment(environment: NodeJS.ProcessEnv): MandateEnvironment {
  return {
    DEVRANDOM_TASK_MANDATE_SCHEMA_OOBI_URL: environment.DEVRANDOM_TASK_MANDATE_SCHEMA_OOBI_URL,
    DEVRANDOM_PROMOTION_MANDATE_SCHEMA_OOBI_URL:
      environment.DEVRANDOM_PROMOTION_MANDATE_SCHEMA_OOBI_URL,
  };
}

export function loadMandateConfiguration(environment: MandateEnvironment): MandateConfiguration {
  const taskSource =
    environment.DEVRANDOM_TASK_MANDATE_SCHEMA_OOBI_URL ?? localComposeMandateSchemas.task;
  const promotionSource =
    environment.DEVRANDOM_PROMOTION_MANDATE_SCHEMA_OOBI_URL ?? localComposeMandateSchemas.promotion;

  let configuredTaskSchema: TaskMandateSchemaOobi;
  try {
    configuredTaskSchema = taskMandateSchemaOobi(taskSource);
  } catch (cause) {
    throw new MandateConfigurationFailure('DEVRANDOM_TASK_MANDATE_SCHEMA_OOBI_URL', cause);
  }

  let configuredPromotionSchema: PromotionMandateSchemaOobi;
  try {
    configuredPromotionSchema = promotionMandateSchemaOobi(promotionSource);
  } catch (cause) {
    throw new MandateConfigurationFailure('DEVRANDOM_PROMOTION_MANDATE_SCHEMA_OOBI_URL', cause);
  }

  return {
    taskMandateSchemaOobi: configuredTaskSchema,
    promotionMandateSchemaOobi: configuredPromotionSchema,
  };
}
