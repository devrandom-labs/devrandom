import {
  validateExecutionBinding,
  type ComparisonSlot,
  type EvaluationExecutionBinding,
} from '@devrandom/domain';
import {
  decodeBaselineHarnessRevision,
  decodeEvidenceArtifact,
  decodeEvaluationExecutionProfile,
  decodeEvaluationManifest,
  decodeEvolutionHypothesis,
  decodeSuccessorHarnessRevision,
  type EvaluationManifest,
  type EvaluationExecutionProfile,
  type EvidenceArtifact,
  type EvolutionHypothesis,
} from '@devrandom/protocol';

import {
  selectVersionedFormatHistory,
  validVersionedHistoryPolicy,
  type VersionedHistorySelection,
  type PublicHistorySource,
  type ReviewedHistoryProjection,
  type VersionedFormatHistoryPolicy,
} from '../../context/application/select-versioned-format-history.js';
import type { ExecutableSuccessorDescriptor } from '../../harness/application/materialize-successor.js';
import { digestRunRuntimePrompt } from '../../run/run-execution-profile-custody.js';

/** Exact two-file immutable Git custody of the parent-reviewed C3 treatment. */
export interface C3ContextTreatmentCustody {
  read(input: {
    readonly repositoryDirectory: string;
    readonly parentCommit: string;
    readonly parentTree: string;
    readonly candidateCommit: string;
    readonly candidateTree: string;
    readonly configuration: EvidenceArtifact;
    readonly implementation: EvidenceArtifact;
    readonly signal: AbortSignal;
  }): Promise<
    | {
        readonly kind: 'Read';
        readonly configurationBytes: Uint8Array;
        readonly implementationBytes: Uint8Array;
      }
    | { readonly kind: 'Denied' | 'Unavailable' }
  >;
}

/** Current owner/Task/inventory authorized public history, never protected evaluator bytes. */
export interface AuthorizedEvaluationHistory {
  read(input: {
    readonly binding: EvaluationExecutionBinding;
    readonly sourceInventorySaid: string;
    readonly formatMarker: string;
    readonly signal: AbortSignal;
  }): Promise<
    | {
        readonly kind: 'Read';
        readonly taskId: string;
        readonly taskRevisionSaid: string;
        readonly sourceInventorySaid: string;
        readonly sources: readonly PublicHistorySource[];
      }
    | { readonly kind: 'Denied' | 'Unavailable' }
  >;
}

export interface C3ContextSelection {
  bind(input: {
    readonly binding: EvaluationExecutionBinding;
    readonly manifest: EvaluationManifest;
    readonly slot: ComparisonSlot;
    readonly profile: EvaluationExecutionProfile;
    readonly baseSystemPrompt: string;
    readonly taskPrompt: string;
    readonly signal: AbortSignal;
  }): Promise<
    | {
        readonly kind: 'Bound';
        readonly policy: VersionedFormatHistoryPolicy;
        readonly treatmentArtifactSaid: string;
        readonly implementationArtifactSaid: string;
        readonly bindingReceiptBytes: Uint8Array;
        readonly treatmentBytes: Uint8Array;
      }
    | { readonly kind: 'Blocked' }
  >;
  select(input: {
    readonly binding: EvaluationExecutionBinding;
    readonly edit: {
      readonly path: string;
      readonly content: string;
      readonly proposalEventSaid: string;
    };
    readonly signal: AbortSignal;
  }): Promise<
    | {
        readonly kind: 'Selected';
        readonly treatmentArtifactSaid: string;
        readonly sourceInventorySaid: string;
        readonly formatEditEventSaid: string;
        readonly includedSourceIds: readonly string[];
        readonly excludedSourceIds: readonly string[];
        readonly contextText: string;
        readonly contextBytes: number;
      }
    | { readonly kind: 'Blocked' }
  >;
}

