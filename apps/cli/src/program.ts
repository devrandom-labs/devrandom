import type { AdmittedUser, Run } from '@devrandom/domain';
import type { RunStopCause, RunSupervision } from '@devrandom/runtime';
import { Command } from 'commander';
import Type from 'typebox';
import Value from 'typebox/value';

import type { DemoIssuerCompatibility } from './identity/application/demo-issuer-compatibility.js';
import type { UserIdentityOutcome } from './identity/application/user-identity.js';
import type { TaskCreation, TaskInspection, TaskListing } from './task/application/user-tasks.js';
import type { TaskRunExecutionOutcome } from './task/application/task-run-execution.js';
import type { WorkAccessAcquisition } from './work-access/application/work-access-acquisition.js';
import type { HarnessEvaluationOutcome } from './harness/application/harness-evaluation.js';
import type {
  TaskRunObservationFailure,
  TaskRunStatus,
  TaskRunStatusObservation,
  TaskRunWatchObservation,
} from './run/application/task-run-observation.js';
import type { HostedRunFailure } from './run/application/baseline-run-admission.js';
import type { HostedEvidenceFailure } from './run/application/evidence-delivery.js';
import type { HostedTaskFailure } from './task/application/user-tasks.js';

export type BrowserPresentation = 'OpenSystemBrowser' | 'PrintBrowserUrl';

export interface UserIdentityCommands {
  status(): Promise<DemoIssuerCompatibility>;
  initialize(presentation: BrowserPresentation): Promise<UserIdentityOutcome>;
  whoami(): Promise<UserIdentityOutcome>;
  rotate(): Promise<UserIdentityOutcome>;
}

export interface TaskCommands {
  create(path: string): Promise<TaskCreation>;
  list(): Promise<TaskListing>;
  inspect(label: string): Promise<TaskInspection>;
  run(label: string, signal: AbortSignal): Promise<TaskRunExecutionOutcome>;
  status(label: string): Promise<TaskRunStatusObservation>;
  watch(label: string, signal: AbortSignal): AsyncIterable<TaskRunWatchObservation>;
}

export interface DevrandomCommands extends UserIdentityCommands {
  readonly tasks: TaskCommands;
  readonly harness: {
    evaluate(
      label: string,
      fromRunId: string,
      policyPath: string,
      signal: AbortSignal,
    ): Promise<HarnessEvaluationOutcome>;
  };
}

export interface CliProcess {
  write(value: string): void;
  writeError(value: string): void;
  setExitCode(value: number): void;
  watchInterruption(): {
    readonly signal: AbortSignal;
    release(): void;
  };
}

const initOptionsSchema = Type.Object({ open: Type.Boolean() }, { additionalProperties: false });

interface RenderedCommand {
  readonly destination: 'stdout' | 'stderr';
  readonly exitCode: number;
  readonly text: string;
}

export function createProgram(commands: DevrandomCommands, cliProcess: CliProcess): Command {
  const program = new Command()
    .name('devrandom')
    .description('Devrandom governed harness evolution')
    .version('0.0.0');

  program
    .command('status')
    .description('Verify the live services match the CLI demonstration identity')
    .action(async () => runStatusCommand(commands.status(), cliProcess));

  program
    .command('init')
    .description('Create or recover and verify the local Devrandom user identity')
    .option('--no-open', 'print the registration URL instead of opening a browser')
    .action(async (options: unknown) => {
      if (!Value.Check(initOptionsSchema, options)) {
        throw new Error('Commander produced invalid init options');
      }
      await runIdentityCommand(
        commands.initialize(options.open ? 'OpenSystemBrowser' : 'PrintBrowserUrl'),
        cliProcess,
      );
    });

  program
    .command('whoami')
    .description('Re-verify and report the current Devrandom user identity')
    .action(async () => runIdentityCommand(commands.whoami(), cliProcess));

  const identity = program.command('identity').description('Operate on the local user identity');
  identity
    .command('rotate')
    .description('Explicitly rotate user-AID keys while preserving the user AID')
    .action(async () => runIdentityCommand(commands.rotate(), cliProcess));

  const task = program.command('task').description('Create and inspect authenticated Tasks');
  task
    .command('create')
    .description('Create one Task from a closed versioned JSON file')
    .argument('<file>')
    .action(async (path: string) => runTaskCommand(commands.tasks.create(path), cliProcess));
  task
    .command('list')
    .description('List the authenticated user’s Tasks')
    .action(async () => runTaskCommand(commands.tasks.list(), cliProcess));
  task
    .command('inspect')
    .description('Inspect one authenticated Task by owner-scoped label')
    .argument('<label>')
    .action(async (label: string) => runTaskCommand(commands.tasks.inspect(label), cliProcess));
  task
    .command('run')
    .description('Prepare exact local authority and start one governed Task Run')
    .argument('<label>')
    .action(async (label: string) => {
      const interruption = cliProcess.watchInterruption();
      try {
        await runTaskRunCommand(commands.tasks.run(label, interruption.signal), cliProcess);
      } finally {
        interruption.release();
      }
    });
  task
    .command('status')
    .description('Inspect one Task and its authoritative durable Run state')
    .argument('<label>')
    .action(async (label: string) =>
      runTaskStatusCommand(commands.tasks.status(label), cliProcess),
    );
  task
    .command('watch')
    .description('Poll one bounded authenticated Task Run timeline')
    .argument('<label>')
    .action(async (label: string) => {
      const interruption = cliProcess.watchInterruption();
      try {
        await runTaskWatchCommand(commands.tasks.watch(label, interruption.signal), cliProcess);
      } finally {
        interruption.release();
      }
    });

  const harness = program.command('harness').description('Inspect and evaluate harness revisions');
  harness
    .command('evaluate')
    .description('Evaluate a verified retained failure under a closed policy')
    .argument('<label>')
    .requiredOption('--from-run <run-id>', 'the verified sixth retained Run ID')
    .requiredOption('--policy <file>', 'the closed evaluation policy JSON file')
    .action(async (label: string, options: { fromRun: string; policy: string }) => {
      const interruption = cliProcess.watchInterruption();
      try {
        const outcome = await commands.harness.evaluate(
          label,
          options.fromRun,
          options.policy,
          interruption.signal,
        );
        writeRenderedCommand(renderHarnessEvaluation(outcome), cliProcess);
      } finally {
        interruption.release();
      }
    });

  return program;
}

