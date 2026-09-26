import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { promotionMandateSchema, taskMandateSchema } from '@devrandom/protocol';

describe('devrandom-server bootstrap command', () => {
  it('rejects missing bootstrap configuration through the real process boundary', () => {
    const command = spawnSync(
      process.execPath,
      ['--import', 'tsx', resolve(import.meta.dirname, 'main.ts'), 'bootstrap'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          DEVRANDOM_ISSUER_BRAN: '',
          PORT: 'not-a-port',
        },
      },
    );

    expect(command.status).toBe(2);
    expect(command.stdout).toBe('');
    expect(command.stderr).toContain('DEVRANDOM_ISSUER_BRAN');
    expect(command.stderr).not.toContain('0123456789abcdefghijk');
  });

  it('requires the separate hosted-work storage binding before changing live state', () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), 'devrandom-server-bootstrap-'));

    try {
      const command = spawnSync(
        process.execPath,
        ['--import', 'tsx', resolve(import.meta.dirname, 'main.ts'), 'bootstrap'],
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
            DEVRANDOM_SIGNIFY_TIER: 'low',
            DEVRANDOM_MONGODB_URI: 'mongodb://127.0.0.1:1/devrandom?replicaSet=devrandom-rs',
            DEVRANDOM_REGISTRATION_SITE_URL: 'http://127.0.0.1:3210',
            DEVRANDOM_CREDENTIAL_SCHEMA_OOBI_URL:
              'http://127.0.0.1:3211/oobi/EOb-FtVoyOOKTAf9GVdIlmfiSL53StlAY8vobkPRdmt4',
            DEVRANDOM_TASK_MANDATE_SCHEMA_OOBI_URL: `http://127.0.0.1:3211/oobi/${taskMandateSchema.$id}`,
            DEVRANDOM_PROMOTION_MANDATE_SCHEMA_OOBI_URL: `http://127.0.0.1:3211/oobi/${promotionMandateSchema.$id}`,
            DEVRANDOM_HOSTED_WORK_MONGODB_URI: '',
          },
        },
      );

      expect(command.status).toBe(2);
      expect(command.stdout).toBe('');
      expect(command.stderr).toBe('DEVRANDOM_HOSTED_WORK_MONGODB_URI is required\n');
    } finally {
      rmSync(stateDirectory, { recursive: true });
    }
  });
});
