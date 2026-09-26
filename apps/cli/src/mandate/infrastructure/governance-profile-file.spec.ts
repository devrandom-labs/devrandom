import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  agentAid,
  controllerAid,
  credentialRegistryId,
  governorAid,
  personalAgentAid,
  userAid,
} from '@devrandom/identity';
import { afterEach, describe, expect, it } from 'vitest';

import type { LocalGovernanceProfile } from '../domain/local-governance.js';
import { GovernanceProfileFile, GovernanceProfileFileFailure } from './governance-profile-file.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function governanceFile(): Promise<{
  readonly directory: string;
  readonly file: GovernanceProfileFile;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'devrandom-governance-'));
  directories.push(directory);
  return { directory, file: new GovernanceProfileFile(directory) };
}

function profile(revision: number): LocalGovernanceProfile {
  return {
    version: 1,
    revision,
    userAid: userAid('EMstL6Th90iB6MpQkPjKN2ii7a5XcvA_PCHWHrAAD-l4'),
    controllerAid: controllerAid('EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk'),
    keriaAgentAid: agentAid('EJlw5Fw9LKH1CYFEkGiDUlx0cHozvXb7hfqhSoMsH6bs'),
    personalAgentAid: personalAgentAid('EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz'),
    governorAid: governorAid('EHcQUn2xY9KN1yv6FP0c6-pxej14Z8JDD3IYLddg0wOh'),
    mandateRegistryId: credentialRegistryId('EBdHrbtS_iH9Oe9IH-3UDsHYNuWpwrtnkDzO5fKrITyK'),
  };
}

describe('local governance profile file', () => {
  it('commits one secret-free profile at the expected revision with owner-only permissions', async () => {
    const { directory, file } = await governanceFile();

    await file.commit(undefined, profile(0));
    await file.commit(0, profile(1));

    await expect(file.read()).resolves.toEqual(profile(1));
    expect((await lstat(join(directory, 'local-governance.json'))).mode & 0o777).toBe(0o600);
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    expect(await readFile(join(directory, 'local-governance.json'), 'utf8')).not.toContain('bran');
  });

  it('rejects a competing revision instead of replacing durable principal expectations', async () => {
    const { file } = await governanceFile();
    await file.commit(undefined, profile(0));

    await expect(file.commit(undefined, profile(0))).rejects.toMatchObject({
      detail: { kind: 'GovernanceProfileConflict' },
    });
  });

  it('rejects an aliasing principal and added private material at the file boundary', async () => {
    const { directory, file } = await governanceFile();
    const valid = profile(0);
    await writeFile(
      join(directory, 'local-governance.json'),
      `${JSON.stringify({
        ...valid,
        governorAid: valid.personalAgentAid,
        bran: 'must-never-persist',
      })}\n`,
      { mode: 0o600 },
    );

    await expect(file.read()).rejects.toBeInstanceOf(GovernanceProfileFileFailure);
    await expect(file.read()).rejects.toMatchObject({
      detail: { kind: 'GovernanceProfileInvalid' },
    });
  });
});
