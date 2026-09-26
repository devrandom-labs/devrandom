import { isDeepStrictEqual } from 'node:util';

import type { ProtectedCredentials, Run } from '@devrandom/domain';
import type { Api, AssistantMessage, Model, TranscriptContext } from '@earendil-works/pi-ai';
import {
  decodeEvaluationExecutionProfile,
  type BaselineHarnessRevision,
  type EvaluationExecutionProfile,
} from '@devrandom/protocol';

import { FramedRelay } from '../evaluation/infrastructure/framed-relay.js';
import type { EvidenceRecorder } from '../evidence/evidence-recorder.js';
import { piToolInput } from '../pi/evaluation/contained-pi-worker.js';
import {
  toolTerminal,
  type PiExecutionGateway,
  type PiModelAccess,
} from '../pi/baseline-pi-executor.js';
import type { ToolGatewayProposal, ToolName } from '../tool-gateway/tool-gateway.js';
import type { DockerRunEnvironment } from './docker-run-environment.js';
import { ParentRunModelInference } from './parent-run-model-inference.js';
import { bindRunExecutionProfile, runInstructionPrompt } from './run-execution-profile-custody.js';
import type { RunResourceBudget } from './run-resource-budget.js';
import type { PiExecution, PiExecutionDisposition } from './run-supervisor.js';

interface ExpectedToolCall {
  readonly requestOrdinal: number;
  readonly id: string;
  readonly name: ToolName;
  readonly arguments: unknown;
}

export interface DockerRunPiExecutorDependencies {
  readonly profile: EvaluationExecutionProfile;
  readonly environment: Pick<DockerRunEnvironment, 'startWorker' | 'close'>;
  readonly workerProgram: string;
  readonly worktreeBranch: string;
  readonly instructions: readonly { readonly path: string; readonly content: string }[];
  readonly instructionResources: BaselineHarnessRevision['repository']['instructionResources'];
  readonly prompt: string;
  readonly effectiveLimitsReceipt: Uint8Array;
  readonly parentDeathCleanupReceipt: Uint8Array;
  readonly harness: BaselineHarnessRevision;
  readonly modelAccess: PiModelAccess;
  readonly budget: RunResourceBudget;
  readonly gateway: PiExecutionGateway;
  readonly evidence: EvidenceRecorder;
  readonly protectedCredentials: ProtectedCredentials;
  now(): string;
  sessionId(): string;
}

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function supportedToolName(value: unknown): value is ToolName {
  return (
    typeof value === 'string' &&
    [
      'read_file',
      'list_files',
      'search_repository',
      'write_file',
      'replace_text',
      'run_formatter',
      'run_static_analysis',
      'run_tests',
      'submit_result',
    ].includes(value)
  );
}

function interrupted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function modelMatches(
  model: Model<Api>,
  profile: EvaluationExecutionProfile,
  harness: BaselineHarnessRevision,
): boolean {
  return (
    model.provider === profile.modelProvider &&
    model.id === profile.modelId &&
    model.api === 'openai-responses' &&
    model.provider === harness.modelCompatibility.provider &&
    model.id === harness.modelCompatibility.model &&
    harness.modelCompatibility.thinkingLevel === profile.thinkingLevel &&
    harness.modelCompatibility.maximumOutputTokens === profile.maximumOutputTokens &&
    (model.headers === undefined || Object.keys(model.headers).length === 0)
  );
}

/** Pi runs only in the read-only Linux worker; the parent owns model, Gateway and Run evidence. */
export class DockerRunPiExecutor implements PiExecution {
  readonly #dependencies: DockerRunPiExecutorDependencies;
  #used = false;

  constructor(dependencies: DockerRunPiExecutorDependencies) {
    this.#dependencies = dependencies;
  }

