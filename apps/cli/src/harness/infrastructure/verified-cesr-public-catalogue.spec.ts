import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { VerifiedCesrPublicCatalogue } from './verified-cesr-public-catalogue.js';

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function checkedSource(fresh = false): { directory: string; commit: string; tree: string } {
  const directory = mkdtempSync(join(tmpdir(), 'devrandom-cesr-public-'));
  temporary.push(directory);
  cpSync(
    fresh
      ? resolve('fixtures/cesr-scoped-receipt-service')
      : new URL('./fixtures/cesr-public/', import.meta.url),
    directory,
    { recursive: true },
  );
  const git = (...arguments_: string[]) =>
    execFileSync('git', arguments_, {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Devrandom test');
  git('config', 'user.email', 'test@devrandom.invalid');
  git('add', '.');
  git('commit', '-qm', 'Freeze public CESR contract');
  return { directory, commit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}') };
}

it('reviews every disclosed CESR assertion against exact clean source before M', async () => {
  const source = checkedSource();
  const outcome = await new VerifiedCesrPublicCatalogue().review({
    sourceDirectory: source.directory,
    sourceGitCommit: source.commit,
    sourceGitTree: source.tree,
  });
  expect(outcome.kind).toBe('Reviewed');
  if (outcome.kind !== 'Reviewed') return;
  expect(outcome.publicConditions.map((condition) => condition.id)).toEqual([
    'cesr-current-direct-unmarked',
    'cesr-tamper-count-mismatch',
    'cesr-tamper-truncated-payload',
    'cesr-tamper-extra-bytes',
    'cesr-tamper-unsupported-version',
    'cesr-tamper-invalid-payload',
    'cesr-tamper-empty-group',
    'cesr-tamper-marker-without-payload',
    'cesr-tamper-malformed-first-group',
    'cesr-legacy-two-payloads-then-default',
    'cesr-legacy-partial-second-payload',
    'cesr-legacy-bad-group-count',
    'cesr-legacy-unsupported-marker',
    'cesr-legacy-invalid-second-payload',
  ]);
  expect(outcome.publicConditions[0]?.expected).toEqual({
    kind: 'Parsed',
    receipts: [
      { version: 'Current', payload: 'EABCDefghijk0123456789-_ABCDEFGHIJKLMNOPQRST' },
      { version: 'Current', payload: 'EABCDefghijk0123456789-_ABCDEFGHIJKLMNOPQRST' },
    ],
  });
  expect(outcome.publicConditions[9]?.expected).toEqual({
    kind: 'Parsed',
    receipts: [
      { version: 'Legacy', payload: 'EABCDefghijk0123456789-_ABCDEFGHIJKLMNOPQRST' },
      { version: 'Legacy', payload: 'EABCDefghijk0123456789-_ABCDEFGHIJKLMNOPQRSU' },
      { version: 'Current', payload: 'EABCDefghijk0123456789-_ABCDEFGHIJKLMNOPQRST' },
    ],
  });
});

it('refuses a dirty public test and a substituted Git tree', async () => {
  const source = checkedSource();
  const catalogue = new VerifiedCesrPublicCatalogue();
  expect(
    await catalogue.review({
      sourceDirectory: source.directory,
      sourceGitCommit: source.commit,
      sourceGitTree: '0'.repeat(40),
    }),
  ).toEqual({ kind: 'SourceMismatch' });
  writeFileSync(join(source.directory, 'tests', 'legacy_compatibility.rs'), 'forged');
  expect(
    await catalogue.review({
      sourceDirectory: source.directory,
      sourceGitCommit: source.commit,
      sourceGitTree: source.tree,
    }),
  ).toEqual({ kind: 'SourceMismatch' });
});

it('reviews the fresh disclosed contract independently and refuses a committed substitution', async () => {
  const source = checkedSource(true);
  const catalogue = new VerifiedCesrPublicCatalogue();
  const input = {
    sourceDirectory: source.directory,
    sourceGitCommit: source.commit,
    sourceGitTree: source.tree,
  };
  const reviewed = await catalogue.review(input);
  expect(reviewed.kind).toBe('Reviewed');
  if (reviewed.kind !== 'Reviewed') return;
  expect(reviewed.publicConditions.length).toBe(31);
  expect(
    reviewed.publicConditions.some((condition) => condition.id === 'cesr-scoped-large-boundary'),
  ).toBe(true);
  writeFileSync(join(source.directory, 'AGENTS.md'), 'A different hidden contract');
  execFileSync('git', ['add', 'AGENTS.md'], { cwd: source.directory });
  execFileSync('git', ['commit', '-qm', 'Substitute disclosed contract'], {
    cwd: source.directory,
  });
  expect(
    await catalogue.review({
      ...input,
      sourceGitCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: source.directory,
        encoding: 'utf8',
      }).trim(),
      sourceGitTree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
        cwd: source.directory,
        encoding: 'utf8',
      }).trim(),
    }),
  ).toEqual({ kind: 'SourceMismatch' });
});
