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
  decodeEvolutionHypothesis,
  prepareEvidenceArtifact,
  prepareEvaluationEvidenceEvent,
  type EvaluationExecutionProfile,
  type EvaluationEvidenceEvent,
  type EvolutionHypothesis,
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
import { bindC1TrialBehavior } from '../application/bind-c1-trial-behavior.js';
import type { CandidateTreatmentCustody } from '../application/candidate-treatment-custody.js';
import type { ExecutableSuccessorDescriptor } from '../../harness/application/materialize-successor.js';
import { digestRunRuntimePrompt } from '../../run/run-execution-profile-custody.js';
import type {
  C2ProvisionalSubmissionAuthority,
  C2StoppedSubmissionVerification,
  C2WorkflowTransition,
} from '../application/c2-workflow-transition.js';
import { assessC2PublicSubmission } from '../application/c2-workflow-transition.js';
import type { C3ContextSelection } from '../application/c3-context-selection.js';

interface EvidenceCursor {
  readonly nextSequence: number;
  readonly previousEventSaid?: string;
  /** Replay-derived native debit totals; required when continuing a non-genesis E3 stream. */
  readonly consumed?: {
    providerRequests: number;
    providerInputTokens: number;
    providerOutputTokens: number;
    providerSpendMicroUsd: number;
    runWallTimeSeconds: number;
    toolProposals: number;
    aggregateChildCommandTimeSeconds: number;
    changedFiles: number;
    changedWorktreeBytes: number;
  };
}

interface ContainedTrialConfiguration {
  readonly profile: EvaluationExecutionProfile;
  readonly image: string;
  readonly model: Model<Api>;
  readonly modelProfileSaid: string;
  readonly systemPrompt: string;
  readonly prompt: string;
  /** Present only for a parent-reviewed C1 trial; Task source remains separate. */
  readonly c1Treatment?: {
    readonly reviewed: ExecutableSuccessorDescriptor;
    readonly successorBytes: Uint8Array;
    readonly repositoryDirectory: string;
    readonly candidateCommit: string;
    readonly candidateTree: string;
    readonly custody: CandidateTreatmentCustody;
  };
  /** C2 is unavailable unless all three trusted-parent conversations are composed. */
  readonly c2Workflow?: {
    readonly hypothesis: EvolutionHypothesis;
    readonly reviewed: ExecutableSuccessorDescriptor;
    readonly candidateCommit: string;
    readonly candidateTree: string;
    readonly transition: C2WorkflowTransition;
    readonly submission: C2ProvisionalSubmissionAuthority;
    readonly verification: C2StoppedSubmissionVerification;
  };
  /** C3 remains unavailable unless a reviewed policy and current public history are composed. */
  readonly c3Selection?: C3ContextSelection;
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

interface MeasuredSourceFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** Compares exact bytes re-opened from parent SourceCustody, including deletions. */
export function measureEvaluationSourceChanges(
  before: readonly MeasuredSourceFile[],
  after: readonly MeasuredSourceFile[],
):
  | {
      readonly changedFiles: number;
      /** Conservative changed-byte charge: max(old length, new length) for each changed path. */
      readonly changedWorktreeBytes: number;
      readonly paths: readonly string[];
    }
  | undefined {
  const collect = (files: readonly MeasuredSourceFile[]): Map<string, Uint8Array> | undefined => {
    const entries = new Map<string, Uint8Array>();
    for (const file of files) {
      if (
        typeof file.path !== 'string' ||
        file.path.length === 0 ||
        !(file.bytes instanceof Uint8Array) ||
        entries.has(file.path)
      )
        return undefined;
      entries.set(file.path, file.bytes);
    }
    return entries;
  };
  const oldFiles = collect(before);
  const newFiles = collect(after);
  if (oldFiles === undefined || newFiles === undefined) return undefined;
  const paths: string[] = [];
  let changedWorktreeBytes = 0;
  for (const path of new Set([...oldFiles.keys(), ...newFiles.keys()])) {
    const oldBytes = oldFiles.get(path);
    const newBytes = newFiles.get(path);
    if (
      oldBytes !== undefined &&
      newBytes !== undefined &&
      Buffer.from(oldBytes).equals(Buffer.from(newBytes))
    )
      continue;
    paths.push(path);
    changedWorktreeBytes += Math.max(oldBytes?.byteLength ?? 0, newBytes?.byteLength ?? 0);
    if (!Number.isSafeInteger(changedWorktreeBytes)) return undefined;
  }
  paths.sort((left, right) => left.localeCompare(right, 'en'));
  return { changedFiles: paths.length, changedWorktreeBytes, paths };
}

function openingConsumption(
  cursor: EvidenceCursor,
): NonNullable<EvidenceCursor['consumed']> | undefined {
  const zero = {
    providerRequests: 0,
    providerInputTokens: 0,
    providerOutputTokens: 0,
    providerSpendMicroUsd: 0,
    runWallTimeSeconds: 0,
    toolProposals: 0,
    aggregateChildCommandTimeSeconds: 0,
    changedFiles: 0,
    changedWorktreeBytes: 0,
  };
  if (!Number.isSafeInteger(cursor.nextSequence) || cursor.nextSequence < 0) return undefined;
  if (cursor.nextSequence === 0)
    return cursor.previousEventSaid === undefined && cursor.consumed === undefined
      ? zero
      : undefined;
  const initial = cursor.consumed;
  if (
    !isSaid(cursor.previousEventSaid) ||
    initial === undefined ||
    !isDeepStrictEqual(Object.keys(initial).sort(), Object.keys(zero).sort()) ||
    Object.values(initial).some((value) => !Number.isSafeInteger(value) || value < 0)
  )
    return undefined;
  return { ...initial };
}

function accountableProviderUsage(
  message: AssistantMessage,
  spendMicroUsd: number,
): { readonly inputTokens: number; readonly outputTokens: number } | undefined {
  const values = [
    message.usage.input,
    message.usage.output,
    message.usage.cacheRead,
    message.usage.cacheWrite,
    message.usage.totalTokens,
    spendMicroUsd,
  ];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) return undefined;
  const inputTokens = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
  const outputTokens = message.usage.output;
  return Number.isSafeInteger(inputTokens) &&
    inputTokens + outputTokens === message.usage.totalTokens
    ? { inputTokens, outputTokens }
    : undefined;
}

