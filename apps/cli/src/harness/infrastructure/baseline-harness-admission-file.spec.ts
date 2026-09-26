import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { baselineHarnessCommandFixture } from '../../../test/baseline-harness-fixture.js';
import { BaselineHarnessAdmissionFile } from './baseline-harness-admission-file.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function admissionFile() {
  const directory = await mkdtemp(join(tmpdir(), 'devrandom-h1-admission-'));
  directories.push(directory);
  return { directory, file: new BaselineHarnessAdmissionFile(directory) };
}

describe('baseline Harness admission file', () => {
  it('recovers one stable command identity and accepted H1 across fresh instances', async () => {
    const { directory, file } = await admissionFile();
    const command = baselineHarnessCommandFixture();
    const binding = {
      taskId: command.revision.task.taskId,
      taskRevisionSaid: command.revision.task.revisionSaid,
      harnessSaid: command.revision.d,
    };
    const first = await file.acquire(binding);
    expect(first).toMatchObject({ kind: 'Acquired' });
    if (first.kind !== 'Acquired') {
      throw new Error('admission identity fixture must be acquired');
    }
    const projection = {
      version: 1 as const,
      ownerAid: 'EMstL6Th90iB6MpQkPjKN2ii7a5XcvA_PCHWHrAAD-l4',
      commandId: first.commandId,
      acceptedAt: '2026-09-24T19:00:00.000Z',
      revision: command.revision,
    };

    await expect(file.acknowledge(binding, projection)).resolves.toEqual({
      kind: 'Acknowledged',
    });
    await expect(new BaselineHarnessAdmissionFile(directory).acquire(binding)).resolves.toEqual(
      first,
    );
    const path = join(directory, `${binding.taskId}.json`);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    expect(await readFile(path, 'utf8')).toContain(projection.acceptedAt);
  });

  it('rejects reuse of the Task slot for a different H1 binding', async () => {
    const { file } = await admissionFile();
    const command = baselineHarnessCommandFixture();
    const binding = {
      taskId: command.revision.task.taskId,
      taskRevisionSaid: command.revision.task.revisionSaid,
      harnessSaid: command.revision.d,
    };
    await expect(file.acquire(binding)).resolves.toMatchObject({ kind: 'Acquired' });

    await expect(
      file.acquire({ ...binding, harnessSaid: command.revision.authority.taskMandateSaid }),
    ).resolves.toEqual({ kind: 'BindingConflict' });
  });
});
