import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';

import { decodeEvidenceArtifact } from '@devrandom/protocol';

import type { C2WorkflowTreatmentCustody } from '../application/c2-workflow-treatment-custody.js';

const exec = promisify(execFile);
const sha1 = /^[a-f0-9]{40}$/u;
const configurationPath = '.devrandom/evolution/treatment.json';
const implementationPath = '.devrandom/evolution/implementation.bin';

async function gitText(directory: string, args: readonly string[], signal: AbortSignal) {
  try {
    const result = await exec('git', ['-C', directory, ...args], {
      encoding: 'utf8',
      signal,
      timeout: 30_000,
      maxBuffer: 256 * 1024,
    });
    return result.stdout.trim();
  } catch {
    return undefined;
  }
}

async function gitBytes(
  directory: string,
  commit: string,
  path: string,
  maximum: number,
  signal: AbortSignal,
) {
  try {
    const result = await exec('git', ['-C', directory, 'show', `${commit}:${path}`], {
      encoding: 'buffer',
      signal,
      timeout: 30_000,
      maxBuffer: maximum + 1,
    });
    return Buffer.isBuffer(result.stdout) &&
      result.stdout.byteLength > 0 &&
      result.stdout.byteLength <= maximum
      ? Uint8Array.from(result.stdout)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Exact immutable Git custody for one reviewed workflow change, with no symlink or Task source read. */
export class GitC2WorkflowTreatmentCustody implements C2WorkflowTreatmentCustody {
  async read(
    input: Parameters<C2WorkflowTreatmentCustody['read']>[0],
  ): ReturnType<C2WorkflowTreatmentCustody['read']> {
    if (
      !isAbsolute(input.repositoryDirectory) ||
      ![input.parentCommit, input.parentTree, input.candidateCommit, input.candidateTree].every(
        (value) => sha1.test(value),
      ) ||
      input.configuration.mediaType !== 'application/json' ||
      input.implementation.mediaType !== 'application/octet-stream' ||
      input.signal.aborted
    )
      return { kind: 'Denied' };
    const [
      top,
      format,
      parent,
      parentTree,
      commit,
      tree,
      commitParent,
      changed,
      configMode,
      implementationMode,
      oldConfig,
      oldImplementation,
    ] = await Promise.all([
      gitText(input.repositoryDirectory, ['rev-parse', '--show-toplevel'], input.signal),
      gitText(input.repositoryDirectory, ['rev-parse', '--show-object-format'], input.signal),
      gitText(
        input.repositoryDirectory,
        ['rev-parse', `${input.parentCommit}^{commit}`],
        input.signal,
      ),
      gitText(
        input.repositoryDirectory,
        ['rev-parse', `${input.parentCommit}^{tree}`],
        input.signal,
      ),
      gitText(
        input.repositoryDirectory,
        ['rev-parse', `${input.candidateCommit}^{commit}`],
        input.signal,
      ),
      gitText(
        input.repositoryDirectory,
        ['rev-parse', `${input.candidateCommit}^{tree}`],
        input.signal,
      ),
      gitText(input.repositoryDirectory, ['rev-parse', `${input.candidateCommit}^`], input.signal),
      gitText(
        input.repositoryDirectory,
        ['diff-tree', '--no-commit-id', '--name-only', '-r', input.candidateCommit],
        input.signal,
      ),
      gitText(
        input.repositoryDirectory,
        ['ls-tree', input.candidateCommit, '--', configurationPath],
        input.signal,
      ),
      gitText(
        input.repositoryDirectory,
        ['ls-tree', input.candidateCommit, '--', implementationPath],
        input.signal,
      ),
      gitText(
        input.repositoryDirectory,
        ['ls-tree', input.parentCommit, '--', configurationPath],
        input.signal,
      ),
      gitText(
        input.repositoryDirectory,
        ['ls-tree', input.parentCommit, '--', implementationPath],
        input.signal,
      ),
    ]);
    if (
      [
        top,
        format,
        parent,
        parentTree,
        commit,
        tree,
        commitParent,
        changed,
        configMode,
        implementationMode,
        oldConfig,
        oldImplementation,
      ].some((value) => value === undefined)
    )
      return { kind: 'Unavailable' };
    try {
      if (
        (await realpath(top ?? '')) !== (await realpath(input.repositoryDirectory)) ||
        format !== 'sha1' ||
        parent !== input.parentCommit ||
        parentTree !== input.parentTree ||
        commit !== input.candidateCommit ||
        tree !== input.candidateTree ||
        commitParent !== input.parentCommit ||
        changed?.split('\n').sort().join('\n') !==
          [configurationPath, implementationPath].sort().join('\n') ||
        oldConfig !== '' ||
        oldImplementation !== '' ||
        !configMode?.startsWith('100644 blob ') ||
        !configMode.endsWith(`\t${configurationPath}`) ||
        !implementationMode?.startsWith('100644 blob ') ||
        !implementationMode.endsWith(`\t${implementationPath}`)
      )
        return { kind: 'Denied' };
    } catch {
      return { kind: 'Unavailable' };
    }
    const [configurationBytes, implementationBytes] = await Promise.all([
      gitBytes(
        input.repositoryDirectory,
        input.candidateCommit,
        configurationPath,
        32 * 1024,
        input.signal,
      ),
      gitBytes(
        input.repositoryDirectory,
        input.candidateCommit,
        implementationPath,
        128 * 1024,
        input.signal,
      ),
    ]);
    if (configurationBytes === undefined || implementationBytes === undefined)
      return { kind: 'Unavailable' };
    return decodeEvidenceArtifact(input.configuration, configurationBytes).kind === 'Accepted' &&
      decodeEvidenceArtifact(input.implementation, implementationBytes).kind === 'Accepted'
      ? { kind: 'Read', configurationBytes, implementationBytes }
      : { kind: 'Denied' };
  }
}
