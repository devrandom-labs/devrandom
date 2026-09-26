import type { VerifiedCheckpoint } from '@devrandom/protocol';
import {
  RunEffectQuiescence,
  type RunSubmissionSourceCustody,
} from '../application/run-effect-quiescence.js';
import { RunWorkAccess } from '../../work-access/application/run-work-access.js';
import { RunWorktreeCommands } from '../application/run-worktree-commands.js';
import { RunCheckpointPause } from '../application/run-checkpoint-pause.js';
import { settleBlockedRun } from '../application/blocked-run-settlement.js';
import type {
  RunSubmissionVerification,
  SubmittedVerificationCustody,
} from '../application/run-submissions.js';
import { RunSubmissions } from '../application/run-submissions.js';
import { lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { IssuerAid } from '@devrandom/identity';
import type { ProtectedCredentials, Run } from '@devrandom/domain';
import {
  AcceptedRunLease,
  BaselinePiExecutor,
  MonotonicLeaseClock,
  PinnedPiModelAccess,
  RunResourceBudget,
  RunSupervisor,
  ToolGateway,
  ToolProposalBudgetLedger,
  type PiCredentialSource,
  type PiExecution,
  type PiExecutionGateway,
  type PiModelAccess,
  type EvidenceRecorder,
  type RunLeaseReceipt,
  type RunSupervision,
  type RunSupervisionSettlement,
  type ToolName,
} from '@devrandom/runtime';

import type {
  AdmittedRunSupervision,
  AdmittedRunSupervisionProvision,
  AdmittedTaskRunPreparation,
} from '../../task/application/task-run-execution.js';
import {
  BaselineExecutionInputMaterializer,
  type BaselineExecutionInputs,
} from '../application/baseline-execution-inputs.js';
import { BaselineRunExecutionPreparation } from '../application/baseline-run-execution-preparation.js';
import { deliverRunEvidence } from '../application/evidence-delivery.js';
import { PreparedCompatibilityCalibration } from '../application/prepared-compatibility-calibration.js';
import { PreparedCompatibilityCalibrationSettlement } from '../application/prepared-compatibility-calibration-settlement.js';
import {
  PreparedCompatibilityClassifier,
  preparedCompatibilityVerifierReadOnlyPaths,
} from '../application/prepared-compatibility.js';
import { RetainedRunSettlement } from '../application/retained-run-settlement.js';
import { PublicTaskVerification } from '../application/public-task-verification.js';
import { SealedEvidenceSettlement } from '../application/sealed-evidence-settlement.js';
import { VerifiedRunCheckpoint } from '../application/verified-run-checkpoint.js';
import {
  PosixExactChildCommands,
  type SanitizedChildEnvironment,
} from '../infrastructure/exact-child-commands.js';
import { GitWorktreeChanges } from '../infrastructure/git-worktree-changes.js';
import { RunWorktreeWriteAdmission } from '../application/worktree-write-admission.js';
import { GitRunWorktrees } from '../infrastructure/git-run-worktree.js';
import { GitWorktreeInstructions } from '../infrastructure/git-worktree-instructions.js';
import { HostedRunLeaseAuthority } from '../infrastructure/hosted-run-lease-authority.js';
import {
  ManagedWorktreeResources,
  ManagedWorktreeToolEffects,
} from '../infrastructure/managed-worktree-tools.js';
import { EvidenceRecorderProcessOutput } from '../infrastructure/process-output-evidence.js';
import { PreparedCompatibilityCalibrationFile } from '../infrastructure/prepared-compatibility-calibration-file.js';
import { SignifyTaskToolMandate } from '../infrastructure/signify-task-tool-mandate.js';
import { SqliteEvidenceOutboxes } from '../infrastructure/sqlite-evidence-outbox.js';
import type { ExactChildCommands } from '../application/exact-child-command.js';
import type { PreparedRunWorktree } from '../application/run-worktree.js';

export interface RunExecutionProvisionInput {
  readonly run: Run;
  readonly worktree: PreparedRunWorktree;
  readonly runDirectory: string;
  readonly agentDirectory: string;
  readonly temporaryDirectory: string;
  readonly inputs: BaselineExecutionInputs;
  readonly budget: RunResourceBudget;
  readonly evidence: EvidenceRecorder;
  readonly modelAccess: PiModelAccess;
  readonly protectedCredentials: ProtectedCredentials;
  now(): string;
  sessionId(): string;
  modelTurnId(): string;
}

export type PreparedRunExecutors = {
  readonly kind: 'Prepared';
  readonly commands: ExactChildCommands;
  pi(gateway: PiExecutionGateway): PiExecution;
};

export interface RunExecutionProvision {
  provision(
    input: RunExecutionProvisionInput,
    signal: AbortSignal,
  ): Promise<PreparedRunExecutors | { readonly kind: 'Unavailable' }>;
}

export type AdmittedRunExecutionCustody = Pick<
  AdmittedTaskRunPreparation,
  | 'task'
  | 'mandates'
  | 'harness'
  | 'protectedCredentials'
  | 'workAccessRenewal'
  | 'executionAuthority'
>;

export interface SuccessorRunSettlementProvision {
  provision(input: {
    readonly sourceCustody: RunSubmissionSourceCustody;
    readonly run: Run;
    readonly preparation: AdmittedRunExecutionCustody;
    readonly worktree: PreparedRunWorktree;
    readonly evidence: EvidenceRecorder;
    readonly budget: RunResourceBudget;
    readonly verification: PublicTaskVerification;
    readonly checkpointing: VerifiedRunCheckpoint;
    readonly sealing: SealedEvidenceSettlement;
    readonly commands: RunWorktreeCommands;
  }): {
    readonly submissions: RunSubmissionVerification & SubmittedVerificationCustody;
    readonly settlement: RunSupervisionSettlement;
  };
}

export interface BaselineRunSupervisorCompositionOptions {
  readonly pauseAfterCheckpoint?: boolean;
  readonly pausePredecessorRepository?: Extract<
    VerifiedCheckpoint,
    { readonly version: 1 }
  >['repository'];
  readonly successorSettlement?: SuccessorRunSettlementProvision;
  readonly stateRoot: string;
  readonly repositoryDirectory: string;
  readonly issuerAid: IssuerAid;
  readonly modelCredential: PiCredentialSource;
  readonly childEnvironment: Pick<SanitizedChildEnvironment, 'path' | 'language'>;
  readonly executionProvision?: RunExecutionProvision;
  now(): string;
  sessionId(): string;
  modelTurnId(): string;
  wait(milliseconds: number): Promise<void>;
}

async function preparePrivateDirectory(path: string): Promise<'Prepared' | 'Unavailable'> {
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const metadata = await lstat(path);
    return metadata.isDirectory() && !metadata.isSymbolicLink() && (metadata.mode & 0o777) === 0o700
      ? 'Prepared'
      : 'Unavailable';
  } catch {
    return 'Unavailable';
  }
}

