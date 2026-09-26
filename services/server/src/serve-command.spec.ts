import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { credentialSchema, promotionMandateSchema, taskMandateSchema } from '@devrandom/protocol';

describe('devrandom-server serve command', () => {
  it('refuses to serve before the issuer has been bootstrapped', () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), 'devrandom-server-serve-'));

    try {
      const command = spawnSync(
        process.execPath,
        ['--import', 'tsx', resolve(import.meta.dirname, 'main.ts'), 'serve'],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            DEVRANDOM_ISSUER_BRAN: '0123456789abcdefghijk',
            DEVRANDOM_ISSUER_PROFILE_PATH: join(stateDirectory, 'issuer-profile.json'),
            DEVRANDOM_ISSUER_REGISTRY_POLICY: 'backerless',
            DEVRANDOM_ISSUER_WITNESS_POLICY: 'unwitnessed',
            DEVRANDOM_KERIA_ADMIN_URL: 'http://127.0.0.1:1',
            DEVRANDOM_KERIA_BOOT_URL: 'http://127.0.0.1:1',
            DEVRANDOM_MONGODB_URI: 'mongodb://127.0.0.1:1/devrandom',
            DEVRANDOM_REGISTRATION_SITE_URL: 'http://127.0.0.1:3210',
            DEVRANDOM_CREDENTIAL_SCHEMA_OOBI_URL: `http://server:3211/oobi/${credentialSchema.$id}`,
            DEVRANDOM_TASK_MANDATE_SCHEMA_OOBI_URL: `http://server:3211/oobi/${taskMandateSchema.$id}`,
            DEVRANDOM_PROMOTION_MANDATE_SCHEMA_OOBI_URL: `http://server:3211/oobi/${promotionMandateSchema.$id}`,
            DEVRANDOM_SIGNIFY_TIER: 'low',
            HOST: '127.0.0.1',
            PORT: '0',
          },
        },
      );

      expect(command.status).toBe(3);
      expect(command.stdout).toBe('');
      expect(command.stderr).toBe('Devrandom issuer has not been bootstrapped\n');
    } finally {
      rmSync(stateDirectory, { recursive: true });
    }
  });
});
