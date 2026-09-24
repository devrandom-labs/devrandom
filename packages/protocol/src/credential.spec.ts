import Value from 'typebox/value';
import { describe, expect, it } from 'vitest';

import { credentialSchema, credentialSchemaDocumentSchema } from './credential.js';

describe('credential schema HTTP document', () => {
  it('validates the exact generated credential schema document without an unknown contract', () => {
    const document: unknown = JSON.parse(JSON.stringify(credentialSchema));
    const wrongDocument: unknown = JSON.parse(
      JSON.stringify({ ...credentialSchema, credentialType: 'CallerSelectedCredential' }),
    );
    expect(Value.Check(credentialSchemaDocumentSchema, document)).toBe(true);
    expect(Value.Check(credentialSchemaDocumentSchema, wrongDocument)).toBe(false);
  });
});