function renderHarnessEvaluation(outcome: HarnessEvaluationOutcome): RenderedCommand {
  switch (outcome.kind) {
    case 'Blocked':
      return {
        destination: 'stderr',
        exitCode: 6,
        text:
          outcome.gate === 'ProtectedCases'
            ? `Evaluation ${outcome.evaluationId} admitted; protected cases and M are not locked. No trial started.`
            : `Evaluation blocked: ${outcome.gate}.`,
      };
    case 'InvalidInput':
      return {
        destination: 'stderr',
        exitCode: 2,
        text: `Evaluation input invalid: ${outcome.reason}.`,
      };
    case 'Unavailable':
      return {
        destination: 'stderr',
        exitCode: 5,
        text: `Evaluation unavailable: ${outcome.reason}.`,
      };
    case 'Interrupted':
      return { destination: 'stderr', exitCode: 130, text: 'Evaluation interrupted.' };
  }
}

async function runTaskRunCommand(
  pending: Promise<TaskRunExecutionOutcome>,
  cliProcess: CliProcess,
): Promise<void> {
  const rendered = renderTaskRunExecution(await pending);
  if (rendered.destination === 'stdout') {
    cliProcess.write(`${rendered.text}\n`);
  } else {
    cliProcess.writeError(`${rendered.text}\n`);
  }
  cliProcess.setExitCode(rendered.exitCode);
}

async function runTaskStatusCommand(
  pending: Promise<TaskRunStatusObservation>,
  cliProcess: CliProcess,
): Promise<void> {
  const rendered = renderTaskRunObservation(await pending, 'Task Run Status');
  writeRenderedCommand(rendered, cliProcess);
}

async function runTaskWatchCommand(
  observations: AsyncIterable<TaskRunWatchObservation>,
  cliProcess: CliProcess,
): Promise<void> {
  let finalExitCode: number | undefined;
  for await (const observation of observations) {
    const rendered = renderTaskRunObservation(observation, 'Task Run Timeline');
    if (rendered.destination === 'stdout') {
      cliProcess.write(`${rendered.text}\n`);
    } else {
      cliProcess.writeError(`${rendered.text}\n`);
    }
    finalExitCode = rendered.exitCode;
  }
  if (finalExitCode === undefined) {
    cliProcess.writeError('Task Run watch ended without an observation.\n');
    cliProcess.setExitCode(6);
    return;
  }
  cliProcess.setExitCode(finalExitCode);
}

function writeRenderedCommand(rendered: RenderedCommand, cliProcess: CliProcess): void {
  if (rendered.destination === 'stdout') {
    cliProcess.write(`${rendered.text}\n`);
  } else {
    cliProcess.writeError(`${rendered.text}\n`);
  }
  cliProcess.setExitCode(rendered.exitCode);
}

function renderTaskRunObservation(
  observation: TaskRunStatusObservation | TaskRunWatchObservation,
  heading: 'Task Run Status' | 'Task Run Timeline',
): RenderedCommand {
  if (observation.kind === 'Observed') {
    const timeline =
      'events' in observation
        ? [
            'Timeline events:',
            ...(observation.events.length === 0
              ? ['No new evidence events.']
              : observation.events.map(
                  ({ event, receivedAt }) =>
                    `${String(event.sequence)}\t${event.d}\t${event.event.kind}\t${event.producer.kind}\t${receivedAt}`,
                )),
          ]
        : [];
    return {
      destination: 'stdout',
      exitCode: 0,
      text: [heading, ...taskRunStatusLines(observation.status), ...timeline].join('\n'),
    };
  }
  return renderTaskRunObservationFailure(observation);
}

function taskRunStatusLines(status: TaskRunStatus): readonly string[] {
  const task = status.task;
  const run = status.run;
  const stream = status.stream;
  const lease =
    run.lease.kind === 'Held'
      ? [
          `Run incarnation ID: ${run.lease.incarnationId}`,
          `Run lease acquired at: ${run.lease.acquiredAt}`,
          `Run lease expires at: ${run.lease.expiresAt}`,
        ]
      : ['Run incarnation lease: Unassigned'];
  const cursor =
    stream.cursor.kind === 'Accepted'
      ? [
          `Evidence event count: ${String(stream.cursor.eventCount)}`,
          `Evidence accepted through sequence: ${String(stream.cursor.acceptedThroughSequence)}`,
          `Evidence chain head SAID: ${stream.cursor.chainHeadSaid}`,
        ]
      : ['Evidence cursor: Empty'];
  const checkpoint =
    stream.checkpoint.kind === 'Accepted'
      ? `Checkpoint SAID: ${stream.checkpoint.checkpointSaid}`
      : 'Checkpoint: Absent';
  const seal =
    stream.seal.kind === 'Sealed'
      ? [
          'Evidence seal: Sealed',
          `Evidence seal exchange SAID: ${stream.seal.sealExchangeSaid}`,
          `Evidence sealed at: ${stream.seal.sealedAt}`,
        ]
      : stream.seal.kind === 'SealExchangePending'
        ? [
            'Evidence seal: SealExchangePending',
            `Evidence seal exchange SAID: ${stream.seal.sealExchangeSaid}`,
          ]
        : ['Evidence seal: Unsealed'];
  return [
    `Task ID: ${task.taskId}`,
    `Task label: ${task.label}`,
    `Task Revision SAID: ${task.revisionSaid}`,
    `Task lifecycle: ${task.lifecycle.kind}`,
    `Run ID: ${run.runId}`,
    `Run version: ${String(run.runVersion)}`,
    `Harness Revision SAID: ${run.harnessRevisionSaid}`,
    `Run state: ${runState(run)}`,
    ...lease,
    `Submission verification: ${run.submissionVerification.kind}`,
    `Evidence stream ID: ${stream.evidenceStreamId}`,
    ...cursor,
    checkpoint,
    ...seal,
    'Runtime: inspection only; no runtime was restored or resumed.',
  ];
}

