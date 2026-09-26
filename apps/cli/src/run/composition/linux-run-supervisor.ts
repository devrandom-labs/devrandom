import { join } from 'node:path';

import type { EvaluationExecutionProfile } from '@devrandom/protocol';
import {
  DockerRunEnvironment,
  DockerRunPiExecutor,
  type PiExecutionDisposition,
  type RunRuntimeMount,
} from '@devrandom/runtime';

import type {
  AdmittedRunSupervision,
  AdmittedRunSupervisionProvision,
  AdmittedTaskRunPreparation,
} from '../../task/application/task-run-execution.js';
import { inspectLinuxRunProfile } from '../application/linux-run-profile-preflight.js';
import { DockerExactChildCommands } from '../infrastructure/docker-exact-child-commands.js';
import {
  BaselineRunSupervisorComposition,
  type BaselineRunSupervisorCompositionOptions,
  type RunExecutionProvision,
  type RunExecutionProvisionInput,
} from './baseline-run-supervisor.js';

export interface LinuxRunBinding {
  readonly profile: EvaluationExecutionProfile;
  readonly image: string;
  readonly runtimeMounts: readonly RunRuntimeMount[];
  readonly effectiveLimitsReceipt: Uint8Array;
  readonly parentDeathCleanupReceipt: Uint8Array;
}

export interface LinuxRunSupervisorCompositionOptions extends Omit<
  BaselineRunSupervisorCompositionOptions,
  'executionProvision'
> {
  readonly linux: LinuxRunBinding;
}

const workerProgram = '/app/packages/runtime/dist/pi/evaluation/contained-pi-worker.js';

class LinuxRunExecutionProvision implements RunExecutionProvision {
  readonly #binding: LinuxRunBinding;

  constructor(binding: LinuxRunBinding) {
    this.#binding = binding;
  }

  provision(
    input: RunExecutionProvisionInput,
    signal: AbortSignal,
  ): ReturnType<RunExecutionProvision['provision']> {
    const binding = this.#binding;
    const harness = input.inputs.harness;
    const preflight = inspectLinuxRunProfile({
      run: input.run,
      worktree: input.worktree,
      harness,
      inputs: input.inputs,
      profile: binding.profile,
      effectiveLimitsReceipt: binding.effectiveLimitsReceipt,
      parentDeathCleanupReceipt: binding.parentDeathCleanupReceipt,
    });
    if (preflight.kind !== 'Ready' || signal.aborted)
      return Promise.resolve({ kind: 'Unavailable' });
    if (!binding.runtimeMounts.some((mount) => workerProgram.startsWith(`${mount.containerPath}/`)))
      return Promise.resolve({ kind: 'Unavailable' });
    let active: DockerRunEnvironment | undefined;
    let commandEnvironment: DockerRunEnvironment | undefined;
    const openEnvironment = (environmentSignal: AbortSignal) =>
      DockerRunEnvironment.open({
        profile: binding.profile,
        image: binding.image,
        runtimeMounts: binding.runtimeMounts,
        worktreeDirectory: input.worktree.directory,
        executableRealpaths: preflight.executableRealpaths,
        environmentCompatibility: harness.environmentCompatibility,
        parentDeathCleanupReceipt: binding.parentDeathCleanupReceipt,
        signal: environmentSignal,
      });
    const commands = new DockerExactChildCommands({
      environment: {
        close: () => (commandEnvironment ?? active)?.close() ?? Promise.resolve(false),
        runNative: async (executableRealpath, arguments_, commandSignal) => {
          let environment = active;
          const separate = environment === undefined;
          if (environment === undefined) {
            const opened = await openEnvironment(commandSignal);
            if (opened.kind !== 'Opened') return { kind: opened.kind };
            environment = opened.environment;
            commandEnvironment = environment;
          }
          try {
            const native = await environment.runNative(
              executableRealpath,
              arguments_,
              commandSignal,
            );
            if (native.kind !== 'Running') {
              if (!separate) return native;
              const removed = await environment.close();
              commandEnvironment = undefined;
              return removed ? native : { kind: 'CleanupUnconfirmed' };
            }
            if (!separate) return native;
            return {
              ...native,
              close: async () => {
                const nativeRemoved = await native.close();
                const environmentRemoved = await environment.close();
                commandEnvironment = undefined;
                return nativeRemoved && environmentRemoved;
              },
            };
          } catch {
            const removed = await environment.close();
            if (separate) commandEnvironment = undefined;
            if (!removed) return { kind: 'CleanupUnconfirmed' };
            return { kind: 'Unavailable' };
          }
        },
      },
      outputRoot: join(input.runDirectory, 'command-output'),
      maximumOutputBytes: binding.profile.limits.outputBytes,
      budget: input.budget,
      protectedCredentials: input.protectedCredentials,
      monotonicNow: () => performance.now(),
    });
    let used = false;
    return Promise.resolve({
      kind: 'Prepared',
      commands,
      pi: (gateway) => ({
        invoke: async (run, invocationSignal): Promise<PiExecutionDisposition> => {
          if (used || run.binding.runId !== input.run.binding.runId || invocationSignal.aborted)
            return { kind: 'DependencyUnavailable' };
          used = true;
          const opened = await openEnvironment(invocationSignal);
          if (opened.kind !== 'Opened')
            return {
              kind:
                opened.kind === 'Unavailable'
                  ? 'DependencyUnavailable'
                  : 'EvidenceIntegrityFailure',
            };
          active = opened.environment;
          try {
            return await new DockerRunPiExecutor({
              profile: binding.profile,
              environment: opened.environment,
              workerProgram,
              worktreeBranch: input.worktree.branch,
              instructions: input.inputs.instructions,
              instructionResources: harness.repository.instructionResources,
              prompt: input.inputs.prompt,
              effectiveLimitsReceipt: opened.effectiveLimitsReceipt,
              parentDeathCleanupReceipt: opened.parentDeathCleanupReceipt,
              harness,
              modelAccess: input.modelAccess,
              budget: input.budget,
              gateway,
              evidence: input.evidence,
              protectedCredentials: input.protectedCredentials,
              now: () => input.now(),
              sessionId: () => input.sessionId(),
            }).invoke(run, invocationSignal);
          } finally {
            active = undefined;
            await opened.environment.close();
          }
        },
      }),
    });
  }
}

/** Linux H1 composition; the existing Darwin baseline remains a separate selection. */
export class LinuxRunSupervisorComposition implements AdmittedRunSupervisionProvision {
  readonly #supervision: BaselineRunSupervisorComposition;

  constructor(options: LinuxRunSupervisorCompositionOptions) {
    this.#supervision = new BaselineRunSupervisorComposition({
      ...options,
      executionProvision: new LinuxRunExecutionProvision(options.linux),
    });
  }

  provision(preparation: AdmittedTaskRunPreparation): AdmittedRunSupervision {
    return this.#supervision.provision(preparation);
  }
}
