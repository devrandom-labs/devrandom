import type { ToolGatewayProposal } from '../tool-gateway/tool-gateway.js';
import { isDeepStrictEqual } from 'node:util';
import type { Run } from '@devrandom/domain';
import {
  decodeEvidenceArtifact,
  decodeSuccessorHarnessRevision,
  type SuccessorHarnessRevision,
} from '@devrandom/protocol';
import type { TranscriptContext } from '@earendil-works/pi-ai';
import type {
  ExecutableSuccessorDescriptor,
  ExactTreatmentArtifact,
} from '../harness/application/materialize-successor.js';
import type { EvidenceRecorder } from '../evidence/evidence-recorder.js';
import { digestRunRuntimePrompt } from './runtime-prompt-digest.js';

export interface SuccessorRunBehavior {
  prepare(input: {
    readonly run: Run;
    readonly executionProfileSaid: string;
    readonly baseSystemPrompt: string;
    readonly taskPrompt: string;
    readonly evidence: EvidenceRecorder;
    readonly signal: AbortSignal;
  }): Promise<
    | {
        readonly kind: 'Prepared';
        readonly systemPrompt: string;
        readonly prompt: string;
        readonly workflowContext?: string;
        readonly promptDigest: string;
      }
    | { readonly kind: 'Rejected' }
  >;
  observeProposal(proposal: ToolGatewayProposal): void;
  beforeModel(
    context: TranscriptContext,
    signal: AbortSignal,
  ): Promise<TranscriptContext | undefined>;
}

export interface ReviewedRunRecovery {
  recover(input: {
    readonly run: Run;
    readonly successor: ExecutableSuccessorDescriptor;
    readonly signal: AbortSignal;
  }): Promise<
    | {
        readonly kind: 'Recovered';
        readonly contextText: string;
        readonly receiptBytes: Uint8Array;
      }
    | { readonly kind: 'Rejected' }
  >;
}
export interface CurrentRunHistory {
  select(input: {
    readonly run: Run;
    readonly successor: ExecutableSuccessorDescriptor;
    readonly context: TranscriptContext;
    readonly edit: { readonly path: string; readonly content: string };
    readonly configuration: ExactTreatmentArtifact;
    readonly implementation: ExactTreatmentArtifact;
    readonly signal: AbortSignal;
  }): Promise<
    | {
        readonly kind: 'Selected';
        readonly context: TranscriptContext;
        readonly receiptBytes: Uint8Array;
      }
    | { readonly kind: 'Rejected' }
  >;
}

function document(bytes: Uint8Array): unknown {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    return JSON.stringify(value) === text ? value : undefined;
  } catch {
    return undefined;
  }
}
function text(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, 'utf8') <= maximum
  );
}

/** Applies only the committed reviewed delta, while retaining H1 tools, authority and model. */
export interface CommittedSuccessorRunBehaviorInput {
  readonly descriptor: ExecutableSuccessorDescriptor;
  readonly revision: SuccessorHarnessRevision;
  readonly configuration: ExactTreatmentArtifact;
  readonly implementation?: ExactTreatmentArtifact;
  readonly context: { readonly text: string; readonly sourceEventSaids: readonly string[] };
  readonly recovery?: ReviewedRunRecovery;
  readonly history?: CurrentRunHistory;
  now(): string;
}

