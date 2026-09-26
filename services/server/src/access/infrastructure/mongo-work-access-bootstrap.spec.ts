import { describe, expect, it } from 'vitest';

import {
  decodeWorkAccessPolicyDocument,
  workAccessIndexDefinitions,
  workAccessPolicyDocument,
  workAccessPolicyDocumentFor,
} from './mongo-work-access-bootstrap.js';
import { workAccessPolicyForGrantLifetime } from '../domain/work-access-policy.js';

describe('Mongo Work Access bootstrap contract', () => {
  it('declares the exact named indexes that make idempotency, replay, capacity, and cleanup atomic', () => {
    expect(workAccessIndexDefinitions.map((definition) => definition.name)).toEqual([
      'work-access-command',
      'work-access-active-grant-secret',
      'work-access-expiry',
      'work-access-proof-response',
      'work-access-user-attempt-slot',
      'work-access-global-attempt-slot',
      'work-access-user-grant-slot',
    ]);
    expect(workAccessIndexDefinitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'work-access-command', unique: true }),
        expect.objectContaining({ name: 'work-access-expiry', expireAfterSeconds: 0 }),
        expect.objectContaining({ name: 'work-access-proof-response', unique: true }),
      ]),
    );
  });

  it('accepts only the exact compiled policy manifest', () => {
    expect(decodeWorkAccessPolicyDocument(workAccessPolicyDocument)).toEqual(
      workAccessPolicyDocument,
    );
    expect(() =>
      decodeWorkAccessPolicyDocument({
        ...workAccessPolicyDocument,
        fingerprint: `sha256:${'f'.repeat(64)}`,
      }),
    ).toThrow('WorkAccessPolicy has drifted');
  });

  it('manifests a configured lower grant lifetime under a distinct fingerprint', () => {
    const lowered = workAccessPolicyDocumentFor(workAccessPolicyForGrantLifetime(45));

    expect(lowered.fingerprint).not.toBe(workAccessPolicyDocument.fingerprint);
    expect(JSON.parse(lowered.canonicalPolicy)).toMatchObject({
      version: 'work-access-policy/1',
      grantLifetimeSeconds: 45,
      activeGrantsPerUserClient: 2,
      requestsPerGrant: 2_000,
    });
    expect(decodeWorkAccessPolicyDocument(lowered, lowered)).toEqual(lowered);
    expect(() => decodeWorkAccessPolicyDocument(lowered)).toThrow('WorkAccessPolicy has drifted');
  });
});
