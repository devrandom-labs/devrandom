import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { prepareEvidenceArtifact, type BaselineHarnessRevision } from '@devrandom/protocol';
import type { AuthorizedToolEffect, ToolGatewayProposal } from '@devrandom/runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  CapturedChildOutput,
  ExactChildCommands,
} from '../application/exact-child-command.js';
import type { SubmittedResultVerification } from '../application/public-task-verification.js';
import {
  type ManagedToolArtifacts,
  managedWorktreeCapabilities,
  ManagedWorktreeResources,
  ManagedWorktreeToolEffects,
} from './managed-worktree-tools.js';
import { EvidenceRecorderProcessOutput } from './process-output-evidence.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function proposal(input: ToolGatewayProposal['input']): ToolGatewayProposal {
  return {
    piSessionId: '46df3dc0-ff4f-4607-9c25-cad3b378e875',
    modelTurnId: 'turn-0',
    toolCallId: 'call-0',
    proposalIndex: 0,
    input,
  };
}

function harnessCommand(
  executableRealpath: string,
): BaselineHarnessRevision['completionCommands'][number] {
  return {
    identity: 'public-test',
    contentSaid: `E${'c'.repeat(43)}`,
    executableRealpath,
    argv: ['just', 'test-public'],
    timeoutSeconds: 120,
    expectedExitCode: 0,
  };
}

