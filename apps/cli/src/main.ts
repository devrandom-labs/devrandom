#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ProtectedCredentials } from '@devrandom/domain';

import {
  UserIdentityApplication,
  userIdentityDefaults,
} from './identity/application/user-identity.js';
import { BaselineHarnessPreparation } from './harness/application/baseline-harness-preparation.js';
import { BaselineHarnessAdmissionFile } from './harness/infrastructure/baseline-harness-admission-file.js';
import { GitHarnessInspection } from './harness/infrastructure/git-harness-inspection.js';
import { DockerCargoExecutionInventory } from './harness/infrastructure/docker-cargo-execution-inventory.js';
import { HostHarnessExecutionInventory } from './harness/infrastructure/host-harness-execution-inventory.js';
import { EnvironmentPiModelInspection } from './harness/infrastructure/model-profile-environment.js';
import { evaluateLocalHarness } from './harness/composition/local-harness-evaluation.js';
import { reconcileStagedCesrManifest } from './harness/application/lock-cesr-comparison-manifest.js';
import { EvaluationManifestCommandFile } from './harness/infrastructure/evaluation-manifest-command-file.js';
import { SqliteCesrComparisonCases } from './harness/infrastructure/sqlite-cesr-comparison-cases.js';
import { VerifiedFailureCampaign } from './harness/application/verified-failure-campaign.js';
import { EvaluationCommandFile } from './harness/infrastructure/evaluation-command-file.js';
import { EvaluationPolicyFile } from './harness/infrastructure/evaluation-policy-file.js';
import { progressQualifiedH0 } from './evolution/application/progress-qualified-h0.js';
import {
  publishLocalHarness,
  fetchPublishedHarness,
  forkPublishedHarness,
} from './publication/composition/local-harness-publication.js';
import { decodeDevrandomServerOrigin } from './infrastructure/devrandom-server-http.js';
import { promoteLocalEvaluation } from './promotion/composition/local-evaluation-promotion.js';
import type { QualifiedH0ProgressOutcome } from './evolution/application/progress-qualified-h0.js';
import { FilePublicAnalogyReviews } from './evolution/infrastructure/file-public-analogy-reviews.js';
import { FileQualifiedH0Records } from './evolution/infrastructure/file-qualified-h0-records.js';
import { ReviewedComparisonPlanFile } from './evolution/infrastructure/reviewed-comparison-plan-file.js';
import { SignifyCurrentExperienceMandate } from './evolution/infrastructure/signify-current-experience-mandate.js';
import { PreparedCompatibilityCampaignHistoryFile } from './harness/infrastructure/prepared-compatibility-campaign-history.js';
import { prepareQualifiedSourceInventory } from './harness/application/prepare-qualified-source-inventory.js';
import { QualifiedSourceInventoryFile } from './harness/infrastructure/qualified-source-inventory-file.js';
import { verifyDemoIssuer } from './identity/application/demo-issuer-compatibility.js';
import { IdentityFiles } from './identity/infrastructure/identity-files.js';
import { IssuerHealthHttp } from './identity/infrastructure/issuer-health-http.js';
import { IssuerRegistrationHttp } from './identity/infrastructure/issuer-registration-http.js';
import { openSystemBrowser } from './identity/infrastructure/system-browser.js';
import {
  loadUserIdentityConfiguration,
  userIdentityEnvironment,
} from './identity/infrastructure/user-environment.js';
import { devrandomUserAlias } from './identity/domain/user-configuration.js';
import { AuthorizedLocalTaskMandates } from './mandate/application/local-task-mandates.js';
import { GovernanceProfileFile } from './mandate/infrastructure/governance-profile-file.js';
import {
  loadMandateConfiguration,
  mandateEnvironment,
} from './mandate/infrastructure/mandate-environment.js';
import { SignifyLocalMandateAuthority } from './mandate/infrastructure/signify-local-mandate-authority.js';
import { TaskAuthorizationFile } from './mandate/infrastructure/task-authorization-file.js';
import { BaselineRunAdmission } from './run/application/baseline-run-admission.js';
import { TaskRunObservations } from './run/application/task-run-observation.js';
import { VerifiedCalibrationCampaignProgress } from './run/application/calibration-campaign-progress.js';
import { FileCalibrationCampaignRecords } from './run/infrastructure/file-calibration-campaign-records.js';
import { BaselineRunSupervisorComposition } from './run/composition/baseline-run-supervisor.js';
import { LinuxRunSupervisorComposition } from './run/composition/linux-run-supervisor.js';
import { TaskTerminalVerificationComposition } from './run/composition/task-terminal-verification.js';
import { resumeLocalTask } from './run/composition/local-task-resumption.js';
import { TerminalCalibrationComposition } from './run/composition/terminal-calibration.js';
import { GitLinuxH1PreLease } from './run/infrastructure/git-linux-h1-prelease.js';
import {
  loadLinuxH1ProfileBundle,
  type LinuxH1ProfileBundle,
} from './run/infrastructure/linux-h1-profile-file.js';
import { EnvironmentPiCredential } from './run/infrastructure/pi-credential-environment.js';
import { managedWorktreeCapabilities } from './run/infrastructure/managed-worktree-tools.js';
import { PreparedCompatibilityCampaignFile } from './run/infrastructure/prepared-compatibility-campaign-file.js';
import { RunAdmissionFile } from './run/infrastructure/run-admission-file.js';
import {
  createProgram,
  type BrowserPresentation,
  type CliProcess,
  type DevrandomCommands,
  type SourceInventoryCommandOutcome,
} from './program.js';
import { CurrentTaskAuthority, UserTasks } from './task/application/user-tasks.js';
import {
  TaskRunExecution,
  type TaskRunExecutionOutcome,
} from './task/application/task-run-execution.js';
import { TaskRunPreparation } from './task/application/task-run-preparation.js';
import { GitTaskRepository } from './task/infrastructure/git-task-repository.js';
import { JsonTaskFile } from './task/infrastructure/task-file.js';