function runState(run: TaskRunStatus['run']): string {
  if (run.lifecycle.kind === 'Active') {
    return run.lifecycle.phase.kind === 'Blocked'
      ? `Active.Blocked(${run.lifecycle.phase.reason})`
      : `Active.${run.lifecycle.phase.kind}`;
  }
  const outcome = run.lifecycle.outcome;
  return outcome.kind === 'Failed' ? `Ended.Failed(${outcome.failure})` : `Ended.${outcome.kind}`;
}

type HostedObservationFailure = HostedTaskFailure | HostedRunFailure | HostedEvidenceFailure;

function hostedObservationFailureDetail(failure: HostedObservationFailure): string {
  return failure.kind === 'RequestRejected'
    ? `${failure.problem.code} (${failure.problem.correlationId})`
    : failure.kind;
}

function renderTaskRunObservationFailure(failure: TaskRunObservationFailure): RenderedCommand {
  switch (failure.kind) {
    case 'TaskIdentityRejected':
      return {
        destination: 'stderr',
        exitCode: 3,
        text: `Task Run identity admission failed: ${failure.identity.kind}.`,
      };
    case 'TaskAccessRejected':
      return {
        destination: 'stderr',
        exitCode: 3,
        text: `Task Run Work Access failed: ${workAccessFailureDetail(failure.access)}.`,
      };
    case 'TaskInspectionRejected':
      return {
        destination: 'stderr',
        exitCode: failure.failure.kind === 'InputInvalid' ? 2 : 5,
        text: `Task Run inspection failed: ${hostedObservationFailureDetail(failure.failure)}.`,
      };
    case 'AcceptedRunUnavailable':
      return {
        destination: 'stderr',
        exitCode: failure.disposition === 'Unavailable' ? 5 : 4,
        text: `Accepted local Run admission is unavailable: ${failure.disposition}.`,
      };
    case 'RunBindingRejected':
      return {
        destination: 'stderr',
        exitCode: 6,
        text: 'The local Task-to-Run admission binding conflicts with authoritative state.',
      };
    case 'RunInspectionRejected':
      return {
        destination: 'stderr',
        exitCode: failure.failure.kind === 'InputInvalid' ? 2 : 5,
        text: `Authoritative Run inspection failed: ${hostedObservationFailureDetail(failure.failure)}.`,
      };
    case 'TimelineInspectionRejected':
      return {
        destination: 'stderr',
        exitCode: failure.failure.kind === 'InputInvalid' ? 2 : 5,
        text: `Evidence timeline inspection failed: ${hostedObservationFailureDetail(failure.failure)}.`,
      };
    case 'TimelineBindingRejected':
      return {
        destination: 'stderr',
        exitCode: 6,
        text: 'The evidence timeline conflicts with the authoritative Run binding.',
      };
    case 'TimelineCursorUnavailable':
      return {
        destination: 'stderr',
        exitCode: 6,
        text: 'The active Run timeline did not provide an opaque continuation cursor.',
      };
    case 'GrantExpired':
      return {
        destination: 'stderr',
        exitCode: 3,
        text: 'Task Run watch stopped because the Work Access Grant expired.',
      };
    case 'WatchInterrupted':
      return {
        destination: 'stderr',
        exitCode: 130,
        text: 'Task Run watch stopped on user interruption.',
      };
    case 'WatchClockUnavailable':
      return {
        destination: 'stderr',
        exitCode: 5,
        text: 'Task Run watch timing is unavailable.',
      };
  }
}

function domainRunState(run: Run): string {
  if (run.lifecycle.kind === 'Active') {
    return run.lifecycle.phase.kind === 'Blocked'
      ? `Active.Blocked(${run.lifecycle.phase.reason})`
      : `Active.${run.lifecycle.phase.kind}`;
  }
  const outcome = run.lifecycle.outcome;
  return outcome.kind === 'Failed' ? `Ended.Failed(${outcome.failure})` : `Ended.${outcome.kind}`;
}

function domainRunCheckpoint(run: Run): string {
  if (run.lifecycle.kind === 'Active') {
    return run.lifecycle.phase.kind === 'Blocked'
      ? `Checkpoint SAID: ${run.lifecycle.phase.checkpointSaid}`
      : 'Checkpoint: Absent';
  }
  return `Checkpoint SAID: ${run.lifecycle.outcome.checkpointSaid}`;
}