describe('managed worktree Tool Gateway adapters', () => {
  it('keeps public verifier sources readable but rejects their replacement before a tool effect', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devrandom-verifier-sources-'));
    roots.push(root);
    await mkdir(join(root, 'tests'));
    await mkdir(join(root, 'tests', 'vectors'));
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'Cargo.toml'), '[package]\nname = "fixture"\n');
    await writeFile(join(root, 'tests', 'legacy.rs'), '#[test] fn legacy() {}\n');
    await writeFile(join(root, 'tests', 'vectors', 'legacy.txt'), '-V1-public-vector\n');
    await writeFile(join(root, 'src', 'lib.rs'), 'pub fn receipt() {}\n');
    await symlink(join(root, 'tests', 'legacy.rs'), join(root, 'test-alias.rs'));
    const resources = new ManagedWorktreeResources({
      worktree: root,
      protectedPaths: ['secret.txt'],
      readOnlyPaths: [
        'Cargo.toml',
        'Cargo.lock',
        'AGENTS.md',
        'build.rs',
        '.cargo',
        'rust-toolchain',
        'rust-toolchain.toml',
        'tests',
      ],
      completionCommands: [],
      toolCommands: [],
    });
    for (const path of [
      'Cargo.toml',
      'Cargo.lock',
      'AGENTS.md',
      'build.rs',
      '.cargo/config.toml',
      'rust-toolchain.toml',
      'tests/legacy.rs',
      'tests/vectors/legacy.txt',
      'test-alias.rs',
    ]) {
      expect(
        resources.resolve(proposal({ kind: 'WriteFile', path, content: 'replacement' })),
      ).toEqual({
        kind: 'Denied',
        reason: 'PathEscape',
      });
    }
    expect(
      resources.resolve(
        proposal({
          kind: 'ReplaceText',
          path: 'tests/legacy.rs',
          oldText: 'legacy',
          newText: 'passing',
          expectedOccurrences: 1,
        }),
      ),
    ).toEqual({
      kind: 'Denied',
      reason: 'PathEscape',
    });
    for (const path of ['Cargo.toml', 'tests/legacy.rs', 'tests/vectors/legacy.txt']) {
      expect(resources.resolve(proposal({ kind: 'ReadFile', path }))).toEqual({
        kind: 'Resolved',
        resource: `repository://${path}`,
      });
    }
    expect(resources.resolve(proposal({ kind: 'ListFiles', path: 'tests' }))).toEqual({
      kind: 'Resolved',
      resource: 'repository://tests',
    });
    expect(resources.resolve(proposal({ kind: 'ReadFile', path: 'secret.txt' }))).toEqual({
      kind: 'Denied',
      reason: 'PathEscape',
    });
    expect(
      resources.resolve(proposal({ kind: 'WriteFile', path: 'src/lib.rs', content: 'repair' })),
    ).toEqual({
      kind: 'Resolved',
      resource: 'repository://src/lib.rs',
    });
  });

  it.each(['WriteFile', 'ReplaceText'] as const)(
    'rejects %s before filesystem mutation when aggregate admission fails',
    async (kind) => {
      const root = await mkdtemp(join(tmpdir(), 'devrandom-write-budget-'));
      roots.push(root);
      await writeFile(join(root, 'existing.txt'), 'before');
      const resources = new ManagedWorktreeResources({
        worktree: root,
        protectedPaths: [],
        completionCommands: [],
        toolCommands: [],
      });
      const admit = vi.fn(() => Promise.resolve({ kind: 'BudgetExhausted' as const }));
      const options = {
        resources,
        commands: { run: vi.fn() },
        artifacts: { storeArtifact: vi.fn() },
        processOutput: { record: vi.fn() },
        verification: { verify: vi.fn() },
        writeAdmission: { admit },
      };
      const effects = new ManagedWorktreeToolEffects(options);
      const proposed = proposal(
        kind === 'WriteFile'
          ? { kind, path: 'new/blocked.txt', content: 'after' }
          : {
              kind,
              path: 'existing.txt',
              oldText: 'before',
              newText: 'after',
              expectedOccurrences: 1,
            },
      );
      const resolution = resources.resolve(proposed);
      if (resolution.kind !== 'Resolved') throw new Error('write must resolve');
      await expect(
        effects.enact(
          {
            proposal: proposed,
            tool: kind === 'WriteFile' ? 'write_file' : 'replace_text',
            requiredCapability: 'EditRepository',
            resource: resolution.resource,
          },
          new AbortController().signal,
        ),
      ).resolves.toEqual({ kind: 'BudgetExhausted' });
      expect(await readFile(join(root, 'existing.txt'), 'utf8')).toBe('before');
      await expect(readFile(join(root, 'new'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(admit).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['ReadFile', 'ListFiles', 'SearchRepository'] as const)(
    'does not publish %s output after cancellation',
    async (kind) => {
      const root = await mkdtemp(join(tmpdir(), 'devrandom-tools-'));
      roots.push(root);
      await mkdir(join(root, 'src'));
      await writeFile(join(root, 'src', 'input.txt'), 'needle');
      const resources = new ManagedWorktreeResources({
        worktree: root,
        protectedPaths: [],
        completionCommands: [],
        toolCommands: [],
      });
      const storeArtifact = vi.fn<ManagedToolArtifacts['storeArtifact']>((input) => {
        const prepared = prepareEvidenceArtifact(input.bytes, input.mediaType);
        return prepared.kind === 'Prepared'
          ? { kind: 'Stored', artifact: prepared.artifact }
          : { kind: 'ArtifactRejected' };
      });
      const effects = new ManagedWorktreeToolEffects({
        writeAdmission: { admit: () => Promise.resolve({ kind: 'Admitted' }) },
        resources,
        commands: { run: vi.fn() },
        artifacts: { storeArtifact },
        processOutput: { record: vi.fn() },
        verification: { verify: vi.fn() },
      });
      const proposed = proposal(
        kind === 'ReadFile'
          ? { kind, path: 'src/input.txt' }
          : kind === 'ListFiles'
            ? { kind, path: 'src' }
            : { kind, path: 'src', query: 'needle' },
      );
      const resolution = resources.resolve(proposed);
      if (resolution.kind !== 'Resolved') throw new Error('read target must resolve');
      const abort = new AbortController();
      const outcome = effects.enact(
        {
          proposal: proposed,
          tool:
            kind === 'ReadFile'
              ? 'read_file'
              : kind === 'ListFiles'
                ? 'list_files'
                : 'search_repository',
          requiredCapability: 'ReadRepository',
          resource: resolution.resource,
        },
        abort.signal,
      );
      abort.abort();
      await expect(outcome).resolves.toMatchObject({
        kind: 'Failed',
        failure: 'EffectAborted',
        outputArtifactSaids: [],
      });
      expect(storeArtifact).not.toHaveBeenCalled();
    },
  );

  it.each(['WriteFile', 'ReplaceText'] as const)(
    'does not write after cancellation during %s preparation',
    async (kind) => {
      const root = await mkdtemp(join(tmpdir(), 'devrandom-tools-'));
      roots.push(root);
      await writeFile(join(root, 'input.txt'), 'original');
      const resources = new ManagedWorktreeResources({
        worktree: root,
        protectedPaths: [],
        completionCommands: [],
        toolCommands: [],
      });
      const effects = new ManagedWorktreeToolEffects({
        writeAdmission: { admit: () => Promise.resolve({ kind: 'Admitted' }) },
        resources,
        commands: { run: vi.fn() },
        artifacts: { storeArtifact: vi.fn() },
        processOutput: { record: vi.fn() },
        verification: { verify: vi.fn() },
      });
      const proposed = proposal(
        kind === 'WriteFile'
          ? { kind, path: 'input.txt', content: 'modified' }
          : {
              kind,
              path: 'input.txt',
              oldText: 'original',
              newText: 'modified',
              expectedOccurrences: 1,
            },
      );
      const resolution = resources.resolve(proposed);
      if (resolution.kind !== 'Resolved') throw new Error('edit must resolve');
      const abort = new AbortController();
      const outcome = effects.enact(
        {
          proposal: proposed,
          tool: kind === 'WriteFile' ? 'write_file' : 'replace_text',
          requiredCapability: 'EditRepository',
          resource: resolution.resource,
        },
        abort.signal,
      );
      abort.abort();
      await expect(outcome).resolves.toMatchObject({
        kind: 'Failed',
        failure: 'EffectAborted',
        outputArtifactSaids: [],
      });
      expect(await readFile(join(root, 'input.txt'), 'utf8')).toBe('original');
    },
  );

  it.each([5_000, 5_001])(
    'bounds directory traversal for %s empty directories',
    async (entries) => {
      const root = await mkdtemp(join(tmpdir(), 'devrandom-tools-'));
      roots.push(root);
      await mkdir(join(root, 'tree'));
      for (let index = 0; index < entries; index += 1) {
        await mkdir(join(root, 'tree', String(index)));
      }
      const resources = new ManagedWorktreeResources({
        worktree: root,
        protectedPaths: [],
        completionCommands: [],
        toolCommands: [],
      });
      const storeArtifact = vi.fn<ManagedToolArtifacts['storeArtifact']>((input) => {
        const prepared = prepareEvidenceArtifact(input.bytes, input.mediaType);
        return prepared.kind === 'Prepared'
          ? { kind: 'Stored', artifact: prepared.artifact }
          : { kind: 'ArtifactRejected' };
      });
      const effects = new ManagedWorktreeToolEffects({
        writeAdmission: { admit: () => Promise.resolve({ kind: 'Admitted' }) },
        resources,
        commands: { run: vi.fn() },
        artifacts: { storeArtifact },
        processOutput: { record: vi.fn() },
        verification: { verify: vi.fn() },
      });
      for (const input of [
        { kind: 'ListFiles', path: 'tree' },
        { kind: 'SearchRepository', path: 'tree', query: 'needle' },
      ] as const) {
        const proposed = proposal(input);
        const resolution = resources.resolve(proposed);
        if (resolution.kind !== 'Resolved') throw new Error('tree must resolve');
        const outcome = await effects.enact(
          {
            proposal: proposed,
            tool: input.kind === 'ListFiles' ? 'list_files' : 'search_repository',
            requiredCapability: 'ReadRepository',
            resource: resolution.resource,
          },
          new AbortController().signal,
        );
        expect(outcome).toMatchObject(
          entries === 5_000
            ? { kind: 'Completed' }
            : { kind: 'Failed', failure: 'OutputLimitExceeded' },
        );
      }
      expect(storeArtifact).toHaveBeenCalledTimes(entries === 5_000 ? 2 : 0);
    },
    20_000,
  );

  it.each([
    {
      original: 'a'.repeat(10_000),
      oldText: 'a',
      occurrences: 10_000,
      replacement: 'x'.repeat(512 * 1_024),
      disposition: 'Failed',
    },
    {
      original: 'aa',
      oldText: 'a',
      occurrences: 2,
      replacement: 'é'.repeat(128 * 1_024),
      disposition: 'Completed',
    },
    {
      original: 'aa',
      oldText: 'a',
      occurrences: 2,
      replacement: 'é'.repeat(128 * 1_024) + 'é',
      disposition: 'Failed',
    },
    {
      original: '😀'.repeat(4096) + 'z'.repeat(512 * 1024 - 4096 * 4),
      oldText: '\ud83d',
      occurrences: 4096,
      replacement: '\ud83d',
      disposition: 'Completed',
    },
  ] as const)(
    'bounds replacement expansion in UTF-8 bytes: $occurrences / $disposition',
    async ({ original, oldText, occurrences, replacement, disposition }) => {
      const root = await mkdtemp(join(tmpdir(), 'devrandom-tools-'));
      roots.push(root);
      await writeFile(join(root, 'input.txt'), original);
      const resources = new ManagedWorktreeResources({
        worktree: root,
        protectedPaths: [],
        completionCommands: [],
        toolCommands: [],
      });
      const effects = new ManagedWorktreeToolEffects({
        writeAdmission: { admit: () => Promise.resolve({ kind: 'Admitted' }) },
        resources,
        commands: { run: vi.fn() },
        artifacts: { storeArtifact: vi.fn() },
        processOutput: { record: vi.fn() },
        verification: { verify: vi.fn() },
      });
      const proposed = proposal({
        kind: 'ReplaceText',
        path: 'input.txt',
        oldText,
        newText: replacement,
        expectedOccurrences: occurrences,
      });
      const resolution = resources.resolve(proposed);
      if (resolution.kind !== 'Resolved') throw new Error('replacement must resolve');
      const outcome = await effects.enact(
        {
          proposal: proposed,
          tool: 'replace_text',
          requiredCapability: 'EditRepository',
          resource: resolution.resource,
        },
        new AbortController().signal,
      );
      expect(outcome).toMatchObject(
        disposition === 'Completed'
          ? { kind: 'Completed' }
          : { kind: 'Failed', failure: 'OutputLimitExceeded' },
      );
      expect(await readFile(join(root, 'input.txt'), 'utf8')).toBe(
        disposition === 'Completed' ? original.split(oldText).join(replacement) : original,
      );
    },
  );

  it.each([4096, 4097])(
    'bounds replacement input before a shrinking edit: %s blocks',
    async (blocks) => {
      const root = await mkdtemp(join(tmpdir(), 'devrandom-tools-'));
      roots.push(root);
      const oldText = 'x'.repeat(128);
      const original = oldText.repeat(blocks);
      await writeFile(join(root, 'input.txt'), original);
      const resources = new ManagedWorktreeResources({
        worktree: root,
        protectedPaths: [],
        completionCommands: [],
        toolCommands: [],
      });
      const storeArtifact = vi.fn<ManagedToolArtifacts['storeArtifact']>();
      const effects = new ManagedWorktreeToolEffects({
        writeAdmission: { admit: () => Promise.resolve({ kind: 'Admitted' }) },
        resources,
        commands: { run: vi.fn() },
        artifacts: { storeArtifact },
        processOutput: { record: vi.fn() },
        verification: { verify: vi.fn() },
      });
      const proposed = proposal({
        kind: 'ReplaceText',
        path: 'input.txt',
        oldText,
        newText: '',
        expectedOccurrences: blocks,
      });
      const resolution = resources.resolve(proposed);
      if (resolution.kind !== 'Resolved') throw new Error('replacement target must resolve');
      const outcome = await effects.enact(
        {
          proposal: proposed,
          tool: 'replace_text',
          requiredCapability: 'EditRepository',
          resource: resolution.resource,
        },
        new AbortController().signal,
      );
      expect(outcome).toMatchObject(
        blocks === 4096
          ? { kind: 'Completed' }
          : {
              kind: 'Failed',
              failure: 'OutputLimitExceeded',
            },
      );
      expect(await readFile(join(root, 'input.txt'), 'utf8')).toBe(blocks === 4096 ? '' : original);
      expect(storeArtifact).not.toHaveBeenCalled();
    },
  );

  it.each(['FileCount', 'FileBytes'] as const)(
    'rejects incomplete search evidence when the %s bound is exceeded',
    async (bound) => {
      const root = await mkdtemp(join(tmpdir(), 'devrandom-tools-'));
      roots.push(root);
      await mkdir(join(root, 'src'));
      if (bound === 'FileCount') {
        for (let index = 0; index < 502; index += 1) {
          await writeFile(
            join(root, 'src', `${String(index).padStart(3, '0')}.txt`),
            index === 501 ? 'needle' : 'ordinary',
          );
        }
      } else {
        await writeFile(join(root, 'src', 'large.txt'), 'x'.repeat(256 * 1_024) + 'needle');
      }
      const resources = new ManagedWorktreeResources({
        worktree: root,
        protectedPaths: [],
        completionCommands: [],
        toolCommands: [],
      });
      const storeArtifact = vi.fn<ManagedToolArtifacts['storeArtifact']>((input) => {
        const prepared = prepareEvidenceArtifact(input.bytes, input.mediaType);
        return prepared.kind === 'Prepared'
          ? { kind: 'Stored', artifact: prepared.artifact }
          : { kind: 'ArtifactRejected' };
      });
      const effects = new ManagedWorktreeToolEffects({
        writeAdmission: { admit: () => Promise.resolve({ kind: 'Admitted' }) },
        resources,
        commands: { run: vi.fn() },
        artifacts: { storeArtifact },
        processOutput: { record: vi.fn() },
        verification: { verify: vi.fn() },
      });
      const proposed = proposal({ kind: 'SearchRepository', path: 'src', query: 'needle' });
      const resolution = resources.resolve(proposed);
      if (resolution.kind !== 'Resolved') throw new Error('search target must resolve');
      const outcome = await effects.enact(
        {
          proposal: proposed,
          tool: 'search_repository',
          requiredCapability: 'ReadRepository',
          resource: resolution.resource,
        },
        new AbortController().signal,
      );
      expect(outcome).toMatchObject({ kind: 'Failed', failure: 'OutputLimitExceeded' });
      expect(storeArtifact).not.toHaveBeenCalled();
    },
  );

  it.each(['src', 'src/public.txt'])(
    'searches the authorized target %s and records exact matching lines',
    async (path) => {
      const root = await mkdtemp(join(tmpdir(), 'devrandom-tools-'));
      roots.push(root);
      await mkdir(join(root, 'src'));
      await writeFile(join(root, 'src', 'public.txt'), 'ordinary\nneedle public\n');
      const resources = new ManagedWorktreeResources({
        worktree: root,
        protectedPaths: [],
        completionCommands: [],
        toolCommands: [],
      });
      const persisted: string[] = [];
      const effects = new ManagedWorktreeToolEffects({
        writeAdmission: { admit: () => Promise.resolve({ kind: 'Admitted' }) },
        resources,
        commands: { run: vi.fn() },
        artifacts: {
          storeArtifact(input) {
            persisted.push(new TextDecoder().decode(input.bytes));
            const prepared = prepareEvidenceArtifact(input.bytes, input.mediaType);
            return prepared.kind === 'Prepared'
              ? { kind: 'Stored', artifact: prepared.artifact }
              : { kind: 'ArtifactRejected' };
          },
        },
        processOutput: { record: vi.fn() },
        verification: { verify: vi.fn() },
      });
      const proposed = proposal({ kind: 'SearchRepository', path, query: 'needle' });
      const resolution = resources.resolve(proposed);
      if (resolution.kind !== 'Resolved') throw new Error('search target must resolve');
      const outcome = await effects.enact(
        {
          proposal: proposed,
          tool: 'search_repository',
          requiredCapability: 'ReadRepository',
          resource: resolution.resource,
        },
        new AbortController().signal,
      );
      expect(outcome).toMatchObject({ kind: 'Completed' });
      expect(persisted).toEqual(['public.txt:2:needle public']);
    },
  );

  it('denies aliases that resolve to protected files or protected parent directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devrandom-tools-'));
    roots.push(root);
    await mkdir(join(root, 'private'));
    await writeFile(join(root, 'private', 'credential.txt'), 'must remain private');
    await symlink('private/credential.txt', join(root, 'alias.txt'));
    await symlink('private', join(root, 'alias-directory'));
    const resources = new ManagedWorktreeResources({
      worktree: root,
      protectedPaths: ['private'],
      completionCommands: [],
      toolCommands: [],
    });

    for (const input of [
      { kind: 'ReadFile', path: 'alias.txt' },
      { kind: 'WriteFile', path: 'alias-directory/new.txt', content: 'changed' },
      { kind: 'ListFiles', path: 'alias-directory' },
    ] as const) {
      expect(resources.resolve(proposal(input))).toEqual({ kind: 'Denied', reason: 'PathEscape' });
    }
  });

  it.each(['ListFiles', 'SearchRepository'] as const)(
    '%s excludes protected descendants before reading or persisting their content',
    async (kind) => {
      const root = await mkdtemp(join(tmpdir(), 'devrandom-tools-'));
      roots.push(root);
      await mkdir(join(root, 'src', 'private'), { recursive: true });
      await writeFile(join(root, 'src', 'public.txt'), 'needle public');
      await writeFile(join(root, 'src', 'private', 'credential.txt'), 'needle SECRET_SENTINEL');
      const resources = new ManagedWorktreeResources({
        worktree: root,
        protectedPaths: ['src/private'],
        completionCommands: [],
        toolCommands: [],
      });
      const persisted: string[] = [];
      const artifacts: ManagedToolArtifacts = {
        storeArtifact(input) {
          persisted.push(new TextDecoder().decode(input.bytes));
          const prepared = prepareEvidenceArtifact(input.bytes, input.mediaType);
          return prepared.kind === 'Prepared'
            ? { kind: 'Stored', artifact: prepared.artifact }
            : { kind: 'ArtifactRejected' };
        },
      };
      const effects = new ManagedWorktreeToolEffects({
        writeAdmission: { admit: () => Promise.resolve({ kind: 'Admitted' }) },
        resources,
        commands: { run: vi.fn() },
        artifacts,
        processOutput: { record: vi.fn() },
        verification: { verify: vi.fn() },
      });
      const proposed = proposal(
        kind === 'ListFiles' ? { kind, path: 'src' } : { kind, path: 'src', query: 'needle' },
      );
      const resolution = resources.resolve(proposed);
      if (resolution.kind !== 'Resolved') throw new Error('public parent must be accessible');
      const outcome = await effects.enact(
        {
          proposal: proposed,
          tool: kind === 'ListFiles' ? 'list_files' : 'search_repository',
          requiredCapability: 'ReadRepository',
          resource: resolution.resource,
        },
        new AbortController().signal,
      );

      expect(outcome).toMatchObject({ kind: 'Completed' });
      expect(JSON.stringify(outcome)).not.toContain('credential.txt');
      expect(persisted.join('\n')).not.toContain('SECRET_SENTINEL');
      expect(persisted.join('\n')).not.toContain('credential.txt');
      expect(persisted.join('\n')).toContain('public.txt');
    },
  );

  it('denies protected paths and final symlinks escaping the managed worktree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devrandom-tools-'));
    const outside = await mkdtemp(join(tmpdir(), 'devrandom-tools-outside-'));
    roots.push(root, outside);
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await symlink(join(outside, 'secret.txt'), join(root, 'escape.txt'));
    await symlink(join(outside, 'not-created.txt'), join(root, 'dangling.txt'));
    await symlink(join(outside, 'missing-directory'), join(root, 'dangling-directory'));
    const resources = new ManagedWorktreeResources({
      worktree: root,
      protectedPaths: ['secrets/local.json'],
      completionCommands: [],
      toolCommands: [],
    });

    expect(resources.resolve(proposal({ kind: 'ReadFile', path: 'escape.txt' }))).toEqual({
      kind: 'Denied',
      reason: 'PathEscape',
    });
    for (const path of ['dangling.txt', 'dangling-directory/new.txt']) {
      expect(
        resources.resolve(proposal({ kind: 'WriteFile', path, content: 'outside write' })),
      ).toEqual({ kind: 'Denied', reason: 'PathEscape' });
    }
    expect(
      resources.resolve(proposal({ kind: 'WriteFile', path: 'secrets/local.json', content: 'x' })),
    ).toEqual({ kind: 'Denied', reason: 'PathEscape' });
    expect(resources.resolve(proposal({ kind: 'ListFiles', path: '.git' }))).toEqual({
      kind: 'Denied',
      reason: 'PathEscape',
    });
  });

  it.each(
    (
      [
        'Completed',
        'BudgetCommitmentFailed',
        'BudgetExhausted',
        'SecretDetected',
        'OutboxBackpressure',
        'DependencyUnavailable',
        'EvidenceIntegrityFailure',
      ] as const
    ).flatMap((disposition) =>
      (['Distinct', 'Identical'] as const).flatMap((streams) =>
        (['RunTests', 'RunFormatter', 'RunStaticAnalysis'] as const).map((capability) => ({
          disposition,
          streams,
          capability,
        })),
      ),
    ),
  )(
    'retains $streams $capability output for $disposition through its committed realpath',
    async ({ disposition, streams, capability }) => {
      const root = await mkdtemp(join(tmpdir(), 'devrandom-tools-'));
      roots.push(root);
      await mkdir(join(root, 'src'));
      await writeFile(join(root, 'src', 'index.ts'), 'export const value = 1;\n');
      const executableRealpath = await realpath(process.execPath);
      const command = harnessCommand(executableRealpath);
      const resources = new ManagedWorktreeResources({
        worktree: root,
        protectedPaths: [],
        completionCommands: capability === 'RunTests' ? [command] : [],
        toolCommands: capability === 'RunTests' ? [] : [{ ...command, capability }],
      });
      const acknowledge = vi.fn<CapturedChildOutput['acknowledge']>(() =>
        Promise.resolve({ kind: 'Cleaned' }),
      );
      const execution = {
        kind: 'Completed' as const,
        exitCode: 0,
        terminationSignal: null,
        elapsedMilliseconds: 25,
        output: {
          disclosure: { kind: 'Recordable' as const },
          stdout: { path: join(root, 'stdout'), byteLength: streams === 'Identical' ? 0 : 3 },
          stderr: { path: join(root, 'stderr'), byteLength: 0 },
          acknowledge,
        },
      };
      const run = vi.fn<ExactChildCommands['run']>(() =>
        Promise.resolve(
          disposition === 'Completed'
            ? execution
            : disposition === 'BudgetCommitmentFailed'
              ? { ...execution, kind: 'BudgetCommitmentFailed', failure: 'BudgetExhausted' }
              : { kind: 'WorktreeReconciliationFailed', failure: disposition, execution },
        ),
      );
      const commands: ExactChildCommands = { run };
      await Promise.all([
        writeFile(join(root, 'stdout'), streams === 'Identical' ? '' : 'ok\n'),
        writeFile(join(root, 'stderr'), ''),
      ]);
      const artifacts: string[] = [];
      const artifactStore: ManagedToolArtifacts = {
        storeArtifact(input: {
          readonly bytes: Uint8Array;
          readonly mediaType:
            | 'application/octet-stream'
            | 'application/json'
            | 'text/plain; charset=utf-8'
            | 'text/x-diff; charset=utf-8';
        }) {
          const prepared = prepareEvidenceArtifact(input.bytes, input.mediaType);
          if (prepared.kind !== 'Prepared') return { kind: 'ArtifactRejected' };
          artifacts.push(new TextDecoder().decode(input.bytes));
          return { kind: 'Stored', artifact: prepared.artifact };
        },
      };
      const effects = new ManagedWorktreeToolEffects({
        writeAdmission: { admit: () => Promise.resolve({ kind: 'Admitted' }) },
        resources,
        commands,
        artifacts: artifactStore,
        processOutput: new EvidenceRecorderProcessOutput(
          { ...artifactStore, withhold: vi.fn() },
          () => '2026-09-24T20:00:03.000Z',
        ),
        verification: {
          verify: vi.fn<SubmittedResultVerification['verify']>(() =>
            Promise.resolve({ kind: 'Accepted', receipts: [], outputArtifactSaids: [] }),
          ),
        },
      });
      const effect: AuthorizedToolEffect = {
        proposal: proposal({ kind: capability, commandId: 'public-test' }),
        tool:
          capability === 'RunTests'
            ? 'run_tests'
            : capability === 'RunFormatter'
              ? 'run_formatter'
              : 'run_static_analysis',
        requiredCapability: capability,
        resource: `command://public-test@${command.contentSaid}`,
      };

      const outcome = await effects.enact(effect, new AbortController().signal);
      expect(outcome).toMatchObject(
        disposition === 'Completed'
          ? { kind: 'Completed' }
          : {
              kind: 'Failed',
              failure: disposition === 'BudgetCommitmentFailed' ? 'BudgetExhausted' : disposition,
            },
      );
      if (outcome.kind !== 'Completed' && outcome.kind !== 'Failed')
        throw new Error('command must retain its output references');
      if (disposition === 'Completed')
        expect(outcome.summary).toContain('Command public-test exited with code 0.');
      expect(outcome.summary).toContain('stdout [');
      expect(outcome.summary).toContain('stderr [');
      if (streams === 'Distinct') expect(outcome.summary).toContain('ok\n');
      expect(outcome.outputArtifactSaids).toHaveLength(streams === 'Identical' ? 1 : 2);
      for (const artifactSaid of outcome.outputArtifactSaids) {
        expect(artifactSaid).toMatch(/^E[A-Za-z0-9_-]{43}$/u);
      }
      expect(run).toHaveBeenCalledOnce();
      const invocation = run.mock.calls[0];
      if (invocation === undefined) throw new Error('managed command must run');
      expect(invocation[0]).toEqual({
        executableRealpath,
        arguments: ['test-public'],
        timeoutSeconds: 120,
        expectedExitCode: 0,
        budgetProducer: { kind: 'ToolGateway' },
      });
      expect(invocation[1]).toBeInstanceOf(AbortSignal);
      expect(artifacts).toEqual([streams === 'Identical' ? '' : 'ok\n', '']);
      expect(acknowledge).toHaveBeenCalledOnce();
      expect(await readFile(join(root, 'src', 'index.ts'), 'utf8')).toBe(
        'export const value = 1;\n',
      );
    },
  );

  it('advertises the declared command capabilities implemented by the runtime', () => {
    expect(managedWorktreeCapabilities).toContain('RunFormatter');
    expect(managedWorktreeCapabilities).toContain('RunStaticAnalysis');
  });

  it('resolves only the matching command capability and rejects substituted bindings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devrandom-command-roles-'));
    roots.push(root);
    const command = harnessCommand(await realpath(process.execPath));
    const declarations = [
      { ...command, identity: 'format', capability: 'RunFormatter' as const },
      { ...command, identity: 'analyze', capability: 'RunStaticAnalysis' as const },
    ];
    const resources = new ManagedWorktreeResources({
      worktree: root,
      protectedPaths: [],
      completionCommands: [command],
      toolCommands: declarations,
    });
    for (const binding of [{ ...command, capability: 'RunTests' as const }, ...declarations]) {
      for (const kind of ['RunTests', 'RunFormatter', 'RunStaticAnalysis'] as const) {
        const proposed = proposal({ kind, commandId: binding.identity });
        const resource = `command://${binding.identity}@${binding.contentSaid}`;
        expect(resources.resolve(proposed)).toEqual(
          kind === binding.capability
            ? { kind: 'Resolved', resource }
            : { kind: 'Denied', reason: 'ArgumentsInvalid' },
        );
        const effect = {
          proposal: proposed,
          tool:
            kind === 'RunTests'
              ? ('run_tests' as const)
              : kind === 'RunFormatter'
                ? ('run_formatter' as const)
                : ('run_static_analysis' as const),
          requiredCapability: kind,
          resource,
        };
        expect(resources.commandFor(effect)).toEqual(
          kind === binding.capability
            ? expect.objectContaining({
                identity: binding.identity,
                argv: binding.argv,
                contentSaid: binding.contentSaid,
              })
            : undefined,
        );
        expect(
          resources.commandFor({ ...effect, resource: `${resource}-changed` }),
        ).toBeUndefined();
      }
    }
  });

  it('preserves rejected verification as a nonterminal submission disposition', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devrandom-tools-'));
    roots.push(root);
    const resources = new ManagedWorktreeResources({
      worktree: root,
      protectedPaths: [],
      completionCommands: [],
      toolCommands: [],
    });
    const verify = vi.fn<SubmittedResultVerification['verify']>(() =>
      Promise.resolve({
        kind: 'Rejected',
        feedback: 'public-test: expected 3, received 4',
        receipts: [],
        outputArtifactSaids: [`E${'x'.repeat(43)}`, `E${'y'.repeat(43)}`],
      }),
    );
    const effects = new ManagedWorktreeToolEffects({
      writeAdmission: { admit: () => Promise.resolve({ kind: 'Admitted' }) },
      resources,
      commands: { run: vi.fn() },
      artifacts: {
        storeArtifact: vi.fn<ManagedToolArtifacts['storeArtifact']>(() => ({
          kind: 'ArtifactRejected',
        })),
      },
      processOutput: { record: vi.fn() },
      verification: { verify },
    });
    const submission = proposal({ kind: 'SubmitResult', artifactSaids: [`E${'a'.repeat(43)}`] });
    const resolution = resources.resolve(submission);
    expect(resolution.kind).toBe('Resolved');
    if (resolution.kind !== 'Resolved') return;
    const effect: AuthorizedToolEffect = {
      proposal: submission,
      tool: 'submit_result',
      requiredCapability: 'SubmitResult',
      resource: resolution.resource,
    };
    const signal = new AbortController().signal;

    await expect(effects.enact(effect, signal)).resolves.toEqual({
      kind: 'SubmissionVerified',
      disposition: 'Rejected',
      summary:
        'Public Task verification rejected the submitted result.\npublic-test: expected 3, received 4',
      outputArtifactSaids: [`E${'x'.repeat(43)}`, `E${'y'.repeat(43)}`],
    });
    expect(verify).toHaveBeenCalledExactlyOnceWith(
      { artifactSaids: [`E${'a'.repeat(43)}`] },
      signal,
    );
  });

  it('returns actionable feedback for an unavailable artifact and permits a corrected submission', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devrandom-tools-'));
    roots.push(root);
    const resources = new ManagedWorktreeResources({
      worktree: root,
      protectedPaths: [],
      completionCommands: [],
      toolCommands: [],
    });
    const verify = vi
      .fn<SubmittedResultVerification['verify']>()
      .mockResolvedValueOnce({ kind: 'ArtifactUnavailable' })
      .mockResolvedValueOnce({ kind: 'Accepted', receipts: [], outputArtifactSaids: [] });
    const effects = new ManagedWorktreeToolEffects({
      writeAdmission: { admit: () => Promise.resolve({ kind: 'Admitted' }) },
      resources,
      commands: { run: vi.fn() },
      artifacts: { storeArtifact: vi.fn() },
      processOutput: { record: vi.fn() },
      verification: { verify },
    });
    const first = proposal({ kind: 'SubmitResult', artifactSaids: [`E${'z'.repeat(43)}`] });
    const firstResolution = resources.resolve(first);
    if (firstResolution.kind !== 'Resolved') throw new Error('submission must resolve');
    const firstEffect: AuthorizedToolEffect = {
      proposal: first,
      tool: 'submit_result',
      requiredCapability: 'SubmitResult',
      resource: firstResolution.resource,
    };
    const signal = new AbortController().signal;
    await expect(effects.enact(firstEffect, signal)).resolves.toEqual({
      kind: 'Failed',
      failure: 'ArtifactUnavailable',
      summary:
        'A submitted artifact is unavailable locally; use a retained artifact SAID or submit an empty list.',
      outputArtifactSaids: [],
    });
    const retry = proposal({ kind: 'SubmitResult', artifactSaids: [] });
    const retryResolution = resources.resolve(retry);
    if (retryResolution.kind !== 'Resolved') throw new Error('retry must resolve');
    await expect(
      effects.enact(
        { ...firstEffect, proposal: retry, resource: retryResolution.resource },
        signal,
      ),
    ).resolves.toEqual({
      kind: 'SubmissionVerified',
      disposition: 'Accepted',
      summary: 'Public Task verification accepted the submitted result.',
      outputArtifactSaids: [],
    });
    expect(verify).toHaveBeenCalledTimes(2);
  });
});
