import { Value } from 'typebox/value';
import { describe, expect, it } from 'vitest';

import {
  mandatePresentationParametersSchema,
  mandatePresentationProblemSchema,
  mandatePresentationProjectionSchema,
  presentMandateBodySchema,
} from './mandate-http.js';

const credentialSaid = `E${'c'.repeat(43)}`;
const grantSaid = `E${'g'.repeat(43)}`;

describe('Mandate presentation HTTP contract', () => {
  it('accepts only the closed resource command', () => {
    expect(Value.Check(mandatePresentationParametersSchema, { credentialSaid })).toBe(true);
    expect(
      Value.Check(presentMandateBodySchema, {
        version: 1,
        mandateKind: 'TaskMandate',
        grantSaid,
      }),
    ).toBe(true);
    expect(
      Value.Check(presentMandateBodySchema, {
        version: 1,
        mandateKind: 'TaskMandate',
        grantSaid,
        ownerAid: `E${'o'.repeat(43)}`,
      }),
    ).toBe(false);
  });

  it('models every persisted presentation state as a closed alternative', () => {
    const binding = {
      version: 1,
      mandateKind: 'PromotionMandate',
      credentialSaid,
      grantSaid,
      presentationExpiresAt: '2026-09-24T14:30:00.000Z',
    };
    expect(
      [
        { ...binding, kind: 'AwaitingGrant' },
        { ...binding, kind: 'Admitting', operationName: 'operation/name' },
        { ...binding, kind: 'Admitted', admittedAt: '2026-09-24T14:01:00.000Z' },
        { ...binding, kind: 'Rejected', reason: 'CredentialBindingInvalid' },
        { ...binding, kind: 'Expired' },
      ].every((projection) => Value.Check(mandatePresentationProjectionSchema, projection)),
    ).toBe(true);
  });

  it('admits only the typed presentation problem alternatives', () => {
    expect(
      Value.Check(mandatePresentationProblemSchema, {
        type: 'https://devrandom.example/problems/mandate-presentation-rejected',
        title: 'Mandate presentation was rejected',
        status: 422,
        code: 'MandatePresentationRejected',
        correlationId: '4df838a8-5109-49fd-bdad-805880a3ecee',
        reason: 'ResourceBindingInvalid',
      }),
    ).toBe(true);
    expect(
      Value.Check(mandatePresentationProblemSchema, {
        type: 'https://devrandom.example/problems/mandate-presentation-rejected',
        title: 'Mandate presentation was rejected',
        status: 422,
        code: 'MandatePresentationRejected',
        correlationId: '4df838a8-5109-49fd-bdad-805880a3ecee',
        reason: 'PromotionWon',
      }),
    ).toBe(false);
  });
});