const cliProcess: CliProcess = {
  write: (value) => process.stdout.write(value),
  writeError: (value) => process.stderr.write(value),
  setExitCode: (value) => {
    process.exitCode = value;
  },
  watchInterruption: () => {
    const controller = new AbortController();
    const interrupt = (): void => {
      controller.abort();
    };
    process.once('SIGINT', interrupt);
    return {
      signal: controller.signal,
      release: () => {
        process.off('SIGINT', interrupt);
      },
    };
  },
};

function identityApplication(presentation: BrowserPresentation): UserIdentityApplication {
  const configuration = loadUserIdentityConfiguration(userIdentityEnvironment(process.env));
  const presentBrowserUrl = async (url: string): Promise<void> => {
    if (presentation === 'PrintBrowserUrl') {
      cliProcess.write(`Registration URL: ${url}\n`);
      return;
    }
    try {
      await openSystemBrowser(url);
    } catch {
      cliProcess.writeError('The system browser could not be opened.\n');
      cliProcess.write(`Registration URL: ${url}\n`);
    }
  };
  return new UserIdentityApplication(
    configuration,
    new IdentityFiles(configuration.stateDirectory),
    new IssuerRegistrationHttp(configuration.issuerUrl),
    { ...userIdentityDefaults, presentBrowserUrl },
  );
}

let commandTaskAuthority: CurrentTaskAuthority | undefined;

function currentTaskAuthority(): CurrentTaskAuthority {
  if (commandTaskAuthority === undefined) {
    const configuration = loadUserIdentityConfiguration(userIdentityEnvironment(process.env));
    commandTaskAuthority = new CurrentTaskAuthority(
      identityApplication('PrintBrowserUrl'),
      configuration.issuerUrl,
    );
  }
  return commandTaskAuthority;
}

