import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { prepareEvidenceArtifact } from '@devrandom/protocol';
import { expect, it } from 'vitest';

import { GitC2WorkflowTreatmentCustody } from './git-c2-workflow-treatment-custody.js';

const exec = promisify(execFile);
async function git(directory: string, ...args: string[]): Promise<string> {
  return (await exec('git', ['-C', directory, ...args], { encoding: 'utf8' })).stdout.trim();
}

it('reads only the two exact reviewed treatment blobs from a sibling Git commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devrandom-c2-git-'));
  try {
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
    const configurationBytes = Buffer.from('{"version":1,"arm":"C2"}');
    const implementationBytes = Buffer.from(
      '{"version":1,"kind":"RecoveryWorkflow","trigger":"QualifiedRetainedFailure","steps":["RetrieveExperience","ReadExactSource","Replan","FreshPublicVerify"]}',
    );
    const configuration = prepareEvidenceArtifact(configurationBytes, 'application/json');
    const implementation = prepareEvidenceArtifact(implementationBytes, 'application/octet-stream');
    expect(configuration.kind).toBe('Prepared');
    expect(implementation.kind).toBe('Prepared');
    if (configuration.kind !== 'Prepared' || implementation.kind !== 'Prepared') return;
    await mkdir(join(root, '.devrandom/evolution'), { recursive: true });
    await writeFile(join(root, '.devrandom/evolution/treatment.json'), configurationBytes);
    await writeFile(join(root, '.devrandom/evolution/implementation.bin'), implementationBytes);
    await git(
      root,
      'add',
      '.devrandom/evolution/treatment.json',
      '.devrandom/evolution/implementation.bin',
    );
    await git(
      root,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-m',
      'C2',
    );
    const candidateCommit = await git(root, 'rev-parse', 'HEAD');
    const candidateTree = await git(root, 'rev-parse', 'HEAD^{tree}');
    const input = {
      repositoryDirectory: root,
      parentCommit,
      parentTree,
      candidateCommit,
      candidateTree,
      configuration: configuration.artifact,
      implementation: implementation.artifact,
      signal: new AbortController().signal,
    };
    const custody = new GitC2WorkflowTreatmentCustody();
    const read = await custody.read(input);
    expect(read.kind).toBe('Read');
    if (read.kind === 'Read') {
      expect(Buffer.from(read.configurationBytes).equals(configurationBytes)).toBe(true);
      expect(Buffer.from(read.implementationBytes).equals(implementationBytes)).toBe(true);
    }
    expect(await custody.read({ ...input, candidateTree: parentTree })).toEqual({ kind: 'Denied' });
    expect(
      await custody.read({
        ...input,
        configuration: { ...configuration.artifact, d: implementation.artifact.d },
      }),
    ).toEqual({ kind: 'Denied' });
    expect(await custody.read({ ...input, parentCommit: candidateCommit })).toEqual({
      kind: 'Denied',
    });
    await git(root, 'checkout', '--detach', parentCommit);
    await mkdir(join(root, '.devrandom/evolution'), { recursive: true });
    await writeFile(join(root, '.devrandom/evolution/treatment.json'), configurationBytes);
    await writeFile(join(root, '.devrandom/evolution/implementation.bin'), implementationBytes);
    await writeFile(join(root, 'protected-evaluator.txt'), 'changed\n');
    await git(
      root,
      'add',
      '.devrandom/evolution/treatment.json',
      '.devrandom/evolution/implementation.bin',
      'protected-evaluator.txt',
    );
    await git(
      root,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-m',
      'C2 with protected change',
    );
    expect(
      await custody.read({
        ...input,
        candidateCommit: await git(root, 'rev-parse', 'HEAD'),
        candidateTree: await git(root, 'rev-parse', 'HEAD^{tree}'),
      }),
    ).toEqual({ kind: 'Denied' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