export interface ReviewedC3ContextDependencies {
  readonly hypothesis: EvolutionHypothesis;
  readonly reviewed: ExecutableSuccessorDescriptor;
  readonly successorBytes: Uint8Array;
  readonly repositoryDirectory: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
  readonly custody: C3ContextTreatmentCustody;
  readonly history: AuthorizedEvaluationHistory;
  readonly projection: ReviewedHistoryProjection;
}

const sha1 = /^[a-f0-9]{40}$/u;
const said = /^[A-Z][A-Za-z0-9_-]{43}$/u;

function canonicalJson(bytes: Uint8Array, maximum: number): unknown {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > maximum)
    return undefined;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const parsed: unknown = JSON.parse(text);
    return JSON.stringify(parsed) === text ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function strictPolicy(value: unknown): value is VersionedFormatHistoryPolicy {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const document = value as {
    readonly version?: unknown;
    readonly arm?: unknown;
    readonly formatMarker?: unknown;
    readonly triggerPaths?: unknown;
    readonly priority?: unknown;
    readonly maximumItems?: unknown;
    readonly maximumContextBytes?: unknown;
  };
  return (
    Object.keys(document).sort().join(',') ===
      'arm,formatMarker,maximumContextBytes,maximumItems,priority,triggerPaths,version' &&
    document.version === 1 &&
    document.arm === 'C3' &&
    typeof document.formatMarker === 'string' &&
    Array.isArray(document.triggerPaths) &&
    document.triggerPaths.every((path: unknown) => typeof path === 'string') &&
    Array.isArray(document.priority) &&
    document.priority.every(
      (kind: unknown) => kind === 'Failure' || kind === 'Contract' || kind === 'Edit',
    ) &&
    typeof document.maximumItems === 'number' &&
    typeof document.maximumContextBytes === 'number' &&
    validVersionedHistoryPolicy(document as unknown as VersionedFormatHistoryPolicy)
  );
}

function strictImplementation(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const document = value as {
    readonly version?: unknown;
    readonly kind?: unknown;
    readonly algorithm?: unknown;
  };
  return (
    Object.keys(document).sort().join(',') === 'algorithm,kind,version' &&
    document.version === 1 &&
    document.kind === 'VersionedFormatContextSelection' &&
    document.algorithm === 'ExactPublicHistoryV1'
  );
}

function interrupted(signal: AbortSignal): boolean {
  return signal.aborted;
}

interface BoundSelection {
  readonly binding: EvaluationExecutionBinding;
  readonly policy: VersionedFormatHistoryPolicy;
  readonly treatmentArtifactSaid: string;
  readonly sourceInventorySaid: string;
}

/** The parent binds one reviewed C3 policy and selects current exact public history only
 * after a mediated versioned-format edit. It never changes H1 tools or system prompt. */
export class ReviewedC3ContextSelection implements C3ContextSelection {
  readonly #dependencies: ReviewedC3ContextDependencies;
  #bound: BoundSelection | undefined;

  constructor(dependencies: ReviewedC3ContextDependencies) {
    this.#dependencies = dependencies;
  }

