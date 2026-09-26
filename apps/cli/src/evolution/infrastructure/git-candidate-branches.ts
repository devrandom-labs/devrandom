import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

import { decodeEvidenceArtifact } from '@devrandom/protocol';

import type {
  CandidateArm,
  CandidateBranchCommand,
  CandidateBranchCustody,
  CandidateBranchDisposition,
  CandidateBranchReceipt,
  ReviewedCandidateTreatment,
} from '../application/candidate-branch-custody.js';

const exec = promisify(execFile);
const said = /^[A-Z][A-Za-z0-9_-]{43}$/u;
const sha1 = /^[a-f0-9]{40}$/u;
const sha256 = /^[a-f0-9]{64}$/u;
const arms: readonly CandidateArm[] = ['C1', 'C2', 'C3'];
const treatmentPath = '.devrandom/evolution/treatment.json';
const implementationPath = '.devrandom/evolution/implementation.bin';

type GitReading = { readonly kind: 'Read'; readonly value: string } | { readonly kind: 'Failed' };
type ExistingPath = 'Missing' | 'Directory' | 'Conflict';

async function git(
  directory: string,
  arguments_: readonly string[],
  signal: AbortSignal,
): Promise<GitReading> {
  try {
    const result = await exec('git', ['-C', directory, ...arguments_], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      signal,
      timeout: 30_000,
    });
    return { kind: 'Read', value: result.stdout.trim() };
  } catch {
    return { kind: 'Failed' };
  }
}

async function existingPath(path: string): Promise<ExistingPath> {
  try {
    const entry = await lstat(path);
    return entry.isDirectory() && !entry.isSymbolicLink() ? 'Directory' : 'Conflict';
  } catch {
    return 'Missing';
  }
}

function validArtifact(treatment: ReviewedCandidateTreatment): boolean {
  const config = treatment.configuration;
  if (
    config.artifact.mediaType !== 'application/json' ||
    config.bytes.byteLength === 0 ||
    config.bytes.byteLength > 32 * 1024 ||
    decodeEvidenceArtifact(config.artifact, config.bytes).kind !== 'Accepted'
  )
    return false;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(config.bytes);
    const parsed: unknown = JSON.parse(text);
    if (
      JSON.stringify(parsed) !== text ||
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      !('version' in parsed) ||
      parsed.version !== 1 ||
      !('arm' in parsed) ||
      parsed.arm !== treatment.arm ||
      [
        'authority',
        'activeTools',
        'modelCompatibility',
        'budgetCeilings',
        'toolGateway',
        'verifier',
        'winner',
        'score',
      ].some((field) => field in parsed)
    )
      return false;
  } catch {
    return false;
  }
  if (treatment.arm === 'C1') return treatment.implementation === undefined;
  const implementation = treatment.implementation;
  return (
    implementation !== undefined &&
    implementation.artifact.mediaType === 'application/octet-stream' &&
    implementation.bytes.byteLength > 0 &&
    implementation.bytes.byteLength <= 128 * 1024 &&
    decodeEvidenceArtifact(implementation.artifact, implementation.bytes).kind === 'Accepted'
  );
}

function validCommand(command: CandidateBranchCommand): boolean {
  const hash = command.h1Repository.objectFormat === 'sha1' ? sha1 : sha256;
  return (
    isAbsolute(command.repositoryDirectory) &&
    isAbsolute(command.stateRoot) &&
    said.test(command.h0Said) &&
    hash.test(command.h1Repository.commit) &&
    hash.test(command.h1Repository.tree) &&
    command.candidates.length === 3 &&
    command.candidates.every(
      (candidate, position) =>
        candidate.arm === arms[position] &&
        said.test(candidate.successorRevisionSaid) &&
        validArtifact(candidate),
    ) &&
    new Set(command.candidates.map((candidate) => candidate.successorRevisionSaid)).size === 3
  );
}

function branchName(command: CandidateBranchCommand, arm: CandidateArm): string {
  return `devrandom/evolution/${command.h0Said}/${arm}`;
}

function worktreePath(command: CandidateBranchCommand, arm: CandidateArm): string {
  return join(command.stateRoot, 'evolution', command.h0Said, arm);
}

function pathsFor(candidate: ReviewedCandidateTreatment): readonly string[] {
  return candidate.arm === 'C1' ? [treatmentPath] : [implementationPath, treatmentPath];
}

