import { describe, expect, it } from 'vitest';

import { promotionMandateSchemaSaid, taskMandateSchemaSaid } from '@devrandom/protocol';

import {
  loadMandateConfiguration,
  mandateEnvironment,
  type MandateEnvironment,
} from './mandate-environment.js';

const environment = {
  DEVRANDOM_TASK_MANDATE_SCHEMA_OOBI_URL: `https://schemas.example/oobi/${taskMandateSchemaSaid}`,
  DEVRANDOM_PROMOTION_MANDATE_SCHEMA_OOBI_URL: `https://schemas.example/oobi/${promotionMandateSchemaSaid}`,
} satisfies MandateEnvironment;

describe('mandate environment', () => {
  it('supplies the two independently pinned Compose-reachable schema OOBIs', () => {
    expect(loadMandateConfiguration({})).toEqual({
      taskMandateSchemaOobi: {
        kind: 'TaskMandateSchemaOobi',
        url: `http://server:3211/oobi/${taskMandateSchemaSaid}`,
      },
      promotionMandateSchemaOobi: {
        kind: 'PromotionMandateSchemaOobi',
        url: `http://server:3211/oobi/${promotionMandateSchemaSaid}`,
      },
    });
  });

  it('decodes explicit Task and Promotion schema OOBIs without deriving either from its sibling', () => {
    expect(loadMandateConfiguration(environment)).toEqual({
      taskMandateSchemaOobi: {
        kind: 'TaskMandateSchemaOobi',
        url: environment.DEVRANDOM_TASK_MANDATE_SCHEMA_OOBI_URL,
      },
      promotionMandateSchemaOobi: {
        kind: 'PromotionMandateSchemaOobi',
        url: environment.DEVRANDOM_PROMOTION_MANDATE_SCHEMA_OOBI_URL,
      },
    });
  });

  it('copies only the mandate schema inputs from the NodeJS environment boundary', () => {
    const processEnvironment: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      DEVRANDOM_TASK_MANDATE_SCHEMA_OOBI_URL: environment.DEVRANDOM_TASK_MANDATE_SCHEMA_OOBI_URL,
      DEVRANDOM_PROMOTION_MANDATE_SCHEMA_OOBI_URL:
        environment.DEVRANDOM_PROMOTION_MANDATE_SCHEMA_OOBI_URL,
      DEVRANDOM_UNRELATED: 'not mandate configuration',
    };

    expect(mandateEnvironment(processEnvironment)).toEqual(environment);
  });

  it.each([
    [
      'DEVRANDOM_TASK_MANDATE_SCHEMA_OOBI_URL',
      `https://schemas.example/oobi/${promotionMandateSchemaSaid}`,
    ],
    [
      'DEVRANDOM_PROMOTION_MANDATE_SCHEMA_OOBI_URL',
      `https://schemas.example/oobi/${taskMandateSchemaSaid}`,
    ],
  ] as const)('rejects a cross-bound %s', (field, value) => {
    expect(() => loadMandateConfiguration({ ...environment, [field]: value })).toThrow(
      `${field} is invalid`,
    );
  });

  it.each([
    ['DEVRANDOM_TASK_MANDATE_SCHEMA_OOBI_URL', 'not-an-oobi'],
    [
      'DEVRANDOM_PROMOTION_MANDATE_SCHEMA_OOBI_URL',
      `${environment.DEVRANDOM_PROMOTION_MANDATE_SCHEMA_OOBI_URL}?substitute=true`,
    ],
  ] as const)('rejects an invalid %s instead of falling back to its default', (field, value) => {
    expect(() => loadMandateConfiguration({ ...environment, [field]: value })).toThrow(
      `${field} is invalid`,
    );
  });
});