  async bind(
    input: Parameters<C3ContextSelection['bind']>[0],
  ): ReturnType<C3ContextSelection['bind']> {
    if (this.#bound !== undefined) return { kind: 'Blocked' };
    const dependencies = this.#dependencies;
    const { binding, manifest, profile } = input;
    const phase = binding.phase;
    const reviewed = dependencies.reviewed;
    const h1 = decodeBaselineHarnessRevision(reviewed.h1);
    const successor = decodeSuccessorHarnessRevision(
      canonicalJson(dependencies.successorBytes, 16 * 1024),
    );
    const hypothesis = decodeEvolutionHypothesis(dependencies.hypothesis);
    if (
      input.signal.aborted ||
      validateExecutionBinding(binding).kind !== 'Accepted' ||
      decodeEvaluationManifest(manifest).kind !== 'Accepted' ||
      decodeEvaluationExecutionProfile(profile).kind !== 'Accepted' ||
      h1.kind !== 'Accepted' ||
      successor.kind !== 'Accepted' ||
      hypothesis.kind !== 'Accepted' ||
      phase.kind !== 'Trial' ||
      phase.arm !== 'C3' ||
      phase.manifestSaid !== manifest.d ||
      phase.repetition !== input.slot.repetition ||
      phase.attempt !== input.slot.attempt ||
      input.slot.arm !== 'C3' ||
      binding.evaluationId !== manifest.evaluationId ||
      binding.taskId !== manifest.taskId ||
      binding.taskRevisionSaid !== manifest.taskRevisionSaid ||
      binding.originRunId !== manifest.originRunId ||
      binding.personalAgentAid !== manifest.personalAgentAid ||
      binding.taskMandateSaid !== manifest.taskMandateSaid ||
      binding.harnessRevisionSaid !== manifest.revisions.C3 ||
      manifest.executionProfileSaid !== profile.d ||
      manifest.hypothesisSaid !== dependencies.hypothesis.d ||
      dependencies.hypothesis.implicatedComponent !== 'ContextSelection' ||
      dependencies.hypothesis.sourceInventorySaid !== manifest.sourceInventorySaid ||
      reviewed.treatment.kind !== 'ContextSelection' ||
      reviewed.implementation === undefined ||
      reviewed.replay === undefined ||
      reviewed.binding.arm !== 'C3' ||
      reviewed.binding.parentRevisionSaid !== reviewed.h1.d ||
      reviewed.binding.h0Said !== dependencies.hypothesis.d ||
      reviewed.binding.taskRevisionSaid !== manifest.taskRevisionSaid ||
      reviewed.binding.sourceInventorySaid !== manifest.sourceInventorySaid ||
      reviewed.binding.executionProfileSaid !== profile.d ||
      reviewed.successorRevisionSaid !== manifest.revisions.C3 ||
      successor.revision.arm !== 'C3' ||
      successor.revision.d !== manifest.revisions.C3 ||
      successor.revision.parentRevisionSaid !== h1.revision.d ||
      successor.revision.h0Said !== dependencies.hypothesis.d ||
      successor.revision.taskRevisionSaid !== manifest.taskRevisionSaid ||
      successor.revision.sourceInventorySaid !== manifest.sourceInventorySaid ||
      successor.revision.executionProfileSaid !== profile.d ||
      reviewed.configuration.d !== successor.revision.configurationArtifactSaid ||
      reviewed.implementation.d !== successor.revision.treatment.reviewedImplementationSaid ||
      reviewed.replay.d !== successor.revision.treatment.publicReplayReceiptSaid ||
      manifest.revisions.H1 !== h1.revision.d ||
      manifest.taskId !== h1.revision.task.taskId ||
      manifest.taskRevisionSaid !== h1.revision.task.revisionSaid ||
      manifest.personalAgentAid !== h1.revision.authority.personalAgentAid ||
      manifest.taskMandateSaid !== h1.revision.authority.taskMandateSaid ||
      h1.revision.repository.objectFormat !== 'sha1' ||
      h1.revision.repository.commit !== profile.sourceGitCommit ||
      h1.revision.repository.tree !== profile.sourceGitTree ||
      !sha1.test(dependencies.candidateCommit) ||
      !sha1.test(dependencies.candidateTree) ||
      digestRunRuntimePrompt(input.baseSystemPrompt, input.taskPrompt) !==
        profile.h1RuntimePromptDigest
    )
      return { kind: 'Blocked' };
    let treatment: Awaited<ReturnType<C3ContextTreatmentCustody['read']>>;
    try {
      treatment = await dependencies.custody.read({
        repositoryDirectory: dependencies.repositoryDirectory,
        parentCommit: h1.revision.repository.commit,
        parentTree: h1.revision.repository.tree,
        candidateCommit: dependencies.candidateCommit,
        candidateTree: dependencies.candidateTree,
        configuration: reviewed.configuration,
        implementation: reviewed.implementation,
        signal: input.signal,
      });
    } catch {
      return { kind: 'Blocked' };
    }
    if (
      treatment.kind !== 'Read' ||
      decodeEvidenceArtifact(reviewed.configuration, treatment.configurationBytes).kind !==
        'Accepted' ||
      decodeEvidenceArtifact(reviewed.implementation, treatment.implementationBytes).kind !==
        'Accepted'
    )
      return { kind: 'Blocked' };
    const policy = canonicalJson(treatment.configurationBytes, 32 * 1024);
    const implementation = canonicalJson(treatment.implementationBytes, 128 * 1024);
    if (!strictPolicy(policy) || !strictImplementation(implementation)) return { kind: 'Blocked' };
    const receiptBytes = Buffer.from(
      JSON.stringify({
        version: 1,
        kind: 'C3ContextSelectionBound',
        manifestSaid: manifest.d,
        executionProfileSaid: profile.d,
        h1RevisionSaid: h1.revision.d,
        successorRevisionSaid: successor.revision.d,
        hypothesisSaid: dependencies.hypothesis.d,
        candidateCommit: dependencies.candidateCommit,
        candidateTree: dependencies.candidateTree,
        treatmentArtifactSaid: reviewed.configuration.d,
        implementationArtifactSaid: reviewed.implementation.d,
        baselinePromptDigest: profile.h1RuntimePromptDigest,
      }),
      'utf8',
    );
    this.#bound = {
      binding: structuredClone(binding),
      policy,
      treatmentArtifactSaid: reviewed.configuration.d,
      sourceInventorySaid: manifest.sourceInventorySaid,
    };
    return {
      kind: 'Bound',
      policy,
      treatmentArtifactSaid: reviewed.configuration.d,
      implementationArtifactSaid: reviewed.implementation.d,
      bindingReceiptBytes: receiptBytes,
      treatmentBytes: Uint8Array.from(treatment.configurationBytes),
    };
  }

