import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';

import type { CandidateTreatmentCustody } from '../application/candidate-treatment-custody.js';

const exec = promisify(execFile);
const sha1 = /^[a-f0-9]{40}$/u;
const treatmentPath = '.devrandom/evolution/treatment.json';

async function textGit(
  directory: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    const result = await exec('git', ['-C', directory, ...args], {
      encoding: 'utf8',
      signal,
      timeout: 30_000,
      maxBuffer: 128 * 1024,
    });
    return result.stdout.trim();
  } catch {
    return undefined;
  }
}

async function rawTreatment(
  directory: string,
  commit: string,
  signal: AbortSignal,
): Promise<Uint8Array | undefined> {
  try {
    const result = await exec('git', ['-C', directory, 'show', `${commit}:${treatmentPath}`], {
      encoding: 'buffer',
      signal,
      timeout: 30_000,
      maxBuffer: 32 * 1024 + 1,
    });
    return Buffer.isBuffer(result.stdout) && result.stdout.byteLength <= 32 * 1024
      ? Uint8Array.from(result.stdout)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Immutable Git adapter for the trusted parent; it never reads Task source worktree files. */
export class GitCandidateTreatmentCustody implements CandidateTreatmentCustody {
  async read(
    input: Parameters<CandidateTreatmentCustody['read']>[0],
  ): ReturnType<CandidateTreatmentCustody['read']> {
    if (
      !isAbsolute(input.repositoryDirectory) ||
      ![input.candidateCommit, input.candidateTree, input.parentCommit, input.parentTree].every(
        (value) => sha1.test(value),
      ) ||
      input.signal.aborted
    )
      return { kind: 'Denied' };
    const [top, format, commit, tree, parent, parentTree, changed, mode] = await Promise.all([
      textGit(input.repositoryDirectory, ['rev-parse', '--show-toplevel'], input.signal),
      textGit(input.repositoryDirectory, ['rev-parse', '--show-object-format'], input.signal),
      textGit(
        input.repositoryDirectory,
        ['rev-parse', `${input.candidateCommit}^{commit}`],
        input.signal,
      ),
      textGit(
        input.repositoryDirectory,
        ['rev-parse', `${input.candidateCommit}^{tree}`],
        input.signal,
      ),
      textGit(input.repositoryDirectory, ['rev-parse', `${input.candidateCommit}^`], input.signal),
      textGit(
        input.repositoryDirectory,
        ['rev-parse', `${input.parentCommit}^{tree}`],
        input.signal,
      ),
      textGit(
        input.repositoryDirectory,
        ['diff-tree', '--no-commit-id', '--name-only', '-r', input.candidateCommit],
        input.signal,
      ),
      textGit(
        input.repositoryDirectory,
        ['ls-tree', input.candidateCommit, '--', treatmentPath],
        input.signal,
      ),
    ]);
    if (
      top === undefined ||
      format === undefined ||
      commit === undefined ||
      tree === undefined ||
      parent === undefined ||
      parentTree === undefined ||
      changed === undefined ||
      mode === undefined
    )
      return { kind: 'Unavailable' };
    try {
      if (
        (await realpath(top)) !== (await realpath(input.repositoryDirectory)) ||
        format !== 'sha1' ||
        commit !== input.candidateCommit ||
        tree !== input.candidateTree ||
        parent !== input.parentCommit ||
        parentTree !== input.parentTree ||
        changed !== treatmentPath ||
        !mode.startsWith('100644 blob ') ||
        !mode.endsWith(`\t${treatmentPath}`)
      )
        return { kind: 'Denied' };
    } catch {
      return { kind: 'Unavailable' };
    }
    const bytes = await rawTreatment(
      input.repositoryDirectory,
      input.candidateCommit,
      input.signal,
    );
    return bytes === undefined ? { kind: 'Unavailable' } : { kind: 'Read', bytes };
  }
}