function userTasks(): UserTasks {
  return new UserTasks({
    protectedCredentials: new ProtectedCredentials([process.env.CONCENTRATE_API_KEY ?? '']),
    documents: new JsonTaskFile(),
    repository: new GitTaskRepository(process.cwd()),
    authority: currentTaskAuthority(),
    newCommandId: randomUUID,
    wait: (milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
  });
}

function taskRunPreparation(linux?: LinuxH1ProfileBundle): TaskRunPreparation {
  const configuration = loadUserIdentityConfiguration(userIdentityEnvironment(process.env));
  const authority = currentTaskAuthority();
  return new TaskRunPreparation({
    authority,
    localMandates: new AuthorizedLocalTaskMandates({
      local: currentLocalMandates(),
      records: new TaskAuthorizationFile(join(configuration.stateDirectory, 'task-authorizations')),
      issuerAid: configuration.issuerAid,
      userAlias: devrandomUserAlias,
      now: () => Date.now(),
      wait: (milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
      maximumObservations: 300,
    }),
    localHarness: new BaselineHarnessPreparation({
      modelCredential: new EnvironmentPiCredential({
        CONCENTRATE_API_KEY: process.env.CONCENTRATE_API_KEY,
      }),
      availableCapabilities: managedWorktreeCapabilities,
      repository: new GitHarnessInspection(
        process.cwd(),
        linux === undefined
          ? new HostHarnessExecutionInventory(process.cwd())
          : new DockerCargoExecutionInventory({
              profile: linux.profile,
              image: linux.image,
              runtimeMounts: linux.runtimeMounts,
              worktreeDirectory: process.cwd(),
              cargoRealpath: linux.cargoRealpath,
            }),
      ),
      model: new EnvironmentPiModelInspection({
        DEVRANDOM_MODEL_PROVIDER: process.env.DEVRANDOM_MODEL_PROVIDER,
        DEVRANDOM_MODEL_ID: process.env.DEVRANDOM_MODEL_ID,
        DEVRANDOM_MODEL_THINKING_LEVEL: process.env.DEVRANDOM_MODEL_THINKING_LEVEL,
        DEVRANDOM_MODEL_MAX_OUTPUT_TOKENS: process.env.DEVRANDOM_MODEL_MAX_OUTPUT_TOKENS,
        DEVRANDOM_MODEL_CREDENTIAL_SOURCE: process.env.DEVRANDOM_MODEL_CREDENTIAL_SOURCE,
      }),
      admissions: new BaselineHarnessAdmissionFile(
        join(configuration.stateDirectory, 'harness-admissions'),
      ),
      wait: (milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
    }),
    ...(linux === undefined
      ? {}
      : { preLeaseProfile: new GitLinuxH1PreLease(process.cwd(), linux) }),
    localRun: new BaselineRunAdmission({
      records: new RunAdmissionFile(join(configuration.stateDirectory, 'run-admissions')),
      issuerAid: configuration.issuerAid,
      newCommandId: randomUUID,
      newIncarnationId: randomUUID,
      now: () => Date.now(),
      monotonicNow: () => performance.now(),
      wait: (milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
      maximumObservations: 300,
    }),
  });
}

function currentLocalMandates(): SignifyLocalMandateAuthority {
  const configuration = loadUserIdentityConfiguration(userIdentityEnvironment(process.env));
  return new SignifyLocalMandateAuthority(
    configuration,
    loadMandateConfiguration(mandateEnvironment(process.env)),
    new IdentityFiles(configuration.stateDirectory),
    new GovernanceProfileFile(configuration.stateDirectory),
  );
}

const said = /^[A-Z][A-Za-z0-9_-]{43}$/u;

async function progressH0Command(
  label: string,
  originRunId: string,
  policyPath: string,
  reviewArtifactSaid: string,
  configurationSaid: string,
  nonTreatmentInputsSaid: string,
  signal: AbortSignal,
): Promise<QualifiedH0ProgressOutcome> {
  if (
    !said.test(reviewArtifactSaid) ||
    !said.test(configurationSaid) ||
    !said.test(nonTreatmentInputsSaid)
  )
    return { kind: 'Blocked', gate: 'ReviewCustody' };
  const policyReading = await new EvaluationPolicyFile().read(policyPath);
  if (policyReading.kind !== 'Read' || policyReading.policy.originRunId !== originRunId)
    return { kind: 'Blocked', gate: 'Policy' };
  const authority = await currentTaskAuthority().acquireHostedWork();
  if (authority.kind !== 'Authorized') return { kind: 'Blocked', gate: 'Authority' };
  const inspection = await authority.tasks.inspect(label);
  if (
    inspection.kind !== 'Inspected' ||
    inspection.task.ownerAid !== authority.user.principal.aid ||
    inspection.task.taskId !== policyReading.policy.taskId ||
    inspection.task.revisionSaid !== policyReading.policy.taskRevisionSaid
  )
    return { kind: 'Blocked', gate: 'Authority' };
  if (!authority.contextReady()) return { kind: 'Blocked', gate: 'Authority' };
  const configuration = loadUserIdentityConfiguration(userIdentityEnvironment(process.env));
  const stateRoot = configuration.stateDirectory;
  return progressQualifiedH0(
    {
      qualification: {
        task: inspection.task,
        originRunId,
        executionProfileSaid: policyReading.policy.executionProfileSaid,
        expectedActiveRevisionSaid: policyReading.policy.expectedActiveRevisionSaid,
        runs: authority.runs,
        evidence: authority.evidence,
        signal,
      },
      reviewArtifactSaids: [reviewArtifactSaid],
      configurationSaid,
      nonTreatmentInputsSaid,
    },
    {
      qualification: new VerifiedFailureCampaign(
        new PreparedCompatibilityCampaignHistoryFile(stateRoot),
      ),
      history: new PreparedCompatibilityCampaignHistoryFile(stateRoot),
      mandate: new SignifyCurrentExperienceMandate({
        task: inspection.task,
        user: authority.user,
        records: new TaskAuthorizationFile(join(stateRoot, 'task-authorizations')),
        local: currentLocalMandates(),
        now: () => new Date().toISOString(),
      }),
      policy: new ReviewedComparisonPlanFile(policyPath),
      reviews: new FilePublicAnalogyReviews(join(stateRoot, 'public-analogy-reviews')),
      commands: new EvaluationCommandFile(join(stateRoot, 'evaluation-commands'), randomUUID),
      hosted: authority.evaluations,
      context: { open: (inventory) => authority.context(inventory) },
      records: new FileQualifiedH0Records(join(stateRoot, 'qualified-h0-records')),
    },
  );
}

async function recordSourceInventoryCommand(
  label: string,
  originRunId: string,
  executionProfileSaid: string,
  expectedActiveRevisionSaid: string,
  outputDirectory: string,
  signal: AbortSignal,
): Promise<SourceInventoryCommandOutcome> {
  if (!said.test(executionProfileSaid) || !said.test(expectedActiveRevisionSaid))
    return { kind: 'Blocked', gate: 'Qualification' };
  const authority = await currentTaskAuthority().acquireHostedWork();
  if (authority.kind !== 'Authorized') return { kind: 'Blocked', gate: 'Authority' };
  const inspection = await authority.tasks.inspect(label);
  if (inspection.kind !== 'Inspected' || inspection.task.ownerAid !== authority.user.principal.aid)
    return { kind: 'Blocked', gate: 'Authority' };
  const stateRoot = loadUserIdentityConfiguration(
    userIdentityEnvironment(process.env),
  ).stateDirectory;
  const history = new PreparedCompatibilityCampaignHistoryFile(stateRoot);
  const prepared = await prepareQualifiedSourceInventory(
    {
      task: inspection.task,
      originRunId,
      executionProfileSaid,
      expectedActiveRevisionSaid,
      runs: authority.runs,
      evidence: authority.evidence,
      signal,
    },
    {
      qualification: new VerifiedFailureCampaign(history),
      history,
      mandate: new SignifyCurrentExperienceMandate({
        task: inspection.task,
        user: authority.user,
        records: new TaskAuthorizationFile(join(stateRoot, 'task-authorizations')),
        local: currentLocalMandates(),
        now: () => new Date().toISOString(),
      }),
    },
  );
  if (prepared.kind !== 'Prepared') return prepared;
  const recorded = await new QualifiedSourceInventoryFile(outputDirectory).commit(
    prepared.inventory,
  );
  return recorded.kind === 'Recorded' ? recorded : { kind: 'Blocked', gate: 'Inventory' };
}

function taskRunExecution(): TaskRunExecution {
  const configuration = loadUserIdentityConfiguration(userIdentityEnvironment(process.env));
  const bundlePath = process.env.DEVRANDOM_LINUX_H1_BUNDLE;
  const linux = bundlePath === undefined ? undefined : loadLinuxH1ProfileBundle(bundlePath);
  const supervisionOptions = {
    stateRoot: configuration.stateDirectory,
    repositoryDirectory: process.cwd(),
    issuerAid: configuration.issuerAid,
    modelCredential: new EnvironmentPiCredential({
      CONCENTRATE_API_KEY: process.env.CONCENTRATE_API_KEY,
    }),
    childEnvironment: {
      path: process.env.PATH ?? '',
      language: 'C' as const,
    },
    now: () => new Date().toISOString(),
    sessionId: randomUUID,
    modelTurnId: randomUUID,
    wait: (milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
  };
  return new TaskRunExecution({
    history: new VerifiedCalibrationCampaignProgress({
      authority: currentTaskAuthority(),
      admissions: new RunAdmissionFile(join(configuration.stateDirectory, 'run-admissions')),
      records: new FileCalibrationCampaignRecords(configuration.stateDirectory),
      now: () => Date.now(),
    }),
    campaigns: {
      acquire: (taskLabel) =>
        new PreparedCompatibilityCampaignFile(
          join(
            configuration.stateDirectory,
            'calibration-campaigns',
            encodeURIComponent(taskLabel),
          ),
          randomUUID,
        ).acquire(taskLabel),
    },
    preparation: taskRunPreparation(linux),
    supervision:
      linux === undefined
        ? new BaselineRunSupervisorComposition(supervisionOptions)
        : new LinuxRunSupervisorComposition({
            ...supervisionOptions,
            linux: {
              profile: linux.profile,
              image: linux.image,
              runtimeMounts: linux.runtimeMounts,
              effectiveLimitsReceipt: linux.effectiveLimitsReceipt,
              parentDeathCleanupReceipt: linux.parentDeathCleanupReceipt,
            },
          }),
  });
}

async function runTask(label: string, signal: AbortSignal): Promise<TaskRunExecutionOutcome> {
  const outcome = await taskRunExecution().run(label, signal);
  if (outcome.kind !== 'CalibrationRecoveryRequired' || signal.aborted) return outcome;
  const configuration = loadUserIdentityConfiguration(userIdentityEnvironment(process.env));
  const authority = await currentTaskAuthority().acquireHostedWork();
  if (authority.kind !== 'Authorized') return outcome;
  const inspected = await authority.tasks.inspect(label);
  if (inspected.kind !== 'Inspected') return outcome;
  const hosted = await authority.runs.inspect(outcome.runId);
  if (hosted.kind !== 'Found') return outcome;
  const harness = await new BaselineHarnessAdmissionFile(
    join(configuration.stateDirectory, 'harness-admissions'),
  ).readAccepted({
    taskId: inspected.task.taskId,
    taskRevisionSaid: inspected.task.revisionSaid,
    harnessSaid: hosted.run.harnessRevisionSaid,
  });
  if (harness.kind !== 'Read') return outcome;
  const mandates = await new AuthorizedLocalTaskMandates({
    local: currentLocalMandates(),
    records: new TaskAuthorizationFile(join(configuration.stateDirectory, 'task-authorizations')),
    issuerAid: configuration.issuerAid,
    userAlias: devrandomUserAlias,
    now: () => Date.now(),
    wait: (milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
    maximumObservations: 300,
  }).prepare({
    user: authority.user,
    task: inspected.task,
    presentations: authority.presentations,
    grantExpiresAt: authority.grantExpiresAt,
  });
  if (mandates.kind !== 'Prepared') return outcome;
  const reconciled = await new TerminalCalibrationComposition({
    stateRoot: configuration.stateDirectory,
    issuerAid: configuration.issuerAid,
    now: () => new Date().toISOString(),
    wait: (milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
  }).reconcile(
    {
      user: authority.user,
      task: inspected.task,
      harness: harness.projection.revision,
      mandates,
      protectedCredentials: authority.protectedCredentials,
      runId: outcome.runId,
      runs: authority.runs,
      evidence: authority.evidence,
    },
    signal,
  );
  return reconciled.kind === 'Reconciled'
    ? taskRunExecution().run(label, signal)
    : { ...outcome, reconciliation: reconciled.kind };
}

function taskRunObservations(): TaskRunObservations {
  const configuration = loadUserIdentityConfiguration(userIdentityEnvironment(process.env));
  return new TaskRunObservations({
    authority: currentTaskAuthority(),
    admissions: new RunAdmissionFile(join(configuration.stateDirectory, 'run-admissions')),
    now: () => Date.now(),
    wait: (milliseconds, signal) =>
      new Promise((resolve) => {
        const elapsed = (): void => {
          signal.removeEventListener('abort', interrupted);
          resolve({ kind: 'Elapsed' });
        };
        const timer = setTimeout(elapsed, milliseconds);
        const interrupted = (): void => {
          clearTimeout(timer);
          resolve({ kind: 'Interrupted' });
        };
        if (signal.aborted) {
          interrupted();
        } else {
          signal.addEventListener('abort', interrupted, { once: true });
        }
      }),
  });
}

const commands: DevrandomCommands = {
  status: async () => {
    const configuration = loadUserIdentityConfiguration(userIdentityEnvironment(process.env));
    const health = new IssuerHealthHttp(configuration.issuerUrl);
    return verifyDemoIssuer(configuration, () => health.observe());
  },
  initialize: (presentation) => identityApplication(presentation).initialize(),
  whoami: () => identityApplication('PrintBrowserUrl').whoami(),
  rotate: () => identityApplication('PrintBrowserUrl').rotate(),
  tasks: {
    resume: async (label, runId, pauseAfterCheckpoint, signal) => {
      const configuration = loadUserIdentityConfiguration(userIdentityEnvironment(process.env));
      const bundlePath = process.env.DEVRANDOM_LINUX_H1_BUNDLE;
      if (bundlePath === undefined) return { kind: 'Blocked', gate: 'ExecutionProfile' };
      const linux = loadLinuxH1ProfileBundle(bundlePath);
      const hosted = await currentTaskAuthority().acquireHostedWork();
      if (hosted.kind !== 'Authorized') return { kind: 'Blocked', gate: 'Authority' };
      const inspected = await hosted.tasks.inspect(label);
      if (inspected.kind !== 'Inspected') return { kind: 'Blocked', gate: 'Task' };
      return resumeLocalTask({
        stateRoot: configuration.stateDirectory,
        issuerAid: configuration.issuerAid,
        hosted,
        local: currentLocalMandates(),
        task: inspected.task,
        runId,
        linux,
        pauseAfterCheckpoint,
        signal,
      });
    },
    verify: async (label, runId, signal) => {
      const configuration = loadUserIdentityConfiguration(userIdentityEnvironment(process.env));
      const hosted = await currentTaskAuthority().acquireHostedWork();
      if (hosted.kind !== 'Authorized') return { kind: 'Unavailable' };
      const inspected = await hosted.tasks.inspect(label);
      if (inspected.kind !== 'Inspected') return { kind: 'Rejected' };
      return new TaskTerminalVerificationComposition(configuration.stateDirectory).verify(
        {
          ownerAid: hosted.user.principal.aid,
          task: inspected.task,
          runId,
          runs: hosted.runs,
          evidence: hosted.evidence,
          protectedCredentials: hosted.protectedCredentials,
        },
        signal,
      );
    },
    create: (path) => userTasks().create(path),
    list: () => userTasks().list(),
    inspect: (label) => userTasks().inspect(label),
    run: (label, signal) => runTask(label, signal),
    status: (label) => taskRunObservations().status(label),
    watch: (label, signal) => taskRunObservations().watch(label, signal),
  },
  harness: {
    publish: async (label, evaluationId, commandId, signal) => {
      const configuration = loadUserIdentityConfiguration(userIdentityEnvironment(process.env));
      const hosted = await currentTaskAuthority().acquireHostedWork();
      if (hosted.kind !== 'Authorized') return { kind: 'Unavailable' };
      const inspected = await hosted.tasks.inspect(label);
      if (inspected.kind !== 'Inspected') return { kind: 'Rejected' };
      return publishLocalHarness({
        stateRoot: configuration.stateDirectory,
        identity: configuration,
        custodyFiles: new IdentityFiles(configuration.stateDirectory),
        hosted,
        task: inspected.task,
        evaluationId,
        commandId,
        signal,
      });
    },
    fetch: async (packageSaid, publisherOobi, signal) => {
      const configuration = loadUserIdentityConfiguration(userIdentityEnvironment(process.env));
      const origin = decodeDevrandomServerOrigin(configuration.issuerUrl);
      if (origin.kind !== 'Accepted') return { kind: 'Rejected' };
      return fetchPublishedHarness({
        stateRoot: configuration.stateDirectory,
        identity: configuration,
        custodyFiles: new IdentityFiles(configuration.stateDirectory),
        serverOrigin: origin.origin,
        packageSaid,
        publisherOobi,
        signal,
      });
    },
    fork: async (packageSaid, publisherOobi, commandId, signal) => {
      const configuration = loadUserIdentityConfiguration(userIdentityEnvironment(process.env));
      const origin = decodeDevrandomServerOrigin(configuration.issuerUrl);
      if (origin.kind !== 'Accepted') return { kind: 'Rejected' };
      return forkPublishedHarness({
        stateRoot: configuration.stateDirectory,
        identity: configuration,
        custodyFiles: new IdentityFiles(configuration.stateDirectory),
        serverOrigin: origin.origin,
        packageSaid,
        publisherOobi,
        commandId,
        signal,
      });
    },
    promote: async (label, evaluationId, closureSaid, commandId, manifestSaid, signal) => {
      const configuration = loadUserIdentityConfiguration(userIdentityEnvironment(process.env));
      const hosted = await currentTaskAuthority().acquireHostedWork();
      if (hosted.kind !== 'Authorized') return { kind: 'Blocked', gate: 'Authority' };
      const inspection = await hosted.tasks.inspect(label);
      if (inspection.kind !== 'Inspected') return { kind: 'Blocked', gate: 'Authority' };
      return promoteLocalEvaluation({
        stateRoot: configuration.stateDirectory,
        issuerAid: configuration.issuerAid,
        hosted,
        local: currentLocalMandates(),
        task: inspection.task,
        evaluationId,
        closureSaid,
        commandId,
        confirmation: { manifestSaid, closureSaid },
        signal,
      });
    },
    evaluate: async (label, originRunId, policyPath, signal) => {
      const identity = loadUserIdentityConfiguration(userIdentityEnvironment(process.env));
      const bundlePath = process.env.DEVRANDOM_LINUX_H1_BUNDLE;
      if (bundlePath === undefined) return { kind: 'Blocked', gate: 'ExecutionProfile' };
      const linux = loadLinuxH1ProfileBundle(bundlePath);
      const hosted = await currentTaskAuthority().acquireHostedWork();
      if (hosted.kind !== 'Authorized') return { kind: 'Blocked', gate: 'Authority' };
      const inspected = await hosted.tasks.inspect(label);
      if (inspected.kind !== 'Inspected') return { kind: 'Blocked', gate: 'Task' };
      return evaluateLocalHarness({
        stateRoot: identity.stateDirectory,
        hosted,
        local: currentLocalMandates(),
        task: inspected.task,
        policyPath,
        originRunId,
        repositoryDirectory: process.cwd(),
        linux,
        identity,
        signal,
        modelCredentialEnvironment: { CONCENTRATE_API_KEY: process.env.CONCENTRATE_API_KEY },
      });
    },
    progressH0: progressH0Command,
    recordSourceInventory: recordSourceInventoryCommand,
    resumeManifest: async (evaluationId) => {
      const configuration = loadUserIdentityConfiguration(userIdentityEnvironment(process.env));
      const authorized = await currentTaskAuthority().acquireHostedWork();
      if (authorized.kind !== 'Authorized') return { kind: 'Unavailable' };
      return reconcileStagedCesrManifest(evaluationId, authorized.user.principal.aid, {
        commands: new EvaluationManifestCommandFile(
          join(configuration.stateDirectory, 'evaluation-manifests'),
          randomUUID,
        ),
        cases: new SqliteCesrComparisonCases(configuration.stateDirectory),
        hosted: authorized.evaluations,
      });
    },
  },
};

try {
  await createProgram(commands, cliProcess).parseAsync(process.argv);
} catch (cause) {
  cliProcess.writeError(
    cause instanceof Error ? `devrandom: ${cause.message}\n` : 'devrandom: command failed\n',
  );
  cliProcess.setExitCode(1);
} finally {
  const release = await commandTaskAuthority?.releaseHeldGrants();
  if (release?.kind === 'ReleaseUnavailable') {
    cliProcess.writeError(
      `Work Access release is uncertain for ${String(release.attemptIds.length)} grant(s); capacity may remain occupied until expiry.\n`,
    );
    if (process.exitCode === undefined || process.exitCode === 0) {
      cliProcess.setExitCode(5);
    }
  }
}
