import { credentialSchema } from '@devrandom/protocol';
import { describe, expect, it } from 'vitest';

import { IdentityFailure } from './identity-error.js';
import { verifyCredentialSchemaEvidence } from './credential-schema.js';

describe('credential schema readiness evidence', () => {
  it('accepts the exact content-addressed credential schema', () => {
    expect(() => {
      verifyCredentialSchemaEvidence(credentialSchema, credentialSchema.$id);
    }).not.toThrow();
  });

  it('rejects modified schema content that retains the expected SAID', () => {
    expect(() => {
      verifyCredentialSchemaEvidence(
        { ...credentialSchema, title: 'Modified credential schema' },
        credentialSchema.$id,
      );
    }).toThrow('credential schema content is not bound by its SAID');
  });

  it.each([
    ['wrong SAID', { ...credentialSchema, $id: 'EOtherSchema' }],
    ['malformed document', { title: 'Missing content identifier' }],
  ])('rejects %s', (_label, evidence) => {
    expect(() => {
      verifyCredentialSchemaEvidence(evidence, credentialSchema.$id);
    }).toThrow(IdentityFailure);
  });
});
