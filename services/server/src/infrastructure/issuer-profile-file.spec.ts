import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { issuerOobi } from '@devrandom/identity';

import { issuerProfileFixture } from '../../test/issuer-profile-fixture.js';
import { issuerProfilePath } from '../domain/issuer-configuration.js';
import { IssuerFailure } from '../domain/issuer-error.js';
import { readDevrandomIssuerProfile, recordDevrandomIssuerProfile } from './issuer-profile-file.js';

const temporaryDirectories: string[] = [];

async function temporaryProfilePath() {
  const directory = await mkdtemp(join(tmpdir(), 'devrandom-issuer-profile-'));
  temporaryDirectories.push(directory);
  return issuerProfilePath(join(directory, 'issuer-profile.json'));
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

describe('issuer profile file', () => {
  it('atomically records once and recognizes the identical profile', async () => {
    const path = await temporaryProfilePath();
    const profile = issuerProfileFixture();

    await expect(recordDevrandomIssuerProfile(path, profile)).resolves.toEqual({
      kind: 'issuer-profile-recorded',
    });
    await expect(recordDevrandomIssuerProfile(path, profile)).resolves.toEqual({
      kind: 'existing-issuer-profile',
    });
    await expect(readDevrandomIssuerProfile(path)).resolves.toEqual(profile);

    const entries = await readdir(join(path, '..'));
    expect(entries).toEqual(['issuer-profile.json']);
  });

  it('does not overwrite a different public identity', async () => {
    const path = await temporaryProfilePath();
    const profile = issuerProfileFixture();
    await recordDevrandomIssuerProfile(path, profile);

    const conflicting = {
      ...profile,
      issuerOobi: issuerOobi(profile.issuerOobi.replace('/agent/', '/controller/')),
    };

    await expect(recordDevrandomIssuerProfile(path, conflicting)).resolves.toEqual({
      kind: 'conflicting-issuer-profile',
      existing: profile,
    });
    await expect(readDevrandomIssuerProfile(path)).resolves.toEqual(profile);
  });

  it('rejects an unknown profile version', async () => {
    const path = await temporaryProfilePath();
    await writeFile(path, `${JSON.stringify({ ...issuerProfileFixture(), version: 2 })}\n`);

    await expect(readDevrandomIssuerProfile(path)).rejects.toBeInstanceOf(IssuerFailure);
  });

  it('never writes issuer secrets into the public document', async () => {
    const path = await temporaryProfilePath();
    await recordDevrandomIssuerProfile(path, issuerProfileFixture());

    const document = await readFile(path, 'utf8');
    expect(document).not.toContain('bran');
    expect(document).not.toContain('0123456789abcdefghijk');
  });
});
