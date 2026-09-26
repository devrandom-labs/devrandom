import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  clientInstanceId,
  type ClientBoundUserProfile,
  type UserProfile,
} from '../domain/user-profile.js';
import { IdentityFileFailure, IdentityFiles } from './identity-files.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function identityFiles(): Promise<{
  readonly directory: string;
  readonly files: IdentityFiles;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'devrandom-user-'));
  directories.push(directory);
  return { directory, files: new IdentityFiles(directory) };
}

function profile(revision: number): UserProfile {
  return {
    version: 1,
    revision,
    alias: 'devrandom-user',
    controllerAid: 'EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk',
    keriaAgentAid: 'EJlw5Fw9LKH1CYFEkGiDUlx0cHozvXb7hfqhSoMsH6bs',
    userAid: 'EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz',
    userAgentOobi:
      'http://keria.test/oobi/EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz/agent/EJlw5Fw9LKH1CYFEkGiDUlx0cHozvXb7hfqhSoMsH6bs',
    witnessPolicy: {
      witnessAids: ['BBilc4-L3tFUnfM_wJr4S4OJanAv_VmF_dJNN6vkf2Ha'],
      threshold: 1,
    },
    receiptEvidence: {
      kelSequence: 0,
      currentEventSaid: 'EBfdlu8R27Fbx-ehrqwImnK-8Cm79sqbAQ4MmvEAYqao',
      receiptIndexes: [0],
    },
    issuer: {
      aid: 'EOb-FtVoyOOKTAf9GVdIlmfiSL53StlAY8vobkPRdmt4',
      oobi: 'http://keria.test/oobi/EOb-FtVoyOOKTAf9GVdIlmfiSL53StlAY8vobkPRdmt4/agent/ELSG3CytxWcqG5gYBFcr9_6-cG3j08iC7o21ctXUqSoU',
      registryId: 'EJ6aiZ1xOnnCKGKhOn9LEit6k5eolN26_mB9P_YD0Jfs',
      schemaSaid: 'EH0pPEOR9SgXnsMmTJX12mh_H7WMRZxcM9h12GdZRvCQ',
    },
    provenance: { kind: 'live' },
    custodyReference: 'signify-bran-v1',
  };
}

function clientBoundProfile(revision: number, id: string): ClientBoundUserProfile {
  return {
    ...profile(revision),
    version: 2,
    clientInstanceId: clientInstanceId(id),
  };
}

describe('local identity files', () => {
  it('creates custody once with owner-only permissions and never places it in the profile', async () => {
    const { directory, files } = await identityFiles();
    await files.createCustody({ version: 1, bran: '0123456789abcdefghijk' });
    await expect(
      files.createCustody({ version: 1, bran: 'zyxwvutsrqponmlkjihgf' }),
    ).rejects.toBeInstanceOf(IdentityFileFailure);
    await files.commitProfile(undefined, profile(0));

    expect((await lstat(join(directory, 'signify-custody.json'))).mode & 0o777).toBe(0o600);
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    expect(await readFile(join(directory, 'user-profile.json'), 'utf8')).not.toContain(
      '0123456789abcdefghijk',
    );
  });

  it('commits profiles only at the expected revision', async () => {
    const { files } = await identityFiles();
    await files.commitProfile(undefined, profile(0));
    await expect(files.commitProfile(undefined, profile(0))).rejects.toMatchObject({
      detail: { kind: 'identity-file-conflict', file: 'profile' },
    });
    await files.commitProfile(0, profile(1));
    await expect(files.readProfile()).resolves.toEqual(profile(1));
  });

  it('reads legacy profiles and persists one closed client-bound profile version', async () => {
    const { files } = await identityFiles();
    const legacy = profile(0);
    const current = clientBoundProfile(1, '123e4567-e89b-42d3-a456-426614174000');

    await files.commitProfile(undefined, legacy);
    await expect(files.readProfile()).resolves.toEqual(legacy);
    await files.commitProfile(0, current);
    await expect(files.readProfile()).resolves.toEqual(current);
  });

  it.each([
    ['uppercase UUID', '123E4567-E89B-42D3-A456-426614174000'],
    ['non-v4 UUID', '123e4567-e89b-12d3-a456-426614174000'],
  ])('rejects a client-bound profile with an invalid %s', async (_description, invalidId) => {
    const { directory, files } = await identityFiles();
    await writeFile(
      join(directory, 'user-profile.json'),
      `${JSON.stringify({ ...profile(0), version: 2, clientInstanceId: invalidId })}\n`,
      { mode: 0o600 },
    );

    await expect(files.readProfile()).rejects.toMatchObject({
      detail: { kind: 'identity-file-invalid', file: 'profile' },
    });
  });

  it('rejects secret material added to the closed client-bound profile', async () => {
    const { directory, files } = await identityFiles();
    await writeFile(
      join(directory, 'user-profile.json'),
      `${JSON.stringify({
        ...clientBoundProfile(0, '123e4567-e89b-42d3-a456-426614174000'),
        grantSecret: 'must-never-persist',
      })}\n`,
      { mode: 0o600 },
    );

    await expect(files.readProfile()).rejects.toMatchObject({
      detail: { kind: 'identity-file-invalid', file: 'profile' },
    });
  });

  it('atomically preserves the first durable Registration Session creation key', async () => {
    const { directory, files } = await identityFiles();
    const first = {
      version: 1 as const,
      kind: 'registration-create-pending' as const,
      creationKey: `registration_${'r'.repeat(43)}`,
    };
    const competing = {
      version: 1 as const,
      kind: 'registration-create-pending' as const,
      creationKey: `registration_${'s'.repeat(43)}`,
    };

    await expect(files.claimRegistrationCreation(first)).resolves.toEqual(first);
    await expect(files.claimRegistrationCreation(competing)).resolves.toEqual(first);
    await expect(files.readRegistrationSecrets()).resolves.toEqual(first);
    expect((await lstat(join(directory, 'registration-secrets.json'))).mode & 0o777).toBe(0o600);
  });

  it('rejects malformed and symlinked custody instead of classifying it as absent', async () => {
    const { directory, files } = await identityFiles();
    const target = join(directory, 'target');
    await writeFile(target, '{"version":1}', { mode: 0o600 });
    await symlink(target, join(directory, 'signify-custody.json'));

    await expect(files.readCustody()).rejects.toMatchObject({
      detail: { kind: 'identity-file-insecure', file: 'custody' },
    });
  });
});