function measuredToolElapsed(
  started: number,
  finished: number,
):
  | {
      readonly startedMonotonicMicroseconds: number;
      readonly finishedMonotonicMicroseconds: number;
      readonly elapsedMilliseconds: number;
    }
  | undefined {
  const start = Math.round(started * 1_000);
  const end = Math.round(finished * 1_000);
  const elapsedMilliseconds = Math.ceil((end - start) / 1_000);
  return Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    end >= start &&
    Number.isSafeInteger(elapsedMilliseconds)
    ? {
        startedMonotonicMicroseconds: start,
        finishedMonotonicMicroseconds: end,
        elapsedMilliseconds,
      }
    : undefined;
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
    const consumed = openingConsumption(config.cursor);
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
      consumed === undefined ||
      config.model.provider !== config.profile.modelProvider ||
      config.model.id !== config.profile.modelId ||
      config.workerMounts.some((mount) => mount.writable) ||
      (input.slot.arm === 'C1') !== (config.c1Treatment !== undefined) ||
      (input.slot.arm === 'C2') !== (config.c2Workflow !== undefined) ||
      (input.slot.arm === 'C3') !== (config.c3Selection !== undefined) ||
      (input.slot.arm === 'C2' && !config.enabledTools.includes('submit_result')) ||
      !config.workerMounts.some((mount) =>
        config.workerProgram.startsWith(`${mount.containerPath}/`),
      ) ||
      interrupted(input.signal)
    )
      return { kind: 'Invalid', reason: 'ProfileDrift' };
    if (!(await runtimeMatches(config))) return { kind: 'Invalid', reason: 'ProfileDrift' };
    if (input.slot.arm === 'C2') {
      const c2 = config.c2Workflow;
      if (
        c2 === undefined ||
        decodeEvolutionHypothesis(c2.hypothesis).kind !== 'Accepted' ||
        c2.hypothesis.d !== input.manifest.hypothesisSaid ||
        c2.hypothesis.sourceInventorySaid !== input.manifest.sourceInventorySaid ||
        c2.hypothesis.taskId !== input.manifest.taskId ||
        c2.hypothesis.taskRevisionSaid !== input.manifest.taskRevisionSaid ||
        c2.hypothesis.originRunId !== input.manifest.originRunId ||
        c2.reviewed.binding.arm !== 'C2' ||
        c2.reviewed.binding.h0Said !== c2.hypothesis.d ||
        c2.reviewed.binding.sourceInventorySaid !== input.manifest.sourceInventorySaid ||
        c2.reviewed.binding.executionProfileSaid !== config.profile.d ||
        c2.reviewed.successorRevisionSaid !== input.reviewedBehaviorSaid ||
        c2.reviewed.treatment.kind !== 'ReviewedWorkflow' ||
        c2.reviewed.implementation === undefined ||
        c2.reviewed.replay === undefined ||
        digestRunRuntimePrompt(config.systemPrompt, config.prompt) !==
          config.profile.h1RuntimePromptDigest ||
        !/^[a-f0-9]{40}$/u.test(c2.candidateCommit) ||
        !/^[a-f0-9]{40}$/u.test(c2.candidateTree)
      )
        return { kind: 'Invalid', reason: 'ProfileDrift' };
    }
    const c3Bound =
      input.slot.arm === 'C3'
        ? await config.c3Selection?.bind({
            binding,
            manifest: input.manifest,
            slot: input.slot,
            profile: config.profile,
            baseSystemPrompt: config.systemPrompt,
            taskPrompt: config.prompt,
            signal: input.signal,
          })
        : undefined;
    if (input.slot.arm === 'C3' && c3Bound?.kind !== 'Bound')
      return { kind: 'Invalid', reason: 'ProfileDrift' };
    const trialStarted = performance.now();
    const clean = await config.source.open(input.cleanSourceSaid);
    if (clean === undefined) return { kind: 'Invalid', reason: 'CaptureFailed' };
    let c1Binding: Extract<ReturnType<typeof bindC1TrialBehavior>, { kind: 'Bound' }> | undefined;
    let c1Bytes: Uint8Array | undefined;
    if (input.slot.arm === 'C1') {
      const treatment = config.c1Treatment;
      if (treatment === undefined) return { kind: 'Invalid', reason: 'ProfileDrift' };
      const opened = await treatment.custody.read({
        repositoryDirectory: treatment.repositoryDirectory,
        candidateCommit: treatment.candidateCommit,
        candidateTree: treatment.candidateTree,
        parentCommit: treatment.reviewed.h1.repository.commit,
        parentTree: treatment.reviewed.h1.repository.tree,
        arm: 'C1',
        signal: input.signal,
      });
      if (opened.kind !== 'Read') return { kind: 'Invalid', reason: 'ProfileDrift' };
      c1Bytes = opened.bytes;
      const binding = bindC1TrialBehavior({
        reviewed: treatment.reviewed,
        treatmentBytes: opened.bytes,
        successorBytes: treatment.successorBytes,
        manifest: input.manifest,
        profile: config.profile,
        baseSystemPrompt: config.systemPrompt,
        taskPrompt: config.prompt,
        candidateCommit: treatment.candidateCommit,
        candidateTree: treatment.candidateTree,
      });
      if (binding.kind !== 'Bound') return { kind: 'Invalid', reason: 'ProfileDrift' };
      c1Binding = binding;
    }
    const effectiveSystemPrompt = c1Binding?.systemPrompt ?? config.systemPrompt;
    const expectedPromptDigest =
      c1Binding?.promptDigest ?? digestRunRuntimePrompt(effectiveSystemPrompt, config.prompt);
    const staging = await mkdtemp(join(tmpdir(), 'devrandom-trial-'));
    const sourcePath = join(staging, 'source');
    let compartment: DockerEvaluationCompartment | undefined;
    let evidenceHead = config.cursor.previousEventSaid;
    let sequence = config.cursor.nextSequence;
    const usageSaids: string[] = [];
    const expectedCalls: ExpectedToolCall[] = [];
    let requestOrdinal = 0;
    let proposalIndex = 0;
    let c3FormatEdit:
      | { readonly path: string; readonly content: string; readonly proposalEventSaid: string }
      | undefined;
    let nativeCommandObserved = false;
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

    const debit = async (
      budget: keyof typeof consumed,
      amount: number,
      receiptArtifactSaid: string,
      sourceEventSaid: string,
    ): Promise<void> => {
      const next = consumed[budget] + amount;
      if (!Number.isSafeInteger(next) || next < 0) throw new Error('Evaluation usage overflow.');
      const detail = {
        kind: 'EvaluationBudgetDebited',
        budget,
        amount,
        consumed: next,
        receiptArtifactSaid,
        sourceEventSaid,
      } as const;
      await append(detail as EvaluationEvidenceEvent['detail']);
      consumed[budget] = next;
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
        if (c1Binding !== undefined && c1Bytes !== undefined) {
          const treatmentSaid = await storeRawBytes(c1Bytes);
          if (treatmentSaid !== c1Binding.treatmentArtifactSaid)
            throw new Error('C1 treatment custody identity changed.');
          await append({
            kind: 'ArtifactCaptured',
            artifactSaid: treatmentSaid,
            custody: 'Public',
          });
          const bindingSaid = await storeRawBytes(c1Binding.receiptBytes);
          await append({ kind: 'ArtifactCaptured', artifactSaid: bindingSaid, custody: 'Public' });
        }
        if (c3Bound?.kind === 'Bound') {
          const treatmentSaid = await storeRawBytes(c3Bound.treatmentBytes);
          if (treatmentSaid !== c3Bound.treatmentArtifactSaid)
            throw new Error('C3 policy changed after reviewed Git custody.');
          await append({
            kind: 'ArtifactCaptured',
            artifactSaid: treatmentSaid,
            custody: 'Public',
          });
          const receiptSaid = await storeRawBytes(c3Bound.bindingReceiptBytes);
          await append({
            kind: 'ArtifactCaptured',
            artifactSaid: receiptSaid,
            custody: 'Public',
          });
        }
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
          systemPrompt: effectiveSystemPrompt,
          prompt: config.prompt,
          maximumPrompts: config.maximumPrompts,
          enabledTools: config.enabledTools,
          ...(input.slot.arm === 'C2' ? { requiresWorkflowContext: true } : {}),
        });
        const ready = await relay.receive();
        if (
          ready.kind !== 'Ready' ||
          !isRecord(ready.payload) ||
          ready.payload.piSessionId !== sessionId ||
          ready.payload.promptDigest !== expectedPromptDigest
        )
          throw new Error('Evaluation worker readiness invalid.');
        if (c1Binding !== undefined) {
          const startSaid = await raw({
            version: 1,
            kind: 'C1TrialWorkerStart',
            successorRevisionSaid: input.reviewedBehaviorSaid,
            treatmentArtifactSaid: c1Binding.treatmentArtifactSaid,
            expectedPromptDigest,
            workerPromptDigest: ready.payload.promptDigest,
          });
          await append({ kind: 'ArtifactCaptured', artifactSaid: startSaid, custody: 'Public' });
        }
        const c2 = config.c2Workflow;
        if (c2 !== undefined) {
          const prepared = await c2.transition.prepare({
            binding,
            manifest: input.manifest,
            slot: input.slot,
            successorRevisionSaid: input.reviewedBehaviorSaid,
            candidateCommit: c2.candidateCommit,
            candidateTree: c2.candidateTree,
            signal: input.signal,
          });
          if (
            prepared.kind !== 'Prepared' ||
            prepared.manifestSaid !== input.manifest.d ||
            prepared.successorRevisionSaid !== input.reviewedBehaviorSaid ||
            prepared.hypothesisSaid !== c2.hypothesis.d ||
            prepared.sourceInventorySaid !== input.manifest.sourceInventorySaid ||
            prepared.failureWindowSaid !== c2.hypothesis.publicReplay.failureWindowSaid ||
            !isSaid(prepared.queryReceiptSaid) ||
            prepared.sourceEvidenceSaid !== c2.hypothesis.source.rawEvidenceSaid ||
            prepared.withSourceChoiceSaid !==
              c2.hypothesis.publicReplay.predictedSourceChoiceSaid ||
            prepared.withSourceAction !== c2.hypothesis.publicReplay.predictedAction ||
            !isSaid(prepared.readReceiptSaid) ||
            (prepared.withoutSource.kind === 'Chosen'
              ? !isSaid(prepared.withoutSource.sourceChoiceSaid) ||
                prepared.withoutSource.action.length === 0 ||
                (prepared.withSourceChoiceSaid === prepared.withoutSource.sourceChoiceSaid &&
                  prepared.withSourceAction === prepared.withoutSource.action)
              : prepared.withoutSource.sourceSpecificTo !== c2.hypothesis.source.episodeSaid) ||
            typeof prepared.contextText !== 'string' ||
            prepared.contextText.trim().length === 0 ||
            Buffer.byteLength(prepared.contextText, 'utf8') > 32 * 1024
          )
            throw new Error('C2 qualified workflow transition unavailable.');
          const contextReceiptSaid = await raw({
            version: 1,
            kind: 'C2WorkflowContextBound',
            evaluationId: binding.evaluationId,
            manifestSaid: input.manifest.d,
            slot: input.slot,
            successorRevisionSaid: input.reviewedBehaviorSaid,
            hypothesisSaid: prepared.hypothesisSaid,
            failureWindowSaid: prepared.failureWindowSaid,
            sourceInventorySaid: prepared.sourceInventorySaid,
            originalHypothesisQueryReceiptSaid: c2.hypothesis.retrievalReceiptSaid,
            queryReceiptSaid: prepared.queryReceiptSaid,
            readReceiptSaid: prepared.readReceiptSaid,
            sourceEvidenceSaid: prepared.sourceEvidenceSaid,
            withSourceChoiceSaid: prepared.withSourceChoiceSaid,
            withSourceAction: prepared.withSourceAction,
            withoutSource: prepared.withoutSource,
            contextText: prepared.contextText,
          });
          await append({
            kind: 'ArtifactCaptured',
            artifactSaid: contextReceiptSaid,
            custody: 'Public',
          });
          await relay.send('WorkflowContext', {
            version: 1,
            kind: 'ReviewedC2WorkflowContext',
            text: prepared.contextText,
          });
        }
        let provisional:
          | {
              readonly eventSaid: string;
              readonly artifactSaids: readonly string[];
            }
          | undefined;
        for (;;) {
          if (interrupted(input.signal)) throw new Error('Evaluation trial interrupted.');
          const frame = await relay.receive();
          if (provisional !== undefined && frame.kind !== 'Stopped')
            throw new Error('C2 worker continued after provisional submission.');
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
            const selected =
              c3FormatEdit === undefined
                ? undefined
                : await config.c3Selection?.select({
                    binding,
                    edit: c3FormatEdit,
                    signal: input.signal,
                  });
            if (c3FormatEdit !== undefined && selected?.kind !== 'Selected')
              throw new Error('C3 authorized public context selection unavailable.');
            const modelContext =
              selected?.kind === 'Selected'
                ? {
                    ...(body.context as unknown as TranscriptContext),
                    messages: [
                      ...(body.context.messages as TranscriptContext['messages']),
                      {
                        role: 'user' as const,
                        content: `Reviewed public history for versioned-format edit:\n${selected.contextText}`,
                        timestamp: Date.now(),
                      },
                    ],
                  }
                : (body.context as unknown as TranscriptContext);
            c3FormatEdit = undefined;
            const completion = await config.modelInference.complete({
              binding,
              requestOrdinal,
              modelProfileSaid: config.modelProfileSaid,
              context: modelContext,
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
            const usage = accountableProviderUsage(message, completion.verifiedSpendMicroUsd);
            if (
              !isSaid(completion.usageEventSaid) ||
              message.provider !== config.model.provider ||
              message.model !== config.model.id ||
              !Array.isArray(message.content)
            )
              throw new Error('Evaluation model completion identity invalid.');
            if (usage === undefined)
              return {
                kind: 'Invalid',
                reason: 'UnknownUsage',
                ...(evidenceHead === undefined ? {} : { evidenceHeadSaid: evidenceHead }),
              };
            const exchange = await raw({
              kind: 'ModelExchange',
              requestOrdinal,
              context: modelContext,
              ...(selected?.kind === 'Selected'
                ? {
                    c3Selection: {
                      treatmentArtifactSaid: selected.treatmentArtifactSaid,
                      formatEditEventSaid: selected.formatEditEventSaid,
                      includedSourceIds: selected.includedSourceIds,
                      excludedSourceIds: selected.excludedSourceIds,
                      contextBytes: selected.contextBytes,
                    },
                  }
                : {}),
              message,
              usageEventSaid: completion.usageEventSaid,
            });
            const exchangeEventSaid = await append({
              kind: 'ModelExchange',
              rawArtifactSaid: exchange,
            });
            if (selected?.kind === 'Selected') {
              const selectionReceipt = await raw({
                version: 1,
                kind: 'C3ContextSelectionApplied',
                manifestSaid: input.manifest.d,
                successorRevisionSaid: input.reviewedBehaviorSaid,
                sourceInventorySaid: selected.sourceInventorySaid,
                treatmentArtifactSaid: selected.treatmentArtifactSaid,
                formatEditEventSaid: selected.formatEditEventSaid,
                modelExchangeEventSaid: exchangeEventSaid,
                includedSourceIds: selected.includedSourceIds,
                excludedSourceIds: selected.excludedSourceIds,
                contextBytes: selected.contextBytes,
                providerInputTokensForRequest: usage.inputTokens,
                verifiedSpendMicroUsdForRequest: completion.verifiedSpendMicroUsd,
                usageEventSaid: completion.usageEventSaid,
              });
              await append({
                kind: 'ArtifactCaptured',
                artifactSaid: selectionReceipt,
                custody: 'Public',
              });
            }
            const usageReceipt = await raw({
              kind: 'EvaluationProviderUsage',
              requestOrdinal,
              modelExchangeEventSaid: exchangeEventSaid,
              usageEventSaid: completion.usageEventSaid,
              provider: message.provider,
              model: message.model,
              responseId: message.responseId,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              cacheReadTokens: message.usage.cacheRead,
              cacheWriteTokens: message.usage.cacheWrite,
              spendMicroUsd: completion.verifiedSpendMicroUsd,
            });
            await append({
              kind: 'ArtifactCaptured',
              artifactSaid: usageReceipt,
              custody: 'Public',
            });
            await debit('providerRequests', 1, usageReceipt, exchangeEventSaid);
            await debit('providerInputTokens', usage.inputTokens, usageReceipt, exchangeEventSaid);
            await debit(
              'providerOutputTokens',
              usage.outputTokens,
              usageReceipt,
              exchangeEventSaid,
            );
            await debit(
              'providerSpendMicroUsd',
              completion.verifiedSpendMicroUsd,
              usageReceipt,
              exchangeEventSaid,
            );
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
            if (input.slot.arm === 'C2' && expected.name === 'submit_result') {
              if (
                proposal.input.kind !== 'SubmitResult' ||
                c2 === undefined ||
                expectedCalls.length !== 0
              )
                throw new Error('C2 provisional submission invalid.');
              const authorized = await c2.submission.authorize({
                binding,
                proposal,
                signal: input.signal,
              });
              if (authorized.kind !== 'Authorized')
                throw new Error('C2 provisional submission was not authorized.');
              const authorizationReceiptSaid = await raw({
                kind: 'C2ProvisionalSubmissionAuthorized',
                proposalEventSaid: proposedEvent,
              });
              await append({
                kind: 'ArtifactCaptured',
                artifactSaid: authorizationReceiptSaid,
                custody: 'Public',
              });
              await debit('toolProposals', 1, authorizationReceiptSaid, proposedEvent);
              provisional = {
                eventSaid: proposedEvent,
                artifactSaids: proposal.input.artifactSaids,
              };
              await relay.send('ProvisionalStop', {
                proposalEventSaid: proposedEvent,
              });
              proposalIndex += 1;
              continue;
            }
            const started = performance.now();
            const outcome = await gateway.propose(binding, proposal, input.signal);
            const measured = measuredToolElapsed(started, performance.now());
            if (measured === undefined)
              return {
                kind: 'Invalid',
                reason: 'UnknownUsage',
                ...(evidenceHead === undefined ? {} : { evidenceHeadSaid: evidenceHead }),
              };
            const nativeCommand = ['run_formatter', 'run_static_analysis', 'run_tests'].includes(
              expected.name,
            );
            let childCommandSeconds: number | undefined;
            if (nativeCommand) {
              // The trusted parent can bound child time by the complete Gateway round trip;
              // the frozen outcome port does not expose exact child-only process duration.
              if (outcome.kind === 'Completed' || outcome.kind === 'Failed')
                childCommandSeconds = Math.max(1, Math.ceil(measured.elapsedMilliseconds / 1_000));
              else if (
                outcome.kind === 'ApprovalRequired' ||
                (outcome.kind === 'Rejected' && outcome.reason !== 'BudgetExhausted')
              )
                childCommandSeconds = 0;
              else
                return {
                  kind: 'Invalid',
                  reason: 'UnknownUsage',
                  ...(evidenceHead === undefined ? {} : { evidenceHeadSaid: evidenceHead }),
                };
              nativeCommandObserved = true;
            }
            const toolReceipt = await raw({
              kind: 'EvaluationToolElapsed',
              proposalEventSaid: proposedEvent,
              toolCallId: proposal.toolCallId,
              proposalIndex,
              toolName: expected.name,
              ...measured,
              outcomeKind: outcome.kind,
              childCommandDuration: nativeCommand
                ? childCommandSeconds === 0
                  ? 'NotExecuted'
                  : 'GatewayRoundTripUpperBound'
                : 'NotApplicable',
              ...(childCommandSeconds === undefined
                ? {}
                : { childCommandDebitedSeconds: childCommandSeconds }),
            });
            await append({
              kind: 'ArtifactCaptured',
              artifactSaid: toolReceipt,
              custody: 'Public',
            });
            await debit('toolProposals', 1, toolReceipt, proposedEvent);
            if (childCommandSeconds !== undefined)
              await debit(
                'aggregateChildCommandTimeSeconds',
                childCommandSeconds,
                toolReceipt,
                proposedEvent,
              );
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
            if (
              c3Bound?.kind === 'Bound' &&
              outcome.kind === 'Completed' &&
              (proposal.input.kind === 'WriteFile' || proposal.input.kind === 'ReplaceText')
            ) {
              const path = proposal.input.path;
              const content =
                proposal.input.kind === 'WriteFile'
                  ? proposal.input.content
                  : proposal.input.newText;
              if (
                c3Bound.policy.triggerPaths.includes(path) &&
                content.includes(c3Bound.policy.formatMarker)
              )
                c3FormatEdit = { path, content, proposalEventSaid: proposedEvent };
            }
            await relay.send('ToolOutcome', outcome);
            proposalIndex += 1;
            continue;
          }
          if (frame.kind === 'Stopped') {
            if (
              !isRecord(frame.payload) ||
              frame.payload.piSessionId !== sessionId ||
              (provisional === undefined
                ? !['Submitted', 'NoSubmission'].includes(String(frame.payload.kind))
                : frame.payload.kind !== 'Provisional') ||
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
        if (c2 !== undefined && provisional === undefined)
          throw new Error('C2 worker did not propose a public-gated submission.');
        if (provisional !== undefined && !(await compartment.stopWriters()))
          throw new Error('C2 source writers survived provisional stop.');
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
        const stoppedSourceEvent = await append({
          kind: 'ArtifactCaptured',
          artifactSaid: captured.sourceSaid,
          custody: 'Public',
        });
        const changes = measureEvaluationSourceChanges(clean.files, stopped.files);
        if (changes === undefined)
          return {
            kind: 'Invalid',
            reason: 'UnknownUsage',
            ...(evidenceHead === undefined ? {} : { evidenceHeadSaid: evidenceHead }),
          };
        const sourceReceipt = await raw({
          kind: 'EvaluationSourceChanges',
          beforeSourceSaid: input.cleanSourceSaid,
          afterSourceSaid: captured.sourceSaid,
          changedByteRule: 'MaxPrePostLengthPerChangedPath',
          ...changes,
        });
        await append({
          kind: 'ArtifactCaptured',
          artifactSaid: sourceReceipt,
          custody: 'Public',
        });
        await debit('changedFiles', changes.changedFiles, sourceReceipt, stoppedSourceEvent);
        await debit(
          'changedWorktreeBytes',
          changes.changedWorktreeBytes,
          sourceReceipt,
          stoppedSourceEvent,
        );
        if (provisional !== undefined) {
          if (c2 === undefined) throw new Error('C2 public verification unavailable.');
          const verification = await c2.verification.verify({
            binding,
            manifest: input.manifest,
            slot: input.slot,
            successorRevisionSaid: input.reviewedBehaviorSaid,
            proposedArtifactSaids: provisional.artifactSaids,
            proposalEventSaid: provisional.eventSaid,
            capturedSourceSaid: captured.sourceSaid,
            signal: input.signal,
          });
          const publicGate = assessC2PublicSubmission(
            { capturedSourceSaid: captured.sourceSaid, proposalEventSaid: provisional.eventSaid },
            verification,
          );
          if (
            publicGate.kind === 'Invalid' ||
            (await storeRawBytes(publicGate.bytes)) !== publicGate.receiptSaid
          )
            throw new Error('C2 fresh public verification unavailable or unbound.');
          await append({
            kind: 'ArtifactCaptured',
            artifactSaid: publicGate.receiptSaid,
            custody: 'Public',
          });
          if (publicGate.kind === 'Negative') {
            await append({
              kind: 'ToolAuthorization',
              proposalEventSaid: provisional.eventSaid,
              disposition: 'Denied',
              receiptArtifactSaid: publicGate.receiptSaid,
            });
          } else {
            const authorizationEventSaid = await append({
              kind: 'ToolAuthorization',
              proposalEventSaid: provisional.eventSaid,
              disposition: 'Allowed',
              receiptArtifactSaid: publicGate.receiptSaid,
            });
            await append({
              kind: 'EffectObserved',
              authorizationEventSaid,
              receiptArtifactSaid: publicGate.receiptSaid,
            });
          }
        }
        const cleanupConfirmed = await compartment.close();
        compartment = undefined;
        if (!cleanupConfirmed)
          return {
            kind: 'Invalid',
            reason: 'CleanupUnconfirmed',
            ...(evidenceHead === undefined ? {} : { evidenceHeadSaid: evidenceHead }),
          };
        const cleanupReceipt = await raw({ kind: 'Cleanup', bindingId, confirmed: true });
        const cleanupEvent = await append({
          kind: 'ArtifactCaptured',
          artifactSaid: cleanupReceipt,
          custody: 'Public',
        });
        if (!nativeCommandObserved) {
          const noCommandReceipt = await raw({
            kind: 'EvaluationChildCommands',
            method: 'NoNativeCommandToolEffect',
            bindingId,
            debitedSeconds: 0,
          });
          await append({
            kind: 'ArtifactCaptured',
            artifactSaid: noCommandReceipt,
            custody: 'Public',
          });
          await debit('aggregateChildCommandTimeSeconds', 0, noCommandReceipt, cleanupEvent);
        }
        const wall = measuredToolElapsed(trialStarted, performance.now());
        if (wall === undefined)
          return {
            kind: 'Invalid',
            reason: 'UnknownUsage',
            ...(evidenceHead === undefined ? {} : { evidenceHeadSaid: evidenceHead }),
          };
        const wallSeconds = Math.max(1, Math.ceil(wall.elapsedMilliseconds / 1_000));
        const wallReceipt = await raw({
          kind: 'EvaluationWallElapsed',
          method: 'ParentMonotonicStartThroughCleanup',
          bindingId,
          ...wall,
          debitedSeconds: wallSeconds,
          cleanupEventSaid: cleanupEvent,
        });
        await append({ kind: 'ArtifactCaptured', artifactSaid: wallReceipt, custody: 'Public' });
        await debit('runWallTimeSeconds', wallSeconds, wallReceipt, cleanupEvent);
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
