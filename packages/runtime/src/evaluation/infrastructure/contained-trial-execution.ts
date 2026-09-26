import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { validateExecutionBinding } from '@devrandom/domain';
import type { AssistantMessage, Model, Api, TranscriptContext } from '@earendil-works/pi-ai';
import {
  decodeEvaluationExecutionProfile,
  decodeEvaluationManifest,
  prepareEvidenceArtifact,
  prepareEvaluationEvidenceEvent,
  type EvaluationExecutionProfile,
  type EvaluationEvidenceEvent,
} from '@devrandom/protocol';

import { piToolInput } from '../../pi/evaluation/contained-pi-worker.js';
import type { ToolGatewayProposal, ToolName } from '../../tool-gateway/tool-gateway.js';
import type {
  EvaluationEvidence,
  EvaluationModelInference,
  EvaluationRawArtifacts,
  EvaluationToolGateway,
  TrialExecution,
} from '../application/evaluation-conversations.js';
import { DockerEvaluationCompartment, type EvaluationMount } from './docker-compartment.js';
import { FramedRelay } from './framed-relay.js';
import { digestEvaluationRuntimeMounts } from './runtime-mount-digest.js';
import type { SourceCustody } from './source-custody.js';

interface EvidenceCursor {
  readonly nextSequence: number;
  readonly previousEventSaid?: string;
}

interface ContainedTrialConfiguration {
  readonly profile: EvaluationExecutionProfile;
  readonly image: string;
  readonly model: Model<Api>;
  readonly modelProfileSaid: string;
  readonly systemPrompt: string;
  readonly prompt: string;
  readonly enabledTools: readonly ToolName[];
  readonly maximumPrompts: number;
  readonly workerMounts: readonly EvaluationMount[];
  readonly workerProgram: string;
  readonly source: SourceCustody;
  readonly modelInference: EvaluationModelInference;
  readonly rawArtifacts: EvaluationRawArtifacts;
  readonly evidence: EvaluationEvidence;
  readonly cursor: EvidenceCursor;
  gatewayFor(compartment: DockerEvaluationCompartment): EvaluationToolGateway;
  now(): string;
}

interface ExpectedToolCall {
  readonly requestOrdinal: number;
  readonly id: string;
  readonly name: ToolName;
  readonly arguments: unknown;
}

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function interrupted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function requireEvidenceHead(head: string | undefined): string {
  if (head === undefined) throw new Error('Evaluation evidence head missing.');
  return head;
}

async function runtimeMatches(configuration: ContainedTrialConfiguration): Promise<boolean> {
  try {
    return (
      (await digestEvaluationRuntimeMounts(configuration.workerMounts)) ===
      configuration.profile.runtimeDigest
    );
  } catch {
    return false;
  }
}

function isSaid(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z][A-Za-z0-9_-]{43}$/u.test(value);
}

