import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  decodeEvaluationExecutionProfile,
  prepareEvidenceArtifact,
  type EvaluationExecutionProfile,
  type TaskProjection,
} from '@devrandom/protocol';
import {
  DockerRunEnvironment,
  type RunEnvironmentProbeInput,
  type RunRuntimeMount,
} from '@devrandom/runtime';

import type {
  HarnessExecutionInventory,
  HarnessExecutionInventoryOutcome,
} from '../application/baseline-harness-preparation.js';

const runFile = promisify(execFile);
const piSdkVersion = '0.87.1';
const xstateVersion = '5.33.2';

interface DockerCargoInventoryOptions {
  readonly profile: EvaluationExecutionProfile;
  readonly image: string;
  readonly runtimeMounts: readonly RunRuntimeMount[];
  readonly worktreeDirectory: string;
  readonly cargoRealpath: string;
  readonly probe?: typeof DockerRunEnvironment.probe;
}

async function sourceMatches(directory: string, commit: string, tree: string): Promise<boolean> {
  try {
    const [head, headTree, status] = await Promise.all([
      runFile('git', ['-c', 'core.fsmonitor=false', 'rev-parse', '--verify', 'HEAD^{commit}'], {
        cwd: directory,
      }),
      runFile('git', ['-c', 'core.fsmonitor=false', 'rev-parse', '--verify', 'HEAD^{tree}'], {
        cwd: directory,
      }),
      runFile(
        'git',
        ['-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '--untracked-files=normal'],
        { cwd: directory },
      ),
    ]);
    return head.stdout.trim() === commit && headTree.stdout.trim() === tree && status.stdout === '';
  } catch {
    return false;
  }
}

/** Binds H1's declared Cargo commands to the measured Linux OCI executable inventory. */
export class DockerCargoExecutionInventory implements HarnessExecutionInventory {
  readonly #options: DockerCargoInventoryOptions;

  constructor(options: DockerCargoInventoryOptions) {
    this.#options = options;
  }

  async inspect(task: TaskProjection): Promise<HarnessExecutionInventoryOutcome> {
    const options = this.#options;
    const profile = options.profile;
    const commands = [...task.revision.completionConditions, ...(task.revision.toolCommands ?? [])];
    if (
      commands.length === 0 ||
      commands.some((command) => command.argv[0] !== 'cargo') ||
      options.cargoRealpath !==
        `/usr/local/rustup/toolchains/1.98.1-${profile.architecture}-unknown-linux-gnu/bin/cargo`
    )
      return { kind: 'Rejected', reason: 'CommandExecutableUnavailable' };
    if (
      decodeEvaluationExecutionProfile(profile).kind !== 'Accepted' ||
      profile.sourceGitCommit !== task.revision.repository.commit ||
      profile.sourceGitTree !== task.revision.repository.tree ||
      task.revision.repository.objectFormat !== 'sha1' ||
      (options.image !== profile.imageDigest &&
        !options.image.endsWith(`@${profile.imageDigest}`)) ||
      !(await sourceMatches(
        options.worktreeDirectory,
        profile.sourceGitCommit,
        profile.sourceGitTree,
      ))
    )
      return { kind: 'Rejected', reason: 'EnvironmentUnsupported' };
    const probe =
      options.probe ?? ((input: RunEnvironmentProbeInput) => DockerRunEnvironment.probe(input));
    let observed: Awaited<ReturnType<typeof probe>>;
    try {
      observed = await probe({
        profile,
        image: options.image,
        runtimeMounts: options.runtimeMounts,
        worktreeDirectory: options.worktreeDirectory,
        executableRealpaths: [options.cargoRealpath],
        signal: new AbortController().signal,
      });
    } catch {
      return { kind: 'Rejected', reason: 'EnvironmentUnsupported' };
    }
    if (observed.kind !== 'Observed' || observed.toolchainDigest !== profile.toolchainDigest)
      return { kind: 'Rejected', reason: 'EnvironmentUnsupported' };
    const receipt = prepareEvidenceArtifact(observed.effectiveLimitsReceipt, 'application/json');
    if (
      receipt.kind !== 'Prepared' ||
      receipt.artifact.d !== profile.effectiveLimitsReceiptSaid ||
      !(await sourceMatches(
        options.worktreeDirectory,
        profile.sourceGitCommit,
        profile.sourceGitTree,
      ))
    )
      return { kind: 'Rejected', reason: 'EnvironmentUnsupported' };
    return {
      kind: 'Inspected',
      environmentCompatibility: {
        operatingSystem: 'linux',
        architecture: profile.architecture === 'aarch64' ? 'arm64' : 'x64',
        nodeVersion: observed.nodeVersion,
        gitVersion: observed.gitVersion,
        piSdkVersion,
        xstateVersion,
      },
      commandExecutables: commands.map((command) => ({
        commandId: command.id,
        executableRealpath: options.cargoRealpath,
      })),
    };
  }
}