const unavailableSettlement: RunSupervisionSettlement = {
  settle: () => Promise.resolve({ kind: 'Unavailable' }),
};

function toolName(identity: string): ToolName | undefined {
  switch (identity) {
    case 'read_file':
    case 'list_files':
    case 'search_repository':
    case 'write_file':
    case 'replace_text':
    case 'run_formatter':
    case 'run_static_analysis':
    case 'run_tests':
    case 'submit_result':
      return identity;
    default:
      return undefined;
  }
}

class AdmittedBaselineRunSupervision implements AdmittedRunSupervision {
  readonly #preparation: AdmittedRunExecutionCustody;
  readonly #options: BaselineRunSupervisorCompositionOptions;

  constructor(
    preparation: AdmittedRunExecutionCustody,
    options: BaselineRunSupervisorCompositionOptions,
  ) {
    this.#preparation = preparation;
    this.#options = options;
  }

  async supervise(
    run: Parameters<AdmittedRunSupervision['supervise']>[0],
    lease: RunLeaseReceipt,
    signal: AbortSignal,
    leaseRequestStartedAt: number,
  ): Promise<RunSupervision> {
    const leaseClock = new MonotonicLeaseClock();
    const acceptedLease = new AcceptedRunLease(lease, leaseClock, leaseRequestStartedAt);
    const preparation = this.#preparation;
    const options = this.#options;
    const workAccess = new RunWorkAccess(preparation.workAccessRenewal, leaseClock);
    const executionPreparation = new BaselineRunExecutionPreparation({
      stateRoot: options.stateRoot,
      repositoryDirectory: options.repositoryDirectory,
      worktrees: new GitRunWorktrees(),
      recorders: new SqliteEvidenceOutboxes(() => options.now(), preparation.protectedCredentials),
      provision: {
        provision: async ({ run: running, worktree, evidence }, preparationSignal) => {
          preparationSignal.throwIfAborted();
          const modelCredential = await options.modelCredential.acquire(
            preparation.harness.projection.revision.modelCompatibility,
          );
          preparationSignal.throwIfAborted();
          if (modelCredential.kind !== 'Available') return { kind: 'ModelCredentialUnavailable' };
          preparation.protectedCredentials.protect(modelCredential.secret);
          const inputs = await new BaselineExecutionInputMaterializer({
            instructions: new GitWorktreeInstructions(),
            protectedCredentials: preparation.protectedCredentials,
          }).materialize(
            {
              task: preparation.task,
              harness: preparation.harness.projection.revision,
              worktree,
            },
            preparationSignal,
          );
          preparationSignal.throwIfAborted();
          if (inputs.kind === 'SecretDetected') return inputs;
          if (inputs.kind !== 'Materialized') {
            return { kind: 'DependencyUnavailable' };
          }
          const runDirectory =
            running.currentExecution === undefined
              ? join(options.stateRoot, 'runs', running.binding.runId)
              : join(
                  options.stateRoot,
                  'runs',
                  running.binding.runId,
                  'incarnations',
                  running.lease.kind === 'Held' ? running.lease.incarnationId : 'invalid',
                );
          const agentDirectory = join(runDirectory, 'pi-agent');
          const temporaryDirectory = join(runDirectory, 'tmp');
          if ((await preparePrivateDirectory(agentDirectory)) !== 'Prepared') {
            return { kind: 'DependencyUnavailable' };
          }
          preparationSignal.throwIfAborted();
          if ((await preparePrivateDirectory(temporaryDirectory)) !== 'Prepared') {
            return { kind: 'DependencyUnavailable' };
          }
          preparationSignal.throwIfAborted();
          const budget = new RunResourceBudget({
            run: running,
            evidence,
            now: () => options.now(),
          });
          const modelAccess = new PinnedPiModelAccess({
            acquire: () => Promise.resolve(modelCredential),
          });
          const preparedExecutors =
            options.executionProvision === undefined
              ? {
                  kind: 'Prepared' as const,
                  commands: new PosixExactChildCommands({
                    protectedCredentials: preparation.protectedCredentials,
                    workingDirectory: worktree.directory,
                    outputRoot: join(runDirectory, 'command-output'),
                    maximumOutputBytes: 512 * 1_024,
                    environment: {
                      ...options.childEnvironment,
                      temporaryDirectory,
                    },
                    budget,
                    monotonicNow: () => performance.now(),
                  }),
                  pi: (gateway: PiExecutionGateway) =>
                    new BaselinePiExecutor({
                      protectedCredentials: preparation.protectedCredentials,
                      worktree: inputs.inputs.worktree,
                      agentDirectory,
                      harness: inputs.inputs.harness,
                      instructions: inputs.inputs.instructions,
                      prompt: inputs.inputs.prompt,
                      modelAccess,
                      budget,
                      gateway,
                      evidence,
                      now: () => options.now(),
                      sessionId: () => options.sessionId(),
                      modelTurnId: () => options.modelTurnId(),
                    }),
                }
              : await options.executionProvision.provision(
                  {
                    run: running,
                    worktree,
                    runDirectory,
                    agentDirectory,
                    temporaryDirectory,
                    inputs: inputs.inputs,
                    budget,
                    evidence,
                    modelAccess,
                    protectedCredentials: preparation.protectedCredentials,
                    now: () => options.now(),
                    sessionId: () => options.sessionId(),
                    modelTurnId: () => options.modelTurnId(),
                  },
                  preparationSignal,
                );
          if (preparedExecutors.kind !== 'Prepared') return { kind: 'DependencyUnavailable' };
          const processes = preparedExecutors.commands;
          const repository = new GitWorktreeChanges(preparation.protectedCredentials);
          const commands = new RunWorktreeCommands({
            commands: processes,
            worktree,
            limits: running.binding.budget,
            repository,
            evidence,
            now: () => options.now(),
          });
          const processOutput = new EvidenceRecorderProcessOutput(evidence, () => options.now());
          const resources = new ManagedWorktreeResources({
            worktree: worktree.directory,
            protectedPaths: preparation.task.revision.constraints.protectedPaths,
            readOnlyPaths: preparedCompatibilityVerifierReadOnlyPaths(preparation.task),
            completionCommands: preparation.harness.projection.revision.completionCommands,
            toolCommands: preparation.harness.projection.revision.toolCommands ?? [],
          });
          const verification = new PublicTaskVerification({
            task: preparation.task,
            harness: preparation.harness.projection.revision,
            evidence,
            commands,
            processOutput,
            now: () => options.now(),
          });
          const checkpointing = new VerifiedRunCheckpoint({
            task: preparation.task,
            harness: preparation.harness.projection.revision,
            worktree,
            evidence,
            repository,
            budget,
            now: () => options.now(),
          });
          const sealing = new SealedEvidenceSettlement({
            hostedEvidence: workAccess,
            hostedSeals: workAccess,
            exchange: preparation.executionAuthority.evidenceSealExchange,
            sourceAid: preparation.executionAuthority.personalAgentAid,
            recipientAid: options.issuerAid,
            wait: (milliseconds) => options.wait(milliseconds),
            maximumObservations: 300,
          });
          const compatibility = new PreparedCompatibilityClassifier();
          const sourceCustody = new RunEffectQuiescence();
          const successor =
            running.currentExecution === undefined
              ? undefined
              : options.successorSettlement?.provision({
                  sourceCustody,
                  run: running,
                  preparation,
                  worktree,
                  evidence,
                  budget,
                  verification,
                  checkpointing,
                  sealing,
                  commands,
                });
          if (
            running.currentExecution !== undefined &&
            successor === undefined &&
            options.pauseAfterCheckpoint !== true
          )
            return { kind: 'DependencyUnavailable' };
          const pause =
            running.currentExecution !== undefined && options.pauseAfterCheckpoint === true
              ? new RunCheckpointPause()
              : undefined;
          const submissions =
            successor?.submissions ??
            new RunSubmissions({
              task: preparation.task,
              harness: preparation.harness.projection.revision,
              run: running,
              verification,
              compatibility,
            });
          const effects = new ManagedWorktreeToolEffects({
            resources,
            writeAdmission: new RunWorktreeWriteAdmission({
              worktree,
              limits: running.binding.budget,
              repository,
              credentials: preparation.protectedCredentials,
              evidence,
              now: () => options.now(),
            }),
            commands,
            artifacts: evidence,
            processOutput,
            verification: submissions,
          });
          const activeTools = preparation.harness.projection.revision.activeTools.flatMap(
            ({ identity, requiredCapability }) => {
              const name = toolName(identity);
              return name === undefined ? [] : [{ name, requiredCapability }];
            },
          );
          if (activeTools.length !== preparation.harness.projection.revision.activeTools.length) {
            return { kind: 'DependencyUnavailable' };
          }
          const gateway = new ToolGateway({
            binding: {
              taskRevisionSaid: running.binding.taskRevisionSaid,
              runId: running.binding.runId,
              incarnationId: running.lease.kind === 'Held' ? running.lease.incarnationId : '',
              harnessRevisionSaid:
                running.currentExecution?.harnessRevisionSaid ??
                running.binding.initialHarnessRevisionSaid,
              taskMandateSaid: running.binding.taskMandateSaid,
            },
            activeTools,
            resources,
            mandate: new SignifyTaskToolMandate({
              task: preparation.task,
              personalAgentAid: preparation.executionAuthority.personalAgentAid,
              mandateRegistryId: preparation.mandates.mandateRegistryId,
              taskMandateSaid: preparation.mandates.taskMandate.credentialSaid,
              custody: preparation.executionAuthority.taskMandateCustody,
              now: () => options.now(),
            }),
            lease: acceptedLease,
            budget: new ToolProposalBudgetLedger(budget),
            evidence,
            effects,
            now: () => options.now(),
          });
          const calibration = new PreparedCompatibilityCalibration(
            new PreparedCompatibilityCalibrationFile(
              join(
                options.stateRoot,
                'calibration',
                preparation.task.taskId,
                running.binding.initialHarnessRevisionSaid,
              ),
            ),
          );
          const ordinarySettlement =
            successor?.settlement ??
            (running.binding.purpose.kind === 'PreparedCompatibilityCalibration'
              ? new PreparedCompatibilityCalibrationSettlement({
                  task: preparation.task,
                  harness: preparation.harness.projection.revision,
                  evidence,
                  custody: submissions,
                  verification,
                  compatibility,
                  calibration,
                  checkpointing,
                  sealing,
                  now: () => options.now(),
                })
              : new RetainedRunSettlement({
                  task: preparation.task,
                  harness: preparation.harness.projection.revision,
                  evidence,
                  custody: submissions,
                  verification,
                  compatibility,
                  calibration,
                  checkpointing,
                  sealing,
                  now: () => options.now(),
                }));
          return {
            kind: 'Provisioned',
            evidenceDelivery: {
              deliver: (signal) =>
                deliverRunEvidence({
                  recorder: evidence,
                  hosted: workAccess,
                  clock: leaseClock,
                  signal,
                }),
            },
            pi:
              pause === undefined
                ? preparedExecutors.pi(
                    running.currentExecution === undefined
                      ? gateway
                      : sourceCustody.gateway(gateway),
                  )
                : {
                    invoke: (invokedRun, signal) =>
                      preparedExecutors
                        .pi(pause.gateway(sourceCustody.gateway(gateway)))
                        .invoke(invokedRun, AbortSignal.any([signal, pause.signal])),
                  },
            settlement:
              pause === undefined
                ? ordinarySettlement
                : {
                    settle: async (input) => {
                      if (!pause.reached) return ordinarySettlement.settle(input);
                      try {
                        const captured = await repository.capture(
                          worktree,
                          {
                            changedFiles: running.binding.budget.changedFiles,
                            changedWorktreeBytes: running.binding.budget.changedWorktreeBytes,
                          },
                          new AbortController().signal,
                        );
                        if (
                          options.pausePredecessorRepository === undefined ||
                          captured.kind !== 'Captured' ||
                          !pause.hasProgress(
                            captured.repository,
                            options.pausePredecessorRepository,
                          )
                        )
                          return { kind: 'Unavailable' };
                        const receipts = verification.unresolvedReceipts('RunBlocked');
                        if (receipts === undefined) return { kind: 'Unavailable' };
                        return await settleBlockedRun(
                          {
                            run: input.run,
                            reason: 'CheckpointPause',
                            verifierReceipts: receipts,
                            outputArtifactSaids: [],
                          },
                          { evidence, checkpointing, sealing, now: () => options.now() },
                        );
                      } finally {
                        evidence.close();
                      }
                    },
                  },
            budget,
            wallClock: leaseClock,
          };
        },
      },
      now: () => options.now(),
    });
    const maintenanceStop = new AbortController();
    const maintenance = workAccess.maintain(maintenanceStop.signal);
    try {
      return await new RunSupervisor({
        preparation: executionPreparation,
        leaseAuthority: new HostedRunLeaseAuthority(workAccess),
        leaseClock,
        leaseAcceptances: acceptedLease,
        settlement: unavailableSettlement,
      }).supervise(run, lease, signal, leaseRequestStartedAt);
    } finally {
      maintenanceStop.abort();
      await maintenance;
    }
  }
}

export class BaselineRunSupervisorComposition implements AdmittedRunSupervisionProvision {
  readonly #options: BaselineRunSupervisorCompositionOptions;

  constructor(options: BaselineRunSupervisorCompositionOptions) {
    this.#options = options;
  }

  provision(preparation: AdmittedRunExecutionCustody): AdmittedRunSupervision {
    return new AdmittedBaselineRunSupervision(preparation, this.#options);
  }
}