async function repositoryMatches(command: CandidateBranchCommand): Promise<boolean> {
  const [top, format, commit, tree, treatmentBase, implementationBase, treatmentAncestor] =
    await Promise.all([
      git(command.repositoryDirectory, ['rev-parse', '--show-toplevel'], command.signal),
      git(command.repositoryDirectory, ['rev-parse', '--show-object-format'], command.signal),
      git(
        command.repositoryDirectory,
        ['rev-parse', `${command.h1Repository.commit}^{commit}`],
        command.signal,
      ),
      git(
        command.repositoryDirectory,
        ['rev-parse', `${command.h1Repository.commit}^{tree}`],
        command.signal,
      ),
      git(
        command.repositoryDirectory,
        ['ls-tree', '--name-only', command.h1Repository.commit, '--', treatmentPath],
        command.signal,
      ),
      git(
        command.repositoryDirectory,
        ['ls-tree', '--name-only', command.h1Repository.commit, '--', implementationPath],
        command.signal,
      ),
      git(
        command.repositoryDirectory,
        ['ls-tree', command.h1Repository.commit, '--', '.devrandom'],
        command.signal,
      ),
    ]);
  if (
    [top, format, commit, tree, treatmentBase, implementationBase, treatmentAncestor].some(
      (item) => item.kind !== 'Read',
    )
  )
    return false;
  if (
    top.kind !== 'Read' ||
    format.kind !== 'Read' ||
    commit.kind !== 'Read' ||
    tree.kind !== 'Read' ||
    treatmentBase.kind !== 'Read' ||
    implementationBase.kind !== 'Read' ||
    treatmentAncestor.kind !== 'Read'
  )
    return false;
  try {
    return (
      (await realpath(top.value)) === (await realpath(command.repositoryDirectory)) &&
      format.value === command.h1Repository.objectFormat &&
      commit.value === command.h1Repository.commit &&
      tree.value === command.h1Repository.tree &&
      treatmentBase.value === '' &&
      implementationBase.value === '' &&
      (treatmentAncestor.value === '' || treatmentAncestor.value.startsWith('040000 tree '))
    );
  } catch {
    return false;
  }
}

async function exactFile(path: string, bytes: Uint8Array): Promise<boolean> {
  try {
    const entry = await lstat(path);
    const found = await readFile(path);
    return (
      entry.isFile() &&
      !entry.isSymbolicLink() &&
      found.byteLength === bytes.byteLength &&
      found.equals(Buffer.from(bytes))
    );
  } catch {
    return false;
  }
}

async function verifyBranch(
  command: CandidateBranchCommand,
  candidate: ReviewedCandidateTreatment,
): Promise<CandidateBranchReceipt | undefined> {
  const directory = worktreePath(command, candidate.arm);
  const branch = branchName(command, candidate.arm);
  const [top, currentBranch, common, sourceCommon, parent, commit, tree, status, changed, message] =
    await Promise.all([
      git(directory, ['rev-parse', '--show-toplevel'], command.signal),
      git(directory, ['branch', '--show-current'], command.signal),
      git(directory, ['rev-parse', '--path-format=absolute', '--git-common-dir'], command.signal),
      git(
        command.repositoryDirectory,
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        command.signal,
      ),
      git(directory, ['rev-parse', 'HEAD^'], command.signal),
      git(directory, ['rev-parse', 'HEAD'], command.signal),
      git(directory, ['rev-parse', 'HEAD^{tree}'], command.signal),
      git(directory, ['status', '--porcelain', '--untracked-files=all'], command.signal),
      git(directory, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], command.signal),
      git(directory, ['show', '-s', '--format=%B', 'HEAD'], command.signal),
    ]);
  if (
    [top, currentBranch, common, sourceCommon, parent, commit, tree, status, changed, message].some(
      (item) => item.kind !== 'Read',
    )
  )
    return undefined;
  if (
    top.kind !== 'Read' ||
    currentBranch.kind !== 'Read' ||
    common.kind !== 'Read' ||
    sourceCommon.kind !== 'Read' ||
    parent.kind !== 'Read' ||
    commit.kind !== 'Read' ||
    tree.kind !== 'Read' ||
    status.kind !== 'Read' ||
    changed.kind !== 'Read' ||
    message.kind !== 'Read'
  )
    return undefined;
  try {
    if (
      (await realpath(top.value)) !== (await realpath(directory)) ||
      (await realpath(common.value)) !== (await realpath(sourceCommon.value)) ||
      currentBranch.value !== branch ||
      parent.value !== command.h1Repository.commit ||
      commit.value === parent.value ||
      tree.value === command.h1Repository.tree ||
      status.value !== '' ||
      changed.value.split('\n').sort().join('\n') !== [...pathsFor(candidate)].sort().join('\n') ||
      !message.value.includes(`H0-Said: ${command.h0Said}`) ||
      !message.value.includes(`Successor-Said: ${candidate.successorRevisionSaid}`) ||
      !(await exactFile(join(directory, treatmentPath), candidate.configuration.bytes)) ||
      (candidate.implementation !== undefined &&
        !(await exactFile(join(directory, implementationPath), candidate.implementation.bytes)))
    )
      return undefined;
    const treatmentEntries = (await readdir(join(directory, '.devrandom/evolution'))).sort();
    if (
      treatmentEntries.join('\n') !==
      pathsFor(candidate)
        .map((path) => path.split('/').at(-1))
        .sort()
        .join('\n')
    )
      return undefined;
    return {
      arm: candidate.arm,
      branch,
      directory,
      parentCommit: parent.value,
      commit: commit.value,
      tree: tree.value,
    };
  } catch {
    return undefined;
  }
}

async function writeNewFile(path: string, bytes: Uint8Array): Promise<boolean> {
  try {
    const handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
    return true;
  } catch {
    return false;
  }
}

