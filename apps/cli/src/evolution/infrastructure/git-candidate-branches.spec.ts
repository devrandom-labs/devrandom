import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { prepareEvidenceArtifact } from '@devrandom/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { GitCandidateBranches } from './git-candidate-branches.js';

const run = promisify(execFile);
const said = (letter: string): string => `E${letter.repeat(43)}`;
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function git(directory: string, ...arguments_: string[]): Promise<string> {
  const result = await run('git', ['-C', directory, ...arguments_], { encoding: 'utf8' });
  return result.stdout.trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'devrandom-candidates-'));
  roots.push(root);
  const repositoryDirectory = join(root, 'repository');
  await git(root, 'init', repositoryDirectory);
  await writeFile(join(repositoryDirectory, 'README.md'), 'H1 source\n');
  await git(repositoryDirectory, 'add', 'README.md');
  await git(
    repositoryDirectory,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-m',
    'H1',
  );
  const commit = await git(repositoryDirectory, 'rev-parse', 'HEAD');
  const tree = await git(repositoryDirectory, 'rev-parse', 'HEAD^{tree}');
  function artifact(bytes: Uint8Array, mediaType: 'application/json' | 'application/octet-stream') {
    const prepared = prepareEvidenceArtifact(bytes, mediaType);
    if (prepared.kind !== 'Prepared') throw new Error('artifact fixture rejected');
    return { artifact: prepared.artifact, bytes };
  }
  const candidates = (['C1', 'C2', 'C3'] as const).map((arm) => ({
    arm,
    successorRevisionSaid: said(arm[1] ?? 'x'),
    configuration: artifact(
      new TextEncoder().encode(JSON.stringify({ version: 1, arm, treatment: `reviewed-${arm}` })),
      'application/json',
    ),
    ...(arm === 'C1'
      ? {}
      : {
          implementation: artifact(
            new TextEncoder().encode(`reviewed-${arm}`),
            'application/octet-stream',
          ),
        }),
  }));
  return {
    root,
    repositoryDirectory,
    commit,
    tree,
    input: {
      repositoryDirectory,
      stateRoot: join(root, 'state'),
      h1Repository: { objectFormat: 'sha1' as const, commit, tree },
      h0Said: said('h'),
      candidates,
      signal: new AbortController().signal,
    },
  };
}

describe('Git candidate branch custody', () => {
  it('commits three isolated siblings from exact H1 ancestry with only reviewed treatment paths', async () => {
    const ready = await fixture();
    const branched = await new GitCandidateBranches().branchSiblings(ready.input);
    expect(branched).toMatchObject({ kind: 'Branched' });
    if (branched.kind !== 'Branched') return;
    expect(branched.readiness).toBe('AwaitingRuntimeBinding');
    expect(branched.branches.map((branch) => branch.arm)).toEqual(['C1', 'C2', 'C3']);
    for (const branch of branched.branches) {
      expect(await git(branch.directory, 'rev-parse', 'HEAD^')).toBe(ready.commit);
      expect(await git(branch.directory, 'branch', '--show-current')).toBe(branch.branch);
      expect(await git(branch.directory, 'status', '--porcelain')).toBe('');
      const paths = (
        await git(branch.directory, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD')
      ).split('\n');
      expect(paths).toEqual(
        branch.arm === 'C1'
          ? ['.devrandom/evolution/treatment.json']
          : ['.devrandom/evolution/implementation.bin', '.devrandom/evolution/treatment.json'],
      );
      const expected = ready.input.candidates.find((candidate) => candidate.arm === branch.arm);
      expect(expected).toBeDefined();
      if (expected === undefined) return;
      expect(await readFile(join(branch.directory, '.devrandom/evolution/treatment.json'))).toEqual(
        Buffer.from(expected.configuration.bytes),
      );
      if (expected.implementation !== undefined)
        expect(
          await readFile(join(branch.directory, '.devrandom/evolution/implementation.bin')),
        ).toEqual(Buffer.from(expected.implementation.bytes));
    }
    const replay = await new GitCandidateBranches().branchSiblings(ready.input);
    expect(replay).toMatchObject({ kind: 'Reconciled', readiness: 'AwaitingRuntimeBinding' });
  });

  it('rejects changed reviewed bytes without creating branches', async () => {
    const ready = await fixture();
    await git(ready.repositoryDirectory, 'reset', '--hard', ready.commit);
    const wrong = structuredClone(ready.input);
    const first = wrong.candidates[0];
    if (first === undefined) throw new Error('fixture C1');
    first.configuration.bytes[0] = 0;
    expect(await new GitCandidateBranches().branchSiblings(wrong)).toMatchObject({
      kind: 'Blocked',
    });
    expect(await git(ready.repositoryDirectory, 'branch', '--list', 'devrandom/evolution/*')).toBe(
      '',
    );
  });

  it('rejects an H1 tree with a pre-existing treatment path or symlink ancestor', async () => {
    const occupied = await fixture();
    await mkdir(join(occupied.repositoryDirectory, '.devrandom/evolution'), { recursive: true });
    await writeFile(
      join(occupied.repositoryDirectory, '.devrandom/evolution/treatment.json'),
      'unreviewed',
    );
    await git(occupied.repositoryDirectory, 'add', '.devrandom/evolution/treatment.json');
    await git(
      occupied.repositoryDirectory,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-m',
      'Occupied H1',
    );
    const commit = await git(occupied.repositoryDirectory, 'rev-parse', 'HEAD');
    const tree = await git(occupied.repositoryDirectory, 'rev-parse', 'HEAD^{tree}');
    expect(
      await new GitCandidateBranches().branchSiblings({
        ...occupied.input,
        h1Repository: { objectFormat: 'sha1', commit, tree },
      }),
    ).toEqual({ kind: 'Blocked', reason: 'Repository' });
    expect(
      await git(occupied.repositoryDirectory, 'branch', '--list', 'devrandom/evolution/*'),
    ).toBe('');

    const linked = await fixture();
    await symlink('README.md', join(linked.repositoryDirectory, '.devrandom'));
    await git(linked.repositoryDirectory, 'add', '.devrandom');
    await git(
      linked.repositoryDirectory,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-m',
      'Linked H1',
    );
    const linkedCommit = await git(linked.repositoryDirectory, 'rev-parse', 'HEAD');
    const linkedTree = await git(linked.repositoryDirectory, 'rev-parse', 'HEAD^{tree}');
    expect(
      await new GitCandidateBranches().branchSiblings({
        ...linked.input,
        h1Repository: { objectFormat: 'sha1', commit: linkedCommit, tree: linkedTree },
      }),
    ).toEqual({ kind: 'Blocked', reason: 'Repository' });
  });
});