export class CommittedSuccessorRunBehavior implements SuccessorRunBehavior {
  readonly #input: CommittedSuccessorRunBehaviorInput;
  #edit: { readonly path: string; readonly content: string } | undefined;
  #run: Run | undefined;
  #evidence: EvidenceRecorder | undefined;
  constructor(input: CommittedSuccessorRunBehaviorInput) {
    this.#input = input;
  }
  async prepare(
    input: Parameters<SuccessorRunBehavior['prepare']>[0],
  ): ReturnType<SuccessorRunBehavior['prepare']> {
    const configured = this.#input;
    const descriptor = configured.descriptor;
    const revision = configured.revision;
    if (
      this.#run !== undefined ||
      input.signal.aborted ||
      input.run.currentExecution?.harnessRevisionSaid !== revision.d ||
      decodeSuccessorHarnessRevision(revision).kind !== 'Accepted' ||
      descriptor.successorRevisionSaid !== revision.d ||
      descriptor.binding.arm !== revision.arm ||
      descriptor.binding.parentRevisionSaid !== revision.parentRevisionSaid ||
      descriptor.binding.h0Said !== revision.h0Said ||
      descriptor.binding.taskRevisionSaid !== revision.taskRevisionSaid ||
      descriptor.binding.sourceInventorySaid !== revision.sourceInventorySaid ||
      descriptor.binding.executionProfileSaid !== revision.executionProfileSaid ||
      revision.executionProfileSaid !== input.executionProfileSaid ||
      !isDeepStrictEqual(descriptor.treatment, revision.treatment) ||
      descriptor.h1.d !== input.run.binding.initialHarnessRevisionSaid ||
      revision.parentRevisionSaid !== descriptor.h1.d ||
      revision.taskRevisionSaid !== input.run.binding.taskRevisionSaid ||
      revision.configurationArtifactSaid !== configured.configuration.artifact.d ||
      !isDeepStrictEqual(descriptor.configuration, configured.configuration.artifact) ||
      decodeEvidenceArtifact(configured.configuration.artifact, configured.configuration.bytes)
        .kind !== 'Accepted' ||
      !text(configured.context.text, 24 * 1024) ||
      configured.context.sourceEventSaids.length === 0 ||
      configured.context.sourceEventSaids.length > 128
    )
      return { kind: 'Rejected' };
    let systemPrompt = input.baseSystemPrompt;
    let workflowContext: string | undefined;
    const configuration = document(configured.configuration.bytes);
    if (revision.arm === 'C1') {
      if (
        typeof configuration !== 'object' ||
        configuration === null ||
        Object.keys(configuration).sort().join(',') !== 'arm,instructionText,version' ||
        !('arm' in configuration) ||
        configuration.arm !== 'C1' ||
        !('version' in configuration) ||
        configuration.version !== 1 ||
        !('instructionText' in configuration) ||
        !text(configuration.instructionText, 8192)
      )
        return { kind: 'Rejected' };
      systemPrompt += `\n\nReviewed C1 instruction (${revision.configurationArtifactSaid}):\n${configuration.instructionText}`;
    } else {
      const implementation = configured.implementation;
      if (
        implementation === undefined ||
        descriptor.implementation?.d !== implementation.artifact.d ||
        revision.treatment.reviewedImplementationSaid !== implementation.artifact.d ||
        decodeEvidenceArtifact(implementation.artifact, implementation.bytes).kind !== 'Accepted'
      )
        return { kind: 'Rejected' };
      if (revision.arm === 'C2') {
        if (
          !isDeepStrictEqual(configuration, { version: 1, arm: 'C2' }) ||
          !isDeepStrictEqual(document(implementation.bytes), {
            version: 1,
            kind: 'RecoveryWorkflow',
            trigger: 'QualifiedRetainedFailure',
            steps: ['RetrieveExperience', 'ReadExactSource', 'Replan', 'FreshPublicVerify'],
          })
        )
          return { kind: 'Rejected' };
        const recovery = await configured.recovery?.recover({
          run: input.run,
          successor: descriptor,
          signal: input.signal,
        });
        if (
          recovery?.kind !== 'Recovered' ||
          !text(recovery.contextText, 32 * 1024) ||
          !this.#store(input.evidence, recovery.receiptBytes)
        )
          return { kind: 'Rejected' };
        workflowContext = recovery.contextText;
      } else if (configured.history === undefined) return { kind: 'Rejected' };
    }
    const prompt = `${input.taskPrompt}\n\nVerified continuation facts:\n${configured.context.text}`;
    if (!text(systemPrompt, 128 * 1024) || !text(prompt, 128 * 1024)) return { kind: 'Rejected' };
    const receipt = Buffer.from(
      JSON.stringify({
        version: 1,
        kind: 'CommittedSuccessorRunBehavior',
        runId: input.run.binding.runId,
        segmentSaid: input.run.currentExecution.segmentSaid,
        h1RevisionSaid: descriptor.h1.d,
        successorRevisionSaid: revision.d,
        configurationArtifactSaid: revision.configurationArtifactSaid,
        baselinePromptDigest: digestRunRuntimePrompt(input.baseSystemPrompt, input.taskPrompt),
        workerPromptDigest: digestRunRuntimePrompt(systemPrompt, prompt),
        context: configured.context,
      }),
      'utf8',
    );
    for (const artifact of [
      configured.configuration,
      ...(configured.implementation === undefined ? [] : [configured.implementation]),
    ])
      if (!this.#store(input.evidence, artifact.bytes)) return { kind: 'Rejected' };
    if (!this.#store(input.evidence, receipt)) return { kind: 'Rejected' };
    this.#run = input.run;
    this.#evidence = input.evidence;
    return {
      kind: 'Prepared',
      systemPrompt,
      prompt,
      ...(workflowContext === undefined ? {} : { workflowContext }),
      promptDigest: digestRunRuntimePrompt(systemPrompt, prompt),
    };
  }
  #store(evidence: EvidenceRecorder, bytes: Uint8Array): boolean {
    const stored = evidence.storeArtifact({ bytes, mediaType: 'application/json' });
    if (stored.kind !== 'Stored' && stored.kind !== 'AlreadyStored') return false;
    return (
      evidence.record({
        occurredAt: this.#input.now(),
        producer: { kind: 'RunSupervisor' },
        event: {
          kind: 'ContextSummary',
          sourceEventSaids: [...this.#input.context.sourceEventSaids],
          summaryArtifactSaid: stored.artifact.d,
        },
      }).kind === 'Recorded'
    );
  }
  observeProposal(proposal: ToolGatewayProposal): void {
    if (proposal.input.kind === 'WriteFile')
      this.#edit = { path: proposal.input.path, content: proposal.input.content };
    else if (proposal.input.kind === 'ReplaceText')
      this.#edit = { path: proposal.input.path, content: proposal.input.newText };
  }
  async beforeModel(
    context: TranscriptContext,
    signal: AbortSignal,
  ): Promise<TranscriptContext | undefined> {
    if (this.#run === undefined || this.#evidence === undefined || signal.aborted) return undefined;
    if (this.#input.revision.arm !== 'C3' || this.#edit === undefined) return context;
    if (this.#input.implementation === undefined) return undefined;
    const selected = await this.#input.history?.select({
      run: this.#run,
      successor: this.#input.descriptor,
      context,
      edit: this.#edit,
      configuration: this.#input.configuration,
      implementation: this.#input.implementation,
      signal,
    });
    return selected?.kind === 'Selected' && this.#store(this.#evidence, selected.receiptBytes)
      ? selected.context
      : undefined;
  }
}
