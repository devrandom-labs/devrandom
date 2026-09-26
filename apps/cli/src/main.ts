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
import { HostHarnessExecutionInventory } from './harness/infrastructure/host-harness-execution-inventory.js';
import { EnvironmentPiModelInspection } from './harness/infrastructure/model-profile-environment.js';
import { HarnessEvaluation } from './harness/application/harness-evaluation.js';
import { VerifiedFailureCampaign } from './harness/application/verified-failure-campaign.js';
import { EvaluationCommandFile } from './harness/infrastructure/evaluation-command-file.js';
import { EvaluationPolicyFile } from './harness/infrastructure/evaluation-policy-file.js';
import { PreparedCompatibilityCampaignHistoryFile } from './harness/infrastructure/prepared-compatibility-campaign-history.js';
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
import { BaselineRunSupervisorComposition } from './run/composition/baseline-run-supervisor.js';
import { EnvironmentPiCredential } from './run/infrastructure/pi-credential-environment.js';
import { managedWorktreeCapabilities } from './run/infrastructure/managed-worktree-tools.js';
import { PreparedCompatibilityCampaignFile } from './run/infrastructure/prepared-compatibility-campaign-file.js';
import { RunAdmissionFile } from './run/infrastructure/run-admission-file.js';
import {
  createProgram,
  type BrowserPresentation,
  type CliProcess,
  type DevrandomCommands,
} from './program.js';
import { CurrentTaskAuthority, UserTasks } from './task/application/user-tasks.js';
import { TaskRunExecution } from './task/application/task-run-execution.js';
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

function taskRunPreparation(): TaskRunPreparation {
  const configuration = loadUserIdentityConfiguration(userIdentityEnvironment(process.env));
  const files = new IdentityFiles(configuration.stateDirectory);
  const authority = currentTaskAuthority();
  const local = new SignifyLocalMandateAuthority(
    configuration,
    loadMandateConfiguration(mandateEnvironment(process.env)),
    files,
    new GovernanceProfileFile(configuration.stateDirectory),
  );
  return new TaskRunPreparation({
    authority,
    localMandates: new AuthorizedLocalTaskMandates({
      local,
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
        new HostHarnessExecutionInventory(process.cwd()),
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

function taskRunExecution(): TaskRunExecution {
  const configuration = loadUserIdentityConfiguration(userIdentityEnvironment(process.env));
  return new TaskRunExecution({
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
    preparation: taskRunPreparation(),
    supervision: new BaselineRunSupervisorComposition({
      stateRoot: configuration.stateDirectory,
      repositoryDirectory: process.cwd(),
      issuerAid: configuration.issuerAid,
      modelCredential: new EnvironmentPiCredential({
        CONCENTRATE_API_KEY: process.env.CONCENTRATE_API_KEY,
      }),
      childEnvironment: {
        path: process.env.PATH ?? '',
        language: 'C',
      },
      now: () => new Date().toISOString(),
      sessionId: randomUUID,
      modelTurnId: randomUUID,
      wait: (milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
    }),
  });
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

function harnessEvaluation(): HarnessEvaluation {
  const configuration = loadUserIdentityConfiguration(userIdentityEnvironment(process.env));
  return new HarnessEvaluation({
    policy: new EvaluationPolicyFile(),
    authority: {
      acquire: async () => {
        const authority = await currentTaskAuthority().acquireHostedWork();
        return authority.kind === 'Authorized'
          ? {
              kind: 'Authorized',
              ownerAid: authority.user.principal.aid,
              tasks: authority.tasks,
              runs: authority.runs,
              evidence: authority.evidence,
              evaluations: authority.evaluations,
            }
          : { kind: 'Unavailable' };
      },
    },
    qualification: new VerifiedFailureCampaign(
      new PreparedCompatibilityCampaignHistoryFile(configuration.stateDirectory),
    ),
    commands: new EvaluationCommandFile(
      join(configuration.stateDirectory, 'evaluation-commands'),
      randomUUID,
    ),
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
    create: (path) => userTasks().create(path),
    list: () => userTasks().list(),
    inspect: (label) => userTasks().inspect(label),
    run: (label, signal) => taskRunExecution().run(label, signal),
    status: (label) => taskRunObservations().status(label),
    watch: (label, signal) => taskRunObservations().watch(label, signal),
  },
  harness: {
    evaluate: (label, runId, policyPath, signal) =>
      harnessEvaluation().evaluate(label, runId, policyPath, signal),
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