function runStopCause(cause: RunStopCause): string {
  switch (cause.kind) {
    case 'PreparationRejected':
      return `PreparationRejected(${cause.failure.kind})`;
    case 'ExecutorSettled':
      return `ExecutorSettled(${cause.disposition.kind})`;
    case 'LeaseKeeperSettled':
      return `LeaseKeeperSettled(${cause.disposition.kind})`;
    case 'UserInterrupted':
    case 'SupervisorIntegrityFailure':
      return cause.kind;
  }
}

function contextPreflight(cause: RunStopCause): string[] {
  if (cause.kind !== 'ExecutorSettled' || cause.disposition.kind !== 'ContextLimitReached') {
    return [];
  }
  const measurement = cause.disposition.measurement;
  if (measurement.kind === 'InitialInput') {
    return [
      `Context preflight: InitialInput encodedBytes=${String(measurement.encodedBytes)} allowedInputTokens=${String(measurement.allowedInputTokens)} providerRequestsAdmitted=0`,
    ];
  }
  return [
    `Context preflight: ProviderRequest profile=${measurement.profile} piEstimateTokens=${String(measurement.piEstimateTokens)} encodedBytes=${String(measurement.encodedBytes)} admissionEstimateTokens=${String(measurement.admissionEstimateTokens)} allowedInputTokens=${String(measurement.allowedInputTokens)} providerRequestsAdmitted=${String(measurement.providerRequestsAdmitted)}`,
  ];
}

function runSettlementFailure(supervision: RunSupervision): string[] {
  if (supervision.kind !== 'SettlementUnavailable') return [];
  const failure = supervision.failure;
  if (failure.kind === 'Unspecified') return ['Run settlement: Unavailable'];
  if (failure.kind === 'EvidenceSealingRejected') {
    return [`Run settlement: EvidenceSealingRejected ${failure.reason}`];
  }
  const delivery = failure.delivery;
  if (delivery.kind === 'ArtifactDeliveryRejected' || delivery.kind === 'BatchDeliveryRejected') {
    const rejection = delivery.failure;
    if (rejection.kind !== 'RequestRejected') {
      return [`Run settlement: EvidenceDeliveryRejected ${delivery.kind} ${rejection.kind}`];
    }
    if (rejection.code === 'EvidenceConflict') {
      const position =
        rejection.reason === 'SequenceGap'
          ? ` expectedStartingSequence=${String(rejection.expectedStartingSequence)} receivedStartingSequence=${String(rejection.receivedStartingSequence)}`
          : '';
      return [
        `Run settlement: EvidenceDeliveryRejected ${delivery.kind} RequestRejected EvidenceConflict ${rejection.reason}${position}`,
      ];
    }
    return [
      `Run settlement: EvidenceDeliveryRejected ${delivery.kind} RequestRejected ${rejection.code}`,
    ];
  }
  return [`Run settlement: EvidenceDeliveryRejected ${delivery.kind}`];
}

function stoppedRunExitCode(supervision: Extract<RunSupervision, { readonly kind: 'Stopped' }>) {
  if (supervision.cause.kind === 'UserInterrupted') {
    return 130;
  }
  if (
    supervision.run.lifecycle.kind === 'Active' &&
    supervision.run.lifecycle.phase.kind === 'Blocked' &&
    supervision.run.lifecycle.phase.reason === 'HarnessCompatibilityFailure'
  ) {
    return 0;
  }
  if (
    supervision.run.lifecycle.kind === 'Ended' &&
    supervision.run.lifecycle.outcome.kind === 'Submitted' &&
    supervision.run.submissionVerification.kind === 'Accepted'
  ) {
    return 0;
  }
  return 6;
}