  async select(
    input: Parameters<C3ContextSelection['select']>[0],
  ): ReturnType<C3ContextSelection['select']> {
    const bound = this.#bound;
    if (
      bound === undefined ||
      interrupted(input.signal) ||
      JSON.stringify(input.binding) !== JSON.stringify(bound.binding) ||
      !said.test(input.edit.proposalEventSaid)
    )
      return { kind: 'Blocked' };
    let history: Awaited<ReturnType<AuthorizedEvaluationHistory['read']>>;
    try {
      history = await this.#dependencies.history.read({
        binding: input.binding,
        sourceInventorySaid: bound.sourceInventorySaid,
        formatMarker: bound.policy.formatMarker,
        signal: input.signal,
      });
    } catch {
      return { kind: 'Blocked' };
    }
    if (
      history.kind !== 'Read' ||
      history.taskId !== input.binding.taskId ||
      history.taskRevisionSaid !== input.binding.taskRevisionSaid ||
      history.sourceInventorySaid !== bound.sourceInventorySaid
    )
      return { kind: 'Blocked' };
    const selection: VersionedHistorySelection = await selectVersionedFormatHistory(
      {
        policy: bound.policy,
        taskId: input.binding.taskId,
        taskRevisionSaid: input.binding.taskRevisionSaid,
        sourceInventorySaid: bound.sourceInventorySaid,
        edit: input.edit,
        sources: history.sources,
      },
      this.#dependencies.projection,
    );
    if (selection.kind !== 'Selected' || interrupted(input.signal)) return { kind: 'Blocked' };
    return {
      ...selection,
      treatmentArtifactSaid: bound.treatmentArtifactSaid,
      sourceInventorySaid: bound.sourceInventorySaid,
      formatEditEventSaid: input.edit.proposalEventSaid,
    };
  }
}