function isToolName(value: unknown): value is ToolName {
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

/** Trusted parent relay. Pi and all native effects remain inside separate, disposable compartments. */
export class DockerContainedTrialExecution implements TrialExecution {
  readonly #configuration: ContainedTrialConfiguration;
  #used = false;

  constructor(configuration: ContainedTrialConfiguration) {
    this.#configuration = configuration;
  }

  async run(input: Parameters<TrialExecution['run']>[0]): ReturnType<TrialExecution['run']> {
    if (this.#used) return { kind: 'Invalid', reason: 'ProfileDrift' };
    this.#used = true;
    const config = this.#configuration;
    const binding = input.binding;
    const phase = binding.phase;
    const expectedRevision =
      input.slot.arm === 'H1TaskSearch'
        ? input.manifest.revisions.H1
        : input.manifest.revisions[input.slot.arm];
    if (
      validateExecutionBinding(binding).kind !== 'Accepted' ||
      decodeEvaluationManifest(input.manifest).kind !== 'Accepted' ||
      decodeEvaluationExecutionProfile(config.profile).kind !== 'Accepted' ||
      phase.kind !== 'Trial' ||
      phase.manifestSaid !== input.manifest.d ||
      phase.arm !== input.slot.arm ||
      phase.repetition !== input.slot.repetition ||
      phase.attempt !== input.slot.attempt ||
      binding.evaluationId !== input.manifest.evaluationId ||
      binding.taskId !== input.manifest.taskId ||
      binding.taskRevisionSaid !== input.manifest.taskRevisionSaid ||
      binding.originRunId !== input.manifest.originRunId ||
      binding.personalAgentAid !== input.manifest.personalAgentAid ||
      binding.taskMandateSaid !== input.manifest.taskMandateSaid ||
      input.reviewedBehaviorSaid !== expectedRevision ||
      input.containerProfileSaid !== config.profile.d ||
      input.modelProfileSaid !== config.modelProfileSaid ||
      config.model.provider !== config.profile.modelProvider ||
      config.model.id !== config.profile.modelId ||
      config.workerMounts.some((mount) => mount.writable) ||
      !config.workerMounts.some((mount) =>
        config.workerProgram.startsWith(`${mount.containerPath}/`),
      ) ||
      interrupted(input.signal)
    )
      return { kind: 'Invalid', reason: 'ProfileDrift' };
    if (!(await runtimeMatches(config))) return { kind: 'Invalid', reason: 'ProfileDrift' };
    const clean = await config.source.open(input.cleanSourceSaid);
    if (clean === undefined) return { kind: 'Invalid', reason: 'CaptureFailed' };
    const staging = await mkdtemp(join(tmpdir(), 'devrandom-trial-'));
    const sourcePath = join(staging, 'source');
    let compartment: DockerEvaluationCompartment | undefined;
    let evidenceHead = config.cursor.previousEventSaid;
    let sequence = config.cursor.nextSequence;
    const usageSaids: string[] = [];
    const expectedCalls: ExpectedToolCall[] = [];
    let requestOrdinal = 0;
    let proposalIndex = 0;
    const sessionId = randomUUID();
    const bindingId = `${binding.evaluationId}/${input.slot.arm}/${String(input.slot.repetition)}/${String(input.slot.attempt)}/${sessionId}`;

    const storeRawBytes = async (bytes: Uint8Array): Promise<string> => {
      const identified = prepareEvidenceArtifact(bytes, 'application/json');
      if (identified.kind !== 'Prepared')
        throw new Error('Evaluation raw artifact exceeds custody limit.');
      const stored = await config.rawArtifacts.record({ bytes, mediaType: 'application/json' });
      if (stored.kind !== 'Stored' || stored.artifact.d !== identified.artifact.d)
        throw new Error('Evaluation raw artifact custody failed.');
      return stored.artifact.d;
    };
    const raw = (value: unknown): Promise<string> =>
      storeRawBytes(Buffer.from(JSON.stringify(value), 'utf8'));

    const append = async (detail: EvaluationEvidenceEvent['detail']): Promise<string> => {
      const prepared = prepareEvaluationEvidenceEvent({
        evaluationId: binding.evaluationId,
        streamId: binding.evidenceStreamId,
        originRunId: binding.originRunId,
        taskId: binding.taskId,
        taskRevisionSaid: binding.taskRevisionSaid,
        personalAgentAid: binding.personalAgentAid,
        taskMandateSaid: binding.taskMandateSaid,
        harnessRevisionSaid: binding.harnessRevisionSaid,
        phase,
        sequence,
        previous:
          evidenceHead === undefined
            ? { kind: 'Genesis' }
            : { kind: 'Previous', eventSaid: evidenceHead },
        occurredAt: config.now(),
        detail,
      });
      if (prepared.kind !== 'Prepared') throw new Error('Evaluation evidence event invalid.');
      const recorded = await config.evidence.record(prepared.event);
      if (
        recorded.kind !== 'Recorded' ||
        recorded.sequence !== sequence ||
        recorded.headSaid !== prepared.event.d
      )
        throw new Error('Evaluation evidence append failed.');
      const acknowledged = await config.evidence.acknowledge({
        evaluationId: binding.evaluationId,
        streamId: binding.evidenceStreamId,
        fromSequence: sequence,
        throughSequence: sequence,
        expectedHeadSaid: prepared.event.d,
      });
      if (acknowledged.kind !== 'Acknowledged' || acknowledged.headSaid !== prepared.event.d)
        throw new Error('Evaluation evidence acknowledgement failed.');
      sequence += 1;
      evidenceHead = prepared.event.d;
      return prepared.event.d;
    };

    const trial = async (): ReturnType<TrialExecution['run']> => {
      try {
        const cleanManifestSaid = await storeRawBytes(clean.manifestBytes);
        if (cleanManifestSaid !== input.cleanSourceSaid)
          throw new Error('Clean Evaluation source manifest changed before custody.');
        await append({
          kind: 'SourceRead',
          sourceSaid: input.cleanSourceSaid,
          rawArtifactSaid: cleanManifestSaid,
        });
        await mkdir(sourcePath, { mode: 0o700 });
        for (const file of clean.files) {
          const path = resolve(sourcePath, file.path);
          if (!path.startsWith(`${sourcePath}/`)) throw new Error('Source path escaped staging.');
          await mkdir(dirname(path), { recursive: true, mode: 0o700 });
          await writeFile(path, file.bytes, { flag: 'wx', mode: 0o600 });
        }
        const opened = await DockerEvaluationCompartment.open({
          profile: config.profile,
          image: config.image,
          mounts: config.workerMounts,
          signal: input.signal,
        });
        if (opened.kind !== 'Opened')
          return {
            kind: 'Invalid',
            reason: opened.kind === 'CleanupUnconfirmed' ? 'CleanupUnconfirmed' : 'ProfileDrift',
          };
        compartment = opened.compartment;
        const inspected = JSON.parse(opened.effectiveLimitsReceipt) as Array<{
          Image: string;
          Config: { User: string };
          HostConfig: {
            NetworkMode: string;
            IpcMode: string;
            ReadonlyRootfs: boolean;
            CapDrop: string[];
            PidsLimit: number;
            Memory: number;
            NanoCpus: number;
            SecurityOpt: string[];
            Tmpfs: Record<string, string>;
          };
          Mounts: { Destination: string; RW: boolean; Type: string }[];
        }>;
        const actual = inspected[0];
        if (actual === undefined) throw new Error('Evaluation limits inspection missing.');
        const effectiveReceipt = await raw({
          kind: 'EffectiveLimits',
          imageDigest: actual.Image,
          user: actual.Config.User,
          networkMode: actual.HostConfig.NetworkMode,
          ipcMode: actual.HostConfig.IpcMode,
          readOnlyRoot: actual.HostConfig.ReadonlyRootfs,
          droppedCaps: actual.HostConfig.CapDrop,
          pids: actual.HostConfig.PidsLimit,
          memoryBytes: actual.HostConfig.Memory,
          nanoCpus: actual.HostConfig.NanoCpus,
          security: actual.HostConfig.SecurityOpt,
          tmpfs: actual.HostConfig.Tmpfs,
          mounts: actual.Mounts.map((mount) => ({
            destination: mount.Destination,
            writable: mount.RW,
            type: mount.Type,
          })),
        });
        await append({
          kind: 'ArtifactCaptured',
          artifactSaid: effectiveReceipt,
          custody: 'Public',
        });
        await compartment.copyInto(sourcePath, '/work/source');
        await compartment.prepareCopiedSource('/work/source');
        const gateway = config.gatewayFor(compartment);
        const worker = compartment.execute(['node', config.workerProgram, bindingId]);
        const exited = new Promise<number | null>((resolveExit) =>
          worker.once('close', resolveExit),
        );
        let workerError = '';
        worker.stderr.on('data', (chunk: Buffer) => {
          workerError += chunk.toString('utf8');
          if (workerError.length > config.profile.limits.outputBytes) worker.kill();
        });
        const relay = new FramedRelay(worker.stdout, worker.stdin, bindingId, 2 * 1024 * 1024);
        await relay.send('Start', {
          piSessionId: sessionId,
          modelProfileSaid: config.modelProfileSaid,
          model: { ...config.model, maxTokens: config.profile.maximumOutputTokens },
          thinkingLevel: config.profile.thinkingLevel,
          systemPrompt: config.systemPrompt,
          prompt: config.prompt,
          maximumPrompts: config.maximumPrompts,
          enabledTools: config.enabledTools,
        });
        const ready = await relay.receive();
        if (
          ready.kind !== 'Ready' ||
          !isRecord(ready.payload) ||
          ready.payload.piSessionId !== sessionId
        )
          throw new Error('Evaluation worker readiness invalid.');
        for (;;) {
          if (interrupted(input.signal)) throw new Error('Evaluation trial interrupted.');
          const frame = await relay.receive();
          if (frame.kind === 'ModelRequest') {
            const body = frame.payload;
            if (
              expectedCalls.length !== 0 ||
              !isRecord(body) ||
              body.requestOrdinal !== requestOrdinal ||
              body.modelProfileSaid !== config.modelProfileSaid ||
              body.maximumOutputTokens !== config.profile.maximumOutputTokens ||
              !isRecord(body.context) ||
              !Array.isArray(body.context.messages)
            )
              throw new Error('Evaluation model relay request invalid.');
            const completion = await config.modelInference.complete({
              binding,
              requestOrdinal,
              modelProfileSaid: config.modelProfileSaid,
              context: body.context as unknown as TranscriptContext,
              maximumOutputTokens: config.profile.maximumOutputTokens,
              signal: input.signal,
            });
            if (completion.kind !== 'Completed') {
              if (completion.kind === 'UnknownUsage')
                return {
                  kind: 'Invalid',
                  reason: 'UnknownUsage',
                  ...(evidenceHead === undefined ? {} : { evidenceHeadSaid: evidenceHead }),
                };
              throw new Error(`Evaluation model completion ${completion.kind}.`);
            }
            const message: AssistantMessage = completion.message;
            if (
              !isSaid(completion.usageEventSaid) ||
              message.provider !== config.model.provider ||
              message.model !== config.model.id ||
              !Array.isArray(message.content)
            )
              throw new Error('Evaluation model completion identity invalid.');
            const exchange = await raw({
              kind: 'ModelExchange',
              requestOrdinal,
              context: body.context,
              message,
              usageEventSaid: completion.usageEventSaid,
            });
            await append({ kind: 'ModelExchange', rawArtifactSaid: exchange });
            usageSaids.push(completion.usageEventSaid);
            for (const part of message.content) {
              if (part.type !== 'toolCall') continue;
              if (
                !isToolName(part.name) ||
                !config.enabledTools.includes(part.name) ||
                !part.id ||
                expectedCalls.some((call) => call.id === part.id)
              )
                throw new Error('Provider proposed an unsupported or repeated tool call.');
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
              proposal.proposalIndex !== proposalIndex
            )
              throw new Error('Worker tool proposal was not emitted by the provider turn.');
            const expectedInput = piToolInput(expected.name, expected.arguments);
            if (!isDeepStrictEqual(proposal.input, expectedInput))
              throw new Error('Worker altered provider tool arguments.');
            const proposalArtifact = await raw({ kind: 'ToolProposal', proposal });
            const proposedEvent = await append({
              kind: 'ToolProposed',
              proposalIndex,
              toolCallId: proposal.toolCallId,
              inputArtifactSaid: proposalArtifact,
            });
            const outcome = await gateway.propose(binding, proposal, input.signal);
            const outcomeArtifact = await raw({ kind: 'ToolOutcome', outcome });
            const disposition =
              outcome.kind === 'ApprovalRequired'
                ? 'PendingApproval'
                : ['Completed', 'Failed', 'SubmissionVerified'].includes(outcome.kind)
                  ? 'Allowed'
                  : 'Denied';
            const authorizationEvent = await append({
              kind: 'ToolAuthorization',
              proposalEventSaid: proposedEvent,
              disposition,
              receiptArtifactSaid: outcomeArtifact,
            });
            if (disposition === 'Allowed')
              await append({
                kind: 'EffectObserved',
                authorizationEventSaid: authorizationEvent,
                receiptArtifactSaid: outcomeArtifact,
              });
            await relay.send('ToolOutcome', outcome);
            proposalIndex += 1;
            continue;
          }
          if (frame.kind === 'Stopped') {
            if (
              !isRecord(frame.payload) ||
              frame.payload.piSessionId !== sessionId ||
              !['Submitted', 'NoSubmission'].includes(String(frame.payload.kind)) ||
              frame.payload.requestCount !== requestOrdinal ||
              expectedCalls.length !== 0
            )
              throw new Error('Evaluation worker stop receipt invalid.');
            break;
          }
          throw new Error('Evaluation worker sent an unexpected frame.');
        }
        if ((await exited) !== 0 || workerError.length > config.profile.limits.outputBytes)
          throw new Error('Evaluation worker did not stop cleanly.');
        if (!(await runtimeMatches(config)))
          return {
            kind: 'Invalid',
            reason: 'ProfileDrift',
            ...(evidenceHead === undefined ? {} : { evidenceHeadSaid: evidenceHead }),
          };
        const extracted = join(staging, 'stopped-source');
        await compartment.copyDirectoryOut('/work/source', extracted);
        const captured = await config.source.capture(extracted, () => Promise.resolve(false));
        if (captured.kind !== 'Captured')
          throw new Error('Stopped evaluation source capture failed.');
        const stopped = await config.source.open(captured.sourceSaid);
        if (
          stopped === undefined ||
          (await storeRawBytes(stopped.manifestBytes)) !== captured.sourceSaid
        )
          throw new Error('Stopped Evaluation source manifest lacks raw custody.');
        await append({
          kind: 'ArtifactCaptured',
          artifactSaid: captured.sourceSaid,
          custody: 'Public',
        });
        const cleanupConfirmed = await compartment.close();
        compartment = undefined;
        if (!cleanupConfirmed)
          return {
            kind: 'Invalid',
            reason: 'CleanupUnconfirmed',
            ...(evidenceHead === undefined ? {} : { evidenceHeadSaid: evidenceHead }),
          };
        const cleanupReceipt = await raw({ kind: 'Cleanup', bindingId, confirmed: true });
        await append({ kind: 'ArtifactCaptured', artifactSaid: cleanupReceipt, custody: 'Public' });
        await append({ kind: 'TrialStopped', reason: 'Completed' });
        return {
          kind: 'Stopped',
          capturedSourceSaid: captured.sourceSaid,
          evidenceHeadSaid: requireEvidenceHead(evidenceHead),
          providerUsageEventSaids: usageSaids,
          cleanupReceiptSaid: cleanupReceipt,
        };
      } catch {
        return {
          kind: 'Invalid',
          reason: interrupted(input.signal) ? 'Interrupted' : 'CaptureFailed',
          ...(evidenceHead === undefined ? {} : { evidenceHeadSaid: evidenceHead }),
        };
      }
    };
    const result = await trial();
    const closed = compartment === undefined || (await compartment.close());
    try {
      await rm(staging, { recursive: true, force: true });
    } catch {
      return {
        kind: 'Invalid',
        reason: 'CleanupUnconfirmed',
        ...(evidenceHead === undefined ? {} : { evidenceHeadSaid: evidenceHead }),
      };
    }
    if (!closed)
      return {
        kind: 'Invalid',
        reason: 'CleanupUnconfirmed',
        ...(evidenceHead === undefined ? {} : { evidenceHeadSaid: evidenceHead }),
      };
    return result;
  }
}