function renderTaskRunExecution(outcome: TaskRunExecutionOutcome): RenderedCommand {
  switch (outcome.kind) {
    case 'CalibrationCampaignUnavailable':
      return { destination: 'stderr', exitCode: 5, text: 'Calibration campaign unavailable.' };
    case 'CalibrationRunUnsettled':
      return {
        destination: 'stderr',
        exitCode: 6,
        text: [
          `Calibration Run ${String(outcome.ordinal)} did not reach a sealed terminal outcome.`,
          'Completed calibration attempt: none',
          ...(outcome.supervision.kind === 'SupervisorIntegrityFailure'
            ? ['Run supervision: SupervisorIntegrityFailure']
            : [
                `Task ID: ${outcome.supervision.run.binding.taskId}`,
                `Task Revision SAID: ${outcome.supervision.run.binding.taskRevisionSaid}`,
                `Run ID: ${outcome.supervision.run.binding.runId}`,
                `Run state: ${domainRunState(outcome.supervision.run)}`,
                `Run stop cause: ${runStopCause(outcome.supervision.cause)}`,
                ...contextPreflight(outcome.supervision.cause),
                ...runSettlementFailure(outcome.supervision),
                domainRunCheckpoint(outcome.supervision.run),
              ]),
        ].join('\n'),
      };
    case 'CalibrationRejected':
      return {
        destination: 'stderr',
        exitCode: 6,
        text: [
          `Calibration Run ${String(outcome.ordinal)} rejected the prepared compatibility fixture.`,
          `Run ID: ${outcome.supervision.run.binding.runId}`,
          `Run state: ${domainRunState(outcome.supervision.run)}`,
          ...(outcome.supervision.run.lifecycle.kind === 'Ended' &&
          outcome.supervision.run.lifecycle.outcome.kind === 'CalibrationRejected'
            ? [`Calibration rejection: ${outcome.supervision.run.lifecycle.outcome.reason}`]
            : []),
          domainRunCheckpoint(outcome.supervision.run),
        ].join('\n'),
      };
    case 'CalibrationInsufficient':
      return {
        destination: 'stderr',
        exitCode: 6,
        text: `Calibration insufficient: ${String(outcome.confirmed)} confirmed, ${String(outcome.excluded)} excluded.`,
      };
    case 'RunSupervised': {
      const preparation = outcome.preparation;
      const task = preparation.task;
      const mandates = preparation.mandates;
      const harness = preparation.harness.projection.revision;
      const admittedRun = preparation.run.run;
      const lease = preparation.run.lease;
      const supervision = outcome.supervision;
      if (supervision.kind === 'SupervisorIntegrityFailure') {
        return {
          destination: 'stderr',
          exitCode: 6,
          text: [
            'Run supervision failed: SupervisorIntegrityFailure.',
            `Task ID: ${task.taskId}`,
            `Task Revision SAID: ${task.revisionSaid}`,
            `Run ID: ${admittedRun.runId}`,
          ].join('\n'),
        };
      }
      const finalRun = supervision.run;
      const settled = supervision.kind === 'Stopped';
      return {
        destination: settled ? 'stdout' : 'stderr',
        exitCode: settled ? stoppedRunExitCode(supervision) : 5,
        text: [
          settled ? 'Run Supervision Stopped' : 'Run Supervision Settlement Unavailable',
          `Calibration confirmations: ${String(outcome.calibrations.confirmed)}/5`,
          `Calibration exclusions: ${String(outcome.calibrations.excluded)}/5`,
          `Task ID: ${task.taskId}`,
          `Owner AID: ${task.ownerAid}`,
          `Task Revision SAID: ${task.revisionSaid}`,
          `Harness Lineage ID: ${task.harnessLineageId}`,
          `Repository object format: ${task.revision.repository.objectFormat}`,
          `Repository commit: ${task.revision.repository.commit}`,
          `Repository tree: ${task.revision.repository.tree}`,
          `Task lifecycle: ${task.lifecycle.kind}`,
          `Personal-agent AID: ${mandates.personalAgent.aid}`,
          `Personal-agent recovery: ${mandates.personalAgent.origin}`,
          'Personal-agent authority: ExecutePrivateTask',
          `Task Mandate SAID: ${mandates.taskMandate.credentialSaid}`,
          `Task Mandate holder grant SAID: ${mandates.taskMandate.holderGrantSaid}`,
          `Task Mandate holder admit SAID: ${mandates.taskMandate.holderAdmissionSaid}`,
          `Task Mandate server grant SAID: ${mandates.taskMandate.serverGrantSaid}`,
          `Task Mandate expiry: ${mandates.taskMandate.expiresAt}`,
          `Task Mandate admitted at: ${mandates.taskMandate.admittedAt}`,
          `Task Mandate allowed capabilities: ${mandates.taskMandate.allowedCapabilities.join(', ')}`,
          `Task Mandate budgets: ${JSON.stringify(mandates.taskMandate.budgets)}`,
          `Task Mandate evolution classes: ${mandates.taskMandate.allowedEvolutionClasses.join(', ')}`,
          `Governor AID: ${mandates.governor.aid}`,
          `Governor recovery: ${mandates.governor.origin}`,
          'Governor authority: ActivateEvaluatedSuccessor',
          `Promotion Mandate SAID: ${mandates.promotionMandate.credentialSaid}`,
          `Promotion Mandate holder grant SAID: ${mandates.promotionMandate.holderGrantSaid}`,
          `Promotion Mandate holder admit SAID: ${mandates.promotionMandate.holderAdmissionSaid}`,
          `Promotion Mandate server grant SAID: ${mandates.promotionMandate.serverGrantSaid}`,
          `Promotion Mandate expiry: ${mandates.promotionMandate.expiresAt}`,
          `Promotion Mandate admitted at: ${mandates.promotionMandate.admittedAt}`,
          `Promotion Mandate capability ceiling: ${mandates.promotionMandate.capabilityCeiling.join(', ')}`,
          `Promotion Mandate budget ceiling: ${JSON.stringify(mandates.promotionMandate.budgetCeiling)}`,
          `Promotion Mandate evolution ceiling: ${mandates.promotionMandate.evolutionClassCeiling.join(', ')}`,
          `Promotion Mandate required evidence: ${mandates.promotionMandate.requiredEvidenceClasses.join(', ')}`,
          `Mandate Registry ID: ${mandates.mandateRegistryId}`,
          `H1 admission: ${preparation.harness.admission}`,
          `H1 SAID: ${harness.d}`,
          `H1 kind: ${harness.kind}`,
          'H1 meaning: initial specialization, not learned improvement.',
          `H1 accepted at: ${preparation.harness.projection.acceptedAt}`,
          `H1 command ID: ${preparation.harness.projection.commandId}`,
          `H1 template: ${harness.template.identity}@${String(harness.template.version)}`,
          `H1 template SAID: ${harness.template.contentSaid}`,
          `H1 instructions: ${harness.repository.instructionResources.map((resource) => `${resource.path}=${resource.contentSaid}`).join(', ') || 'none'}`,
          `H1 reviewed resources: ${harness.reviewedResources.map((resource) => `${resource.kind}:${resource.identity}@${String(resource.version)}=${resource.contentSaid}`).join(', ')}`,
          `H1 orchestration policy: ${harness.orchestrationPolicy.identity}@${String(harness.orchestrationPolicy.version)}=${harness.orchestrationPolicy.contentSaid}`,
          `H1 context-selection policy: ${harness.contextSelectionPolicy.identity}@${String(harness.contextSelectionPolicy.version)}=${harness.contextSelectionPolicy.contentSaid}`,
          `H1 active tools: ${harness.activeTools.map((tool) => `${tool.identity}:${tool.requiredCapability}=${tool.contentSaid}`).join(', ')}`,
          `H1 completion commands: ${harness.completionCommands.map((command) => `${command.identity}=${command.contentSaid}`).join(', ')}`,
          `H1 model: ${harness.modelCompatibility.provider}/${harness.modelCompatibility.model}`,
          `H1 model context window: ${String(harness.modelCompatibility.contextWindowTokens)}`,
          `H1 model maximum output: ${String(harness.modelCompatibility.maximumOutputTokens)}`,
          `H1 model thinking level: ${harness.modelCompatibility.thinkingLevel}`,
          `H1 model credential source: ${harness.modelCompatibility.credentialSource}`,
          `H1 model tool protocol: ${harness.modelCompatibility.toolCalls}`,
          `H1 model usage protocol: ${harness.modelCompatibility.usageAccounting}`,
          `H1 environment: ${harness.environmentCompatibility.operatingSystem}/${harness.environmentCompatibility.architecture} node-${harness.environmentCompatibility.nodeVersion} git-${harness.environmentCompatibility.gitVersion} pi-${harness.environmentCompatibility.piSdkVersion} xstate-${harness.environmentCompatibility.xstateVersion}`,
          `H1 available capabilities: ${harness.capabilities.available.join(', ')}`,
          `Unavailable capabilities: ${task.revision.unavailableCapabilities.join(', ')}`,
          `Run admission: ${preparation.run.admission}`,
          `Run ID: ${admittedRun.runId}`,
          `Admitted Run version: ${String(admittedRun.runVersion)}`,
          `Run evidence stream ID: ${admittedRun.evidenceStreamId}`,
          `Run activation: ${admittedRun.activation.kind}`,
          `Run activation H1 SAID: ${admittedRun.activation.harnessRevisionSaid}`,
          `Run incarnation ID: ${lease.incarnationId}`,
          `Run lease disposition: ${lease.disposition}`,
          `Run lease server time: ${lease.serverTime}`,
          `Run lease expires at: ${lease.expiresAt}`,
          `Run supervision: ${supervision.kind}`,
          `Run stop cause: ${runStopCause(supervision.cause)}`,
          ...contextPreflight(supervision.cause),
          ...runSettlementFailure(supervision),
          `Last hosted Run version: ${String(supervision.latestHostedRunVersion)}`,
          `Run version: ${String(finalRun.version)}`,
          `Run state: ${domainRunState(finalRun)}`,
          `Submission verification: ${finalRun.submissionVerification.kind}`,
          domainRunCheckpoint(finalRun),
          `Active Harness Revision SAID: ${finalRun.binding.initialHarnessRevisionSaid}`,
        ].join('\n'),
      };
    }
    case 'AdmittedRunBindingRejected':
      return {
        destination: 'stderr',
        exitCode: 6,
        text: `Run admission and first-lease binding were rejected: ${outcome.reason}.`,
      };
    case 'TaskIdentityRejected':
      return {
        destination: 'stderr',
        exitCode: 3,
        text: `Task Run identity admission failed: ${outcome.identity.kind}.`,
      };
    case 'TaskAccessRejected':
      return {
        destination: 'stderr',
        exitCode: 3,
        text: `Task Run Work Access failed: ${workAccessFailureDetail(outcome.access)}.`,
      };
    case 'TaskInspectionRejected':
      return {
        destination: 'stderr',
        exitCode: outcome.failure.kind === 'RequestRejected' ? 6 : 5,
        text: `Task Run inspection failed: ${outcome.failure.kind}.`,
      };
    case 'CustodyUnavailable':
      return {
        destination: 'stderr',
        exitCode: 4,
        text: 'Task Run preparation failed: local Signify custody is unavailable. No replacement was created.',
      };
    case 'GovernanceRejected':
      return {
        destination: 'stderr',
        exitCode: 4,
        text: `Task Run authority recovery was rejected: ${outcome.reason}. No replacement was created.`,
      };
    case 'AuthorizationRejected':
      return {
        destination: 'stderr',
        exitCode: 6,
        text: `Task Run mandate authorization failed: ${outcome.outcome.kind}.`,
      };
    case 'RepositoryInspectionRejected':
      return {
        destination: 'stderr',
        exitCode: 4,
        text: `H1 repository inspection failed: ${outcome.reason}.`,
      };
    case 'ModelInspectionRejected':
      return {
        destination: 'stderr',
        exitCode: outcome.reason === 'ModelConfigurationRequired' ? 2 : 6,
        text: `H1 model inspection failed: ${outcome.reason}.`,
      };
    case 'ModelCredentialUnavailable':
      return {
        destination: 'stderr',
        exitCode: 4,
        text: 'H1 preparation failed: the configured model credential is unavailable.',
      };
    case 'HarnessPreparationRejected':
      return {
        destination: 'stderr',
        exitCode: 6,
        text: `H1 derivation failed: ${outcome.reason}.`,
      };
    case 'HarnessAdmissionBindingConflict':
      return {
        destination: 'stderr',
        exitCode: 4,
        text: 'H1 local admission binding conflicts with durable state.',
      };
    case 'HarnessAdmissionStateUnavailable':
      return {
        destination: 'stderr',
        exitCode: 5,
        text: 'H1 local admission state is unavailable.',
      };
    case 'HarnessAdmissionRejected':
      return {
        destination: 'stderr',
        exitCode: outcome.outcome.kind === 'InputInvalid' ? 2 : 6,
        text:
          outcome.outcome.kind === 'RequestRejected'
            ? `H1 admission failed: ${outcome.outcome.problem.code} (${outcome.outcome.problem.correlationId}).`
            : `H1 admission failed: ${outcome.outcome.kind}.`,
      };
    case 'RunAdmissionBindingConflict':
      return {
        destination: 'stderr',
        exitCode: 4,
        text: 'Run local admission binding conflicts with durable state.',
      };
    case 'RunResumeRequired':
      return {
        destination: 'stderr',
        exitCode: 6,
        text: 'This Run requires later recovery. PRD 02 cannot restore an earlier execution process.',
      };
    case 'RunAdmissionStateUnavailable':
      return {
        destination: 'stderr',
        exitCode: 5,
        text: 'Run local admission state is unavailable.',
      };
    case 'RunExchangeUnavailable':
      return {
        destination: 'stderr',
        exitCode: 5,
        text: 'Run personal-agent signing or delivery is unavailable.',
      };
    case 'RunAdmissionPendingLimitReached':
      return {
        destination: 'stderr',
        exitCode: 5,
        text: 'Run admission remains pending after the bounded observation window.',
      };
    case 'RunAdmissionRejected':
      return {
        destination: 'stderr',
        exitCode: outcome.outcome.kind === 'InputInvalid' ? 2 : 6,
        text:
          outcome.outcome.kind === 'RequestRejected'
            ? `Run admission failed: ${outcome.outcome.problem.code} (${outcome.outcome.problem.correlationId}).`
            : `Run admission failed: ${outcome.outcome.kind}.`,
      };
    case 'RunLeaseRejected':
      return {
        destination: 'stderr',
        exitCode: outcome.outcome.kind === 'InputInvalid' ? 2 : 6,
        text:
          outcome.outcome.kind === 'RequestRejected'
            ? `Run lease failed: ${outcome.outcome.problem.code} (${outcome.outcome.problem.correlationId}).`
            : `Run lease failed: ${outcome.outcome.kind}.`,
      };
  }
}

