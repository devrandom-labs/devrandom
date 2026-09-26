import Value from 'typebox/value';
import { describe, expect, it } from 'vitest';

import {
  createWorkAccessAttemptBodySchema,
  submitWorkAccessProofBodySchema,
  workAccessAttemptProjectionSchema,
  workAccessProblemSchema,
  workAccessRequestInvalidProblemSchema,
} from './work-access.js';

const createBody = {
  version: 1,
  commandId: '33333333-3333-4333-8333-333333333333',
  clientInstanceId: '22222222-2222-4222-8222-222222222222',
  userAid: 'EMstL6Th90iB6MpQkPjKN2ii7a5XcvA_PCHWHrAAD-l4',
  credentialSaid: 'EOiOyOhb0YSm2r84POPLVrHAwb1B81LZZH80gQGKjjho',
  grantSecretHash: `sha256:${'a'.repeat(64)}`,
} as const;

describe('Work Access HTTP contract', () => {
  it('accepts only the closed precommitted-secret attempt command', () => {
    expect(Value.Check(createWorkAccessAttemptBodySchema, createBody)).toBe(true);
    expect(
      Value.Check(createWorkAccessAttemptBodySchema, {
        ...createBody,
        ownerAid: createBody.userAid,
      }),
    ).toBe(false);
    expect(
      Value.Check(createWorkAccessAttemptBodySchema, {
        ...createBody,
        grantSecretHash: 'plaintext-secret',
      }),
    ).toBe(false);
  });

  it('keeps proof submission and attempt projections closed and state-specific', () => {
    expect(
      Value.Check(submitWorkAccessProofBodySchema, {
        version: 1,
        responseSaid: 'EAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      }),
    ).toBe(true);
    expect(
      Value.Check(workAccessAttemptProjectionSchema, {
        version: 1,
        kind: 'AwaitingProof',
        attemptId: '11111111-1111-4111-8111-111111111111',
        userAid: createBody.userAid,
        credentialSaid: createBody.credentialSaid,
        issuerRecipientAid: 'EHcQUn2xY9KN1yv6FP0c6-pxej14Z8JDD3IYLddg0wOh',
        clientInstanceId: createBody.clientInstanceId,
        commandId: createBody.commandId,
        grantSecretHash: createBody.grantSecretHash,
        challengeWords: Array.from({ length: 24 }, (_, index) => `word-${String(index + 1)}`),
        attemptExpiresAt: '2026-09-24T17:05:00.000Z',
      }),
    ).toBe(true);
  });

  it('uses closed RFC 9457 alternatives instead of an open error payload', () => {
    expect(
      Value.Check(workAccessRequestInvalidProblemSchema, {
        type: 'https://devrandom.example/problems/work-access-request-invalid',
        title: 'Work Access request is invalid',
        status: 400,
        code: 'WorkAccessRequestInvalid',
        correlationId: '44444444-4444-4444-8444-444444444444',
      }),
    ).toBe(true);
    expect(
      Value.Check(workAccessProblemSchema, {
        type: 'https://devrandom.example/problems/work-access-proof-rejected',
        title: 'Work Access proof was rejected',
        status: 403,
        code: 'WorkAccessProofRejected',
        correlationId: '44444444-4444-4444-8444-444444444444',
        reason: 'ChallengeProofInvalid',
      }),
    ).toBe(true);
    expect(
      Value.Check(workAccessProblemSchema, {
        type: 'https://devrandom.example/problems/work-access-grant-expired',
        title: 'Work Access Grant expired',
        status: 401,
        code: 'WorkAccessGrantExpired',
        correlationId: '44444444-4444-4444-8444-444444444444',
      }),
    ).toBe(true);
    expect(
      Value.Check(workAccessProblemSchema, {
        type: 'https://devrandom.example/problems/work-access-grant-revoked',
        title: 'Work Access Grant was revoked',
        status: 403,
        code: 'WorkAccessGrantRevoked',
        correlationId: '44444444-4444-4444-8444-444444444444',
        reason: 'SecurityIncident',
      }),
    ).toBe(true);
    expect(
      Value.Check(workAccessProblemSchema, {
        type: 'https://devrandom.example/problems/work-access-grant-scope-rejected',
        title: 'Work Access Grant scope was rejected',
        status: 403,
        code: 'WorkAccessGrantScopeRejected',
        correlationId: '44444444-4444-4444-8444-444444444444',
        requiredScope: 'task:create',
      }),
    ).toBe(true);
    expect(
      Value.Check(workAccessProblemSchema, {
        type: 'https://devrandom.example/problems/work-access-grant-exhausted',
        title: 'Work Access Grant request budget is exhausted',
        status: 429,
        code: 'WorkAccessGrantExhausted',
        correlationId: '44444444-4444-4444-8444-444444444444',
      }),
    ).toBe(true);
    expect(
      Value.Check(workAccessProblemSchema, {
        type: 'https://devrandom.example/problems/work-access-command-conflict',
        title: 'Work Access command conflict',
        status: 409,
        code: 'WorkAccessCommandConflict',
        correlationId: '44444444-4444-4444-8444-444444444444',
      }),
    ).toBe(true);
    expect(
      Value.Check(workAccessProblemSchema, {
        type: 'https://devrandom.example/problems/work-access-command-conflict',
        title: 'Work Access command conflict',
        status: 409,
        code: 'WorkAccessCommandConflict',
        correlationId: '44444444-4444-4444-8444-444444444444',
        metadata: {},
      }),
    ).toBe(false);
  });
});
