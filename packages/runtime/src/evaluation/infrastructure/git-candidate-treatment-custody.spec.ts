import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { GitCandidateTreatmentCustody } from './git-candidate-treatment-custody.js';

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function git(directory: string, ...args: string[]): Promise<string> {
  const output = await exec('git', ['-C', directory, ...args], { encoding: 'utf8' });
  return output.stdout.trim();
}

describe('exact candidate Git treatment read', () => {
  it('reads only a one-path child of H1 and rejects other ancestry or changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devrandom-c1-git-'));
    roots.push(root);
    await git(root, 'init');
    await writeFile(join(root, 'README.md'), 'H1\n');
    await git(root, 'add', 'README.md');
    await git(
      root,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-m',
      'H1',
    );
    const parentCommit = await git(root, 'rev-parse', 'HEAD');
    const parentTree = await git(root, 'rev-parse', 'HEAD^{tree}');
    await mkdir(join(root, '.devrandom/evolution'), { recursive: true });
    const bytes = Buffer.from(
      JSON.stringify({ version: 1, arm: 'C1', instructionText: 'reviewed' }),
    );
    await writeFile(join(root, '.devrandom/evolution/treatment.json'), bytes);
    await git(root, 'add', '.devrandom/evolution/treatment.json');
    await git(
      root,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-m',
      'C1',
    );
    const candidateCommit = await git(root, 'rev-parse', 'HEAD');
    const candidateTree = await git(root, 'rev-parse', 'HEAD^{tree}');
    const command = {
      repositoryDirectory: root,
      candidateCommit,
      candidateTree,
      parentCommit,
      parentTree,
      arm: 'C1' as const,
      signal: new AbortController().signal,
    };
    const custody = new GitCandidateTreatmentCustody();
    expect(await custody.read(command)).toEqual({ kind: 'Read', bytes: Uint8Array.from(bytes) });
    expect(await custody.read({ ...command, parentCommit: candidateCommit })).toEqual({
      kind: 'Denied',
    });
    expect(await custody.read({ ...command, candidateTree: 'e'.repeat(40) })).toEqual({
      kind: 'Denied',
    });
    await writeFile(join(root, 'README.md'), 'mutated task source\n');
    await git(root, 'add', 'README.md');
    await git(
      root,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-m',
      'extra change',
    );
    const changedCommit = await git(root, 'rev-parse', 'HEAD');
    const changedTree = await git(root, 'rev-parse', 'HEAD^{tree}');
    expect(
      await custody.read({
        ...command,
        candidateCommit: changedCommit,
        candidateTree: changedTree,
      }),
    ).toEqual({ kind: 'Denied' });
  });
});