async function runTaskCommand(
  pending: Promise<TaskCreation | TaskListing | TaskInspection>,
  cliProcess: CliProcess,
): Promise<void> {
  const rendered = renderTaskCommand(await pending);
  if (rendered.destination === 'stdout') {
    cliProcess.write(`${rendered.text}\n`);
  } else {
    cliProcess.writeError(`${rendered.text}\n`);
  }
  cliProcess.setExitCode(rendered.exitCode);
}

function renderTaskCommand(outcome: TaskCreation | TaskListing | TaskInspection): RenderedCommand {
  switch (outcome.kind) {
    case 'TaskSecretDetected':
      return {
        destination: 'stderr',
        exitCode: 6,
        text: 'Task content was rejected: protected credential material was detected.',
      };
    case 'TaskCreated':
    case 'TaskReconciled':
      return {
        destination: 'stdout',
        exitCode: 0,
        text: [
          outcome.kind === 'TaskCreated' ? 'Task Created' : 'Task Reconciled',
          `Task ID: ${outcome.task.taskId}`,
          `Label: ${outcome.task.label}`,
          `Task Revision SAID: ${outcome.task.revisionSaid}`,
          `Harness Lineage ID: ${outcome.task.harnessLineageId}`,
          `Lifecycle: ${outcome.task.lifecycle.kind}`,
        ].join('\n'),
      };
    case 'TasksListed':
      return {
        destination: 'stdout',
        exitCode: 0,
        text:
          outcome.page.tasks.length === 0
            ? 'No Tasks found.'
            : outcome.page.tasks
                .map(
                  (task) =>
                    `${task.label}\t${task.taskId}\t${task.revisionSaid}\t${task.lifecycle.kind}`,
                )
                .join('\n'),
      };
    case 'TaskInspected':
      return {
        destination: 'stdout',
        exitCode: 0,
        text: [
          'Task',
          `Task ID: ${outcome.task.taskId}`,
          `Owner AID: ${outcome.task.ownerAid}`,
          `Label: ${outcome.task.label}`,
          `Task Revision SAID: ${outcome.task.revisionSaid}`,
          `Harness Lineage ID: ${outcome.task.harnessLineageId}`,
          `Repository commit: ${outcome.task.revision.repository.commit}`,
          `Repository tree: ${outcome.task.revision.repository.tree}`,
          `Lifecycle: ${outcome.task.lifecycle.kind}`,
        ].join('\n'),
      };
    case 'TaskLabelRejected':
      return { destination: 'stderr', exitCode: 2, text: 'Task label is invalid.' };
    case 'TaskFileRejected':
      return {
        destination: 'stderr',
        exitCode: 2,
        text: `Task file was rejected: ${outcome.reason}.`,
      };
    case 'TaskContractRejected':
      return {
        destination: 'stderr',
        exitCode: 2,
        text: `Task contract was rejected: ${outcome.reason}.`,
      };
    case 'TaskRepositoryRejected':
      return {
        destination: 'stderr',
        exitCode: 2,
        text: `Task repository was rejected: ${outcome.reason}.`,
      };
    case 'TaskCommandIdUnavailable':
      return { destination: 'stderr', exitCode: 2, text: 'Task command identity is unavailable.' };
    case 'TaskIdentityRejected':
      return {
        destination: 'stderr',
        exitCode: 3,
        text: `Task identity admission failed: ${outcome.identity.kind}.`,
      };
    case 'TaskAccessRejected':
      return {
        destination: 'stderr',
        exitCode: 3,
        text: `Task Work Access failed: ${workAccessFailureDetail(outcome.access)}.`,
      };
    case 'TaskRequestInvalid':
      return { destination: 'stderr', exitCode: 2, text: 'Task request is invalid.' };
    case 'TaskServerUnavailable':
      return { destination: 'stderr', exitCode: 5, text: 'Task service is unavailable.' };
    case 'TaskServerResponseInvalid':
      return { destination: 'stderr', exitCode: 5, text: 'Task service response is invalid.' };
    case 'TaskServerRejected':
      return {
        destination: 'stderr',
        exitCode: outcome.problem.status === 404 ? 4 : 6,
        text: `Task service rejected the request: ${outcome.problem.code} (${outcome.problem.correlationId}).`,
      };
  }
}