  async invoke(run: Run, signal: AbortSignal): Promise<PiExecutionDisposition> {
    if (this.#used) return { kind: 'DependencyUnavailable' };
    this.#used = true;
    const config = this.#dependencies;
    if (
      run.binding.runId !== config.evidence.run.binding.runId ||
      run.lifecycle.kind !== 'Active' ||
      run.lifecycle.phase.kind !== 'Running' ||
      run.lease.kind !== 'Held' ||
      run.binding.taskId !== config.harness.task.taskId ||
      run.binding.taskRevisionSaid !== config.harness.task.revisionSaid ||
      run.binding.initialHarnessRevisionSaid !== config.harness.d ||
      run.binding.repository.commit !== config.profile.sourceGitCommit ||
      run.binding.repository.tree !== config.profile.sourceGitTree ||
      decodeEvaluationExecutionProfile(config.profile).kind !== 'Accepted' ||
      config.harness.environmentCompatibility.operatingSystem !== 'linux' ||
      config.harness.environmentCompatibility.architecture !==
        (config.profile.architecture === 'aarch64' ? 'arm64' : 'x64') ||
      config.profile.modelProvider !== config.harness.modelCompatibility.provider ||
      config.profile.modelId !== config.harness.modelCompatibility.model ||
      config.profile.thinkingLevel !== config.harness.modelCompatibility.thinkingLevel ||
      config.profile.maximumOutputTokens !==
        config.harness.modelCompatibility.maximumOutputTokens ||
      interrupted(signal)
    )
      return (await config.environment.close())
        ? { kind: 'DependencyUnavailable' }
        : { kind: 'EvidenceIntegrityFailure' };
    let disposition: PiExecutionDisposition;
    try {
      disposition = await this.#invokeBound(run, signal);
    } catch {
      disposition = interrupted(signal)
        ? { kind: 'Aborted' }
        : { kind: 'EvidenceIntegrityFailure' };
    }
    const closed = await config.environment.close();
    return closed ? disposition : { kind: 'EvidenceIntegrityFailure' };
  }

  async #invokeBound(run: Run, signal: AbortSignal): Promise<PiExecutionDisposition> {
    const config = this.#dependencies;
    const systemPrompt = runInstructionPrompt(config.instructions);
    const disclosure = config.protectedCredentials.inspect(
      Buffer.from(
        JSON.stringify({
          instructions: config.instructions,
          systemPrompt,
          prompt: config.prompt,
        }),
        'utf8',
      ),
    );
    if (disclosure.kind === 'WithheldSecret') {
      const withheld = config.evidence.withhold({
        occurredAt: config.now(),
        producer: { kind: 'PiExecutor' },
        disclosure,
      });
      return withheld.kind === 'SecretDetected'
        ? { kind: 'SecretDetected' }
        : withheld.kind === 'OutboxBackpressure' || withheld.kind === 'OutboxBoundReached'
          ? { kind: 'OutboxBackpressure' }
          : { kind: 'EvidenceIntegrityFailure' };
    }
    const opened = await config.modelAccess.open(config.harness.modelCompatibility);
    if (opened.kind !== 'Opened') {
      switch (opened.kind) {
        case 'ConfigurationRequired':
          return { kind: 'ModelConfigurationRequired' };
        case 'CredentialUnavailable':
          return { kind: 'ModelCredentialUnavailable' };
        case 'Unavailable':
          return { kind: 'DependencyUnavailable' };
      }
    }
    if (!modelMatches(opened.model, config.profile, config.harness))
      return { kind: 'ModelConfigurationRequired' };
    if (
      config.protectedCredentials.inspect(Buffer.from(JSON.stringify(opened.model), 'utf8'))
        .kind === 'WithheldSecret'
    )
      return { kind: 'SecretDetected' };
    const bound = bindRunExecutionProfile({
      profile: config.profile,
      instructions: config.instructions,
      instructionResources: config.instructionResources,
      systemPrompt,
      taskPrompt: config.prompt,
      effectiveLimitsReceipt: config.effectiveLimitsReceipt,
      parentDeathCleanupReceipt: config.parentDeathCleanupReceipt,
      worktreeBranch: config.worktreeBranch,
      evidence: config.evidence,
      now: () => config.now(),
    });
    if (bound.kind !== 'Bound') return { kind: 'EvidenceIntegrityFailure' };
    const enabledTools = config.harness.activeTools.map(({ identity }) => identity);
    if (
      enabledTools.length === 0 ||
      enabledTools.length > 9 ||
      !enabledTools.every(supportedToolName) ||
      new Set(enabledTools).size !== enabledTools.length
    )
      return { kind: 'DependencyUnavailable' };
    const maximumPrompts = Math.min(50, run.binding.budget.providerRequests);
    if (!Number.isSafeInteger(maximumPrompts) || maximumPrompts < 1)
      return { kind: 'BudgetExhausted' };
    const sessionId = config.sessionId();
    const bindingId = `${run.binding.runId}/${run.lease.kind === 'Held' ? run.lease.incarnationId : ''}/${sessionId}`;
    const worker = config.environment.startWorker(config.workerProgram, bindingId);
    let stderrBytes = 0;
    worker.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > config.profile.limits.outputBytes) worker.kill();
    });
    const exited = new Promise<number | null>((resolve) => worker.once('close', resolve));
    const stop = () => worker.kill();
    signal.addEventListener('abort', stop, { once: true });
    try {
      const relay = new FramedRelay(
        worker.stdout,
        worker.stdin,
        bindingId,
        Math.min(2 * 1024 * 1024, config.profile.limits.outputBytes),
      );
      await relay.send('Start', {
        piSessionId: sessionId,
        modelProfileSaid: config.profile.d,
        model: { ...opened.model, maxTokens: config.profile.maximumOutputTokens },
        thinkingLevel: config.profile.thinkingLevel,
        systemPrompt,
        prompt: config.prompt,
        maximumPrompts,
        enabledTools,
      });
      const ready = await relay.receive();
      if (
        ready.kind !== 'Ready' ||
        !isRecord(ready.payload) ||
        ready.payload.piSessionId !== sessionId
      )
        return { kind: 'EvidenceIntegrityFailure' };
      const inference = new ParentRunModelInference({
        model: opened.model,
        compatibility: config.harness.modelCompatibility,
        sessionId,
        budget: config.budget,
        evidence: config.evidence,
        complete: (context, requestSignal) =>
          opened.runtime.completeSimple(
            opened.model,
            { messages: context.messages },
            {
              maxTokens: config.profile.maximumOutputTokens,
              ...(config.harness.modelCompatibility.thinkingLevel === 'off'
                ? {}
                : { reasoning: config.harness.modelCompatibility.thinkingLevel }),
              signal: requestSignal,
              maxRetries: 0,
            },
          ),
        consumeUsage: (message) => opened.consumeUsage(message),
        now: () => config.now(),
      });
      const expectedCalls: ExpectedToolCall[] = [];
      let requestOrdinal = 0;
      let proposalIndex = 0;
      for (;;) {
        if (interrupted(signal)) return { kind: 'Aborted' };
        const frame = await relay.receive();
        if (frame.kind === 'ModelRequest') {
          const body = frame.payload;
          if (
            expectedCalls.length !== 0 ||
            !isRecord(body) ||
            body.requestOrdinal !== requestOrdinal ||
            body.modelProfileSaid !== config.profile.d ||
            body.maximumOutputTokens !== config.profile.maximumOutputTokens ||
            !isRecord(body.context) ||
            !Array.isArray(body.context.messages)
          )
            return { kind: 'EvidenceIntegrityFailure' };
          const completion = await inference.complete(
            body.context as unknown as TranscriptContext,
            requestOrdinal,
            signal,
          );
          if (completion.kind !== 'Completed') return completion.disposition;
          const message: AssistantMessage = completion.message;
          if (
            message.provider !== opened.model.provider ||
            message.model !== opened.model.id ||
            !Array.isArray(message.content)
          )
            return { kind: 'EvidenceIntegrityFailure' };
          for (const part of message.content) {
            if (part.type !== 'toolCall') continue;
            if (
              !supportedToolName(part.name) ||
              !enabledTools.includes(part.name) ||
              !part.id ||
              expectedCalls.some((call) => call.id === part.id)
            )
              return { kind: 'EvidenceIntegrityFailure' };
            expectedCalls.push({
              requestOrdinal,
              id: part.id,
              name: part.name,
              arguments: part.arguments,
            });
          }
          await relay.send('ModelResponse', { ...completion, requestOrdinal });
          requestOrdinal += 1;
          proposalIndex = 0;
          continue;
        }
        if (frame.kind === 'ToolProposal') {
          const proposal = frame.payload as ToolGatewayProposal;
          const expected = expectedCalls.shift();
          if (
            !isRecord(proposal) ||
            expected === undefined ||
            proposal.piSessionId !== sessionId ||
            proposal.modelTurnId !== `${sessionId}:${String(expected.requestOrdinal)}` ||
            proposal.toolCallId !== expected.id ||
            proposal.proposalIndex !== proposalIndex ||
            !isDeepStrictEqual(proposal.input, piToolInput(expected.name, expected.arguments))
          )
            return { kind: 'EvidenceIntegrityFailure' };
          const outcome = await config.gateway.propose(proposal, signal);
          const terminal = toolTerminal(outcome);
          await relay.send('ToolOutcome', outcome);
          if (terminal !== undefined) return terminal;
          proposalIndex += 1;
          continue;
        }
        if (frame.kind === 'Stopped') {
          if (
            !isRecord(frame.payload) ||
            frame.payload.piSessionId !== sessionId ||
            !['Submitted', 'NoSubmission'].includes(String(frame.payload.kind)) ||
            frame.payload.requestCount !== requestOrdinal ||
            requestOrdinal === 0 ||
            expectedCalls.length !== 0 ||
            (await exited) !== 0 ||
            stderrBytes > config.profile.limits.outputBytes
          )
            return { kind: 'EvidenceIntegrityFailure' };
          return { kind: 'Completed', sessionId };
        }
        return { kind: 'EvidenceIntegrityFailure' };
      }
    } catch {
      return interrupted(signal) ? { kind: 'Aborted' } : { kind: 'EvidenceIntegrityFailure' };
    } finally {
      signal.removeEventListener('abort', stop);
      if (!worker.killed) worker.kill();
    }
  }
}