async function writeTreatment(
  directory: string,
  candidate: ReviewedCandidateTreatment,
): Promise<boolean> {
  const parent = join(directory, '.devrandom');
  const treatment = join(parent, 'evolution');
  try {
    if (
      (await existingPath(parent)) === 'Conflict' ||
      (await existingPath(treatment)) === 'Conflict'
    )
      return false;
    await mkdir(treatment, { recursive: true, mode: 0o700 });
    if (
      (await existingPath(parent)) !== 'Directory' ||
      (await existingPath(treatment)) !== 'Directory' ||
      (await realpath(treatment)) !== join(await realpath(directory), '.devrandom', 'evolution')
    )
      return false;
    if (!(await writeNewFile(join(directory, treatmentPath), candidate.configuration.bytes)))
      return false;
    return (
      candidate.implementation === undefined ||
      (await writeNewFile(join(directory, implementationPath), candidate.implementation.bytes))
    );
  } catch {
    return false;
  }
}

export class GitCandidateBranches implements CandidateBranchCustody {
  async branchSiblings(command: CandidateBranchCommand): Promise<CandidateBranchDisposition> {
    if (!validCommand(command) || command.signal.aborted)
      return { kind: 'Blocked', reason: 'Input' };
    if (!(await repositoryMatches(command))) return { kind: 'Blocked', reason: 'Repository' };
    const existing: CandidateBranchReceipt[] = [];
    const missing: ReviewedCandidateTreatment[] = [];
    for (const candidate of command.candidates) {
      const branch = await git(
        command.repositoryDirectory,
        ['rev-parse', '--verify', `refs/heads/${branchName(command, candidate.arm)}`],
        command.signal,
      );
      const path = await existingPath(worktreePath(command, candidate.arm));
      if (branch.kind === 'Read' && path === 'Directory') {
        const receipt = await verifyBranch(command, candidate);
        if (receipt === undefined) return { kind: 'Blocked', reason: 'CustodyConflict' };
        existing.push(receipt);
      } else if (branch.kind === 'Failed' && path === 'Missing') {
        missing.push(candidate);
      } else return { kind: 'Blocked', reason: 'CustodyConflict' };
    }
    if (missing.length === 0)
      return { kind: 'Reconciled', readiness: 'AwaitingRuntimeBinding', branches: existing };
    try {
      const state = await existingPath(command.stateRoot);
      const evolution = await existingPath(join(command.stateRoot, 'evolution'));
      const hypothesis = await existingPath(join(command.stateRoot, 'evolution', command.h0Said));
      if (state === 'Conflict' || evolution === 'Conflict' || hypothesis === 'Conflict')
        return { kind: 'Blocked', reason: 'CustodyConflict' };
      await mkdir(join(command.stateRoot, 'evolution', command.h0Said), {
        recursive: true,
        mode: 0o700,
      });
      if (
        (await existingPath(command.stateRoot)) !== 'Directory' ||
        (await existingPath(join(command.stateRoot, 'evolution'))) !== 'Directory' ||
        (await existingPath(join(command.stateRoot, 'evolution', command.h0Said))) !==
          'Directory' ||
        (await realpath(join(command.stateRoot, 'evolution', command.h0Said))) !==
          join(await realpath(command.stateRoot), 'evolution', command.h0Said)
      )
        return { kind: 'Blocked', reason: 'CustodyConflict' };
    } catch {
      return { kind: 'Blocked', reason: 'CustodyConflict' };
    }
    const committed = [...existing];
    for (const candidate of missing) {
      const directory = worktreePath(command, candidate.arm);
      const branch = branchName(command, candidate.arm);
      const created = await git(
        command.repositoryDirectory,
        ['worktree', 'add', '-b', branch, directory, command.h1Repository.commit],
        command.signal,
      );
      if (created.kind !== 'Read')
        return { kind: 'Partial', reason: 'GitUnavailable', branches: committed };
      if (!(await writeTreatment(directory, candidate)))
        return { kind: 'Partial', reason: 'CustodyConflict', branches: committed };
      const staged = await git(directory, ['add', '--', ...pathsFor(candidate)], command.signal);
      if (staged.kind !== 'Read')
        return { kind: 'Partial', reason: 'GitUnavailable', branches: committed };
      const committedGit = await git(
        directory,
        [
          '-c',
          'user.name=Devrandom Candidate Custody',
          '-c',
          'user.email=devrandom-candidate@localhost',
          'commit',
          '-m',
          `Reviewed ${candidate.arm} treatment`,
          '-m',
          `H0-Said: ${command.h0Said}\nSuccessor-Said: ${candidate.successorRevisionSaid}`,
        ],
        command.signal,
      );
      if (committedGit.kind !== 'Read')
        return { kind: 'Partial', reason: 'GitUnavailable', branches: committed };
      const receipt = await verifyBranch(command, candidate);
      if (receipt === undefined)
        return { kind: 'Partial', reason: 'CustodyConflict', branches: committed };
      committed.push(receipt);
    }
    return { kind: 'Branched', readiness: 'AwaitingRuntimeBinding', branches: committed };
  }
}