function workAccessFailureDetail(
  failure: Exclude<WorkAccessAcquisition, { readonly kind: 'Granted' }>,
): string {
  return failure.kind === 'ServerRejected'
    ? `${failure.code} (${failure.correlationId})`
    : failure.kind;
}

async function runStatusCommand(
  pending: Promise<DemoIssuerCompatibility>,
  cliProcess: CliProcess,
): Promise<void> {
  const compatibility = await pending;
  switch (compatibility.kind) {
    case 'IssuerCompatible':
      cliProcess.write(
        [
          'Devrandom services are ready.',
          `Issuer AID: ${compatibility.issuer.issuerAid}`,
          `Registry ID: ${compatibility.issuer.registryId}`,
          `Schema SAID: ${compatibility.issuer.schemaId}`,
        ].join('\n') + '\n',
      );
      cliProcess.setExitCode(0);
      return;
    case 'IssuerIncompatible':
      cliProcess.writeError(
        `Devrandom services are incompatible: ${compatibility.field} expected ${compatibility.expected} but received ${compatibility.actual}.\n`,
      );
      cliProcess.setExitCode(7);
      return;
    case 'IssuerUnavailable':
      cliProcess.writeError('Devrandom issuer health is unavailable or invalid.\n');
      cliProcess.setExitCode(5);
  }
}

