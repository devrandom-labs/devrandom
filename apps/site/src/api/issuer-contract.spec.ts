import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { generateIssuerEndpoints } from '../../openapi.config.ts';

describe('issuer browser contract', () => {
  it('matches the endpoints generated from the committed OpenAPI document', async () => {
    const generated = await generateIssuerEndpoints();
    const committed = await readFile(resolve(import.meta.dirname, 'issuer-endpoints.ts'), 'utf8');

    expect(committed).toBe(generated);
    expect(generated).toContain('useGetIssuerHealthQuery');
    expect(generated).toContain('useGetRegistrationApprovalQuery');
    expect(generated).not.toContain('useRenewRunLeaseMutation');
    expect(generated).not.toContain('useGetCredentialSchemaQuery');
    expect(generated).not.toMatch(/ApiResponse = unknown/u);
    expect(generated).not.toMatch(/\bany\b/u);
  });
});