async function runIdentityCommand(
  pending: Promise<UserIdentityOutcome>,
  cliProcess: CliProcess,
): Promise<void> {
  const rendered = renderIdentityOutcome(await pending);
  if (rendered.destination === 'stdout') {
    cliProcess.write(`${rendered.text}\n`);
  } else {
    cliProcess.writeError(`${rendered.text}\n`);
  }
  cliProcess.setExitCode(rendered.exitCode);
}

function renderIdentityOutcome(outcome: UserIdentityOutcome): RenderedCommand {
  switch (outcome.kind) {
    case 'Ready':
      return {
        destination: 'stdout',
        exitCode: 0,
        text: readyIdentity(outcome.user, outcome.profile.provenance.kind, outcome.recovery),
      };
    case 'RegistrationRequired':
      return {
        destination: 'stderr',
        exitCode: 2,
        text: `Registration remains pending for user AID ${outcome.profile.userAid}.`,
      };
    case 'InvalidCredential':
      return {
        destination: 'stderr',
        exitCode: 3,
        text:
          outcome.evidence.kind === 'PolicyInvalidity'
            ? `Credential is invalid: ${outcome.evidence.invalidity.kind}.`
            : `Credential cryptographic evidence is invalid: ${outcome.evidence.reason}`,
      };
    case 'RecoveryRequired':
      return {
        destination: 'stderr',
        exitCode: 4,
        text: [
          `Identity recovery is required: ${outcome.reason}. No replacement was created.`,
          ...(outcome.detail === undefined ? [] : [`Evidence: ${outcome.detail}`]),
        ].join('\n'),
      };
    case 'InfrastructureUnavailable':
      return {
        destination: 'stderr',
        exitCode: 5,
        text: `Identity infrastructure is unavailable: ${outcome.dependency}.`,
      };
    case 'RegistrationRejected':
      return {
        destination: 'stderr',
        exitCode: 6,
        text: [
          `Registration did not complete: ${outcome.disposition}.`,
          ...(outcome.detail === undefined ? [] : [`Evidence: ${outcome.detail}`]),
        ].join('\n'),
      };
  }
}

function readyIdentity(
  user: AdmittedUser,
  provenance: 'live',
  recovery: 'NewIdentity' | 'ExistingIdentity',
): string {
  const witnessAids = user.custody.witnessAids.join(', ');
  const receiptIndexes = user.custody.witnessReceiptIndexes.join(', ');
  const claims = user.credential.eligibilityClaims.map((claim) => `  - ${claim}`).join('\n');
  return [
    'Identity Ready',
    `User AID: ${user.principal.aid}`,
    `Controller AID: ${user.custody.controllerAid}`,
    `KERIA agent AID: ${user.custody.keriaAgentAid}`,
    `KEL sequence: ${String(user.custody.kelSequence)}`,
    `Witness threshold: ${String(user.custody.witnessThreshold)}`,
    `Witness AIDs: ${witnessAids}`,
    `Witness receipt indexes: ${receiptIndexes}`,
    `Credential SAID: ${user.credential.credentialSaid}`,
    `Credential attribute SAID: ${user.credential.attributeSaid}`,
    `Issuer AID: ${user.credential.issuerAid}`,
    `Issuee AID: ${user.credential.issueeAid}`,
    `Schema SAID: ${user.credential.schemaSaid}`,
    `Registry ID: ${user.credential.registryId}`,
    'TEL status: Issued',
    `Issuer anchor event SAID: ${user.credential.issuerAnchorEventSaid}`,
    'Eligibility claims:',
    claims,
    `Provenance: ${provenance}`,
    `Recovery disposition: ${recovery}`,
  ].join('\n');
}
