import {
  decodeBaselineHarnessRevision,
  decodeEvaluationManifest,
  decodeEvaluationSourceInventory,
  decodeEvolutionHypothesis,
  decodeQualifiedFailureWindow,
  decodeSuccessorHarnessRevision,
  type EvaluationSourceInventory,
} from '@devrandom/protocol';
import {
  reviewEvolutionHypothesisInfluence,
  type C2WorkflowTransition,
  type C2WorkflowTreatmentCustody,
  type EvidenceReading,
  type ExecutableSuccessorDescriptor,
  type ExperienceRetrieval,
  type ReviewedAnalogyProjection,
  type ReviewedChoiceRecalculation,
} from '@devrandom/runtime';

import type { QualifiedHypothesisConstruction } from './construct-qualified-hypothesis.js';

const sha1 = /^[a-f0-9]{40}$/u;
const interrupted = (signal: AbortSignal): boolean => signal.aborted;

export interface QualifiedC2WorkflowDependencies {
  /** A trusted parent outcome from exact six-Run Q and sealed retained failure. */
  readonly constructed: QualifiedHypothesisConstruction;
  readonly inventory: EvaluationSourceInventory;
  readonly reviewed: ExecutableSuccessorDescriptor;
  readonly successorBytes: Uint8Array;
  readonly repositoryDirectory: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
  readonly custody: C2WorkflowTreatmentCustody;
  readonly retrieval: ExperienceRetrieval;
  readonly reading: EvidenceReading;
  readonly projection: ReviewedAnalogyProjection;
  readonly choice: ReviewedChoiceRecalculation;
}

function canonicalJson(bytes: Uint8Array, maximumBytes: number): unknown {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > maximumBytes)
    return undefined;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const parsed: unknown = JSON.parse(text);
    return JSON.stringify(parsed) === text ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function exactWorkflow(configurationBytes: Uint8Array, implementationBytes: Uint8Array): boolean {
  const configuration = canonicalJson(configurationBytes, 32 * 1024);
  const implementation = canonicalJson(implementationBytes, 128 * 1024);
  return (
    typeof configuration === 'object' &&
    configuration !== null &&
    !Array.isArray(configuration) &&
    Object.keys(configuration).sort().join(',') === 'arm,version' &&
    'version' in configuration &&
    configuration.version === 1 &&
    'arm' in configuration &&
    configuration.arm === 'C2' &&
    typeof implementation === 'object' &&
    implementation !== null &&
    !Array.isArray(implementation) &&
    Object.keys(implementation).sort().join(',') === 'kind,steps,trigger,version' &&
    'version' in implementation &&
    implementation.version === 1 &&
    'kind' in implementation &&
    implementation.kind === 'RecoveryWorkflow' &&
    'trigger' in implementation &&
    implementation.trigger === 'QualifiedRetainedFailure' &&
    'steps' in implementation &&
    Array.isArray(implementation.steps) &&
    (implementation.steps as readonly unknown[]).length === 4 &&
    ['RetrieveExperience', 'ReadExactSource', 'Replan', 'FreshPublicVerify'].every(
      (step, index) => (implementation.steps as readonly unknown[])[index] === step,
    )
  );
}

/** Performs the C2 workflow change in the trusted parent before the worker's first model call. */
export class QualifiedC2WorkflowTransition implements C2WorkflowTransition {
  readonly #dependencies: QualifiedC2WorkflowDependencies;

  constructor(dependencies: QualifiedC2WorkflowDependencies) {
    this.#dependencies = dependencies;
  }

  async prepare(
    input: Parameters<C2WorkflowTransition['prepare']>[0],
  ): ReturnType<C2WorkflowTransition['prepare']> {
    const dependencies = this.#dependencies;
    const constructed = dependencies.constructed;
    const hypothesis = constructed.hypothesis;
    const reviewed = dependencies.reviewed;
    const manifest = input.manifest;
    const window = decodeQualifiedFailureWindow(
      constructed.window.artifact,
      constructed.window.bytes,
    );
    const successor = decodeSuccessorHarnessRevision(
      canonicalJson(dependencies.successorBytes, 16 * 1024),
    );
    if (
      input.signal.aborted ||
      input.slot.arm !== 'C2' ||
      input.binding.phase.kind !== 'Trial' ||
      input.binding.phase.arm !== 'C2' ||
      input.binding.phase.manifestSaid !== manifest.d ||
      input.binding.phase.repetition !== input.slot.repetition ||
      input.binding.phase.attempt !== input.slot.attempt ||
      input.binding.evaluationId !== manifest.evaluationId ||
      input.binding.taskId !== manifest.taskId ||
      input.binding.taskRevisionSaid !== manifest.taskRevisionSaid ||
      input.binding.harnessRevisionSaid !== input.successorRevisionSaid ||
      decodeEvaluationManifest(manifest).kind !== 'Accepted' ||
      decodeEvolutionHypothesis(hypothesis).kind !== 'Accepted' ||
      decodeEvaluationSourceInventory(dependencies.inventory).kind !== 'Accepted' ||
      decodeBaselineHarnessRevision(reviewed.h1).kind !== 'Accepted' ||
      window.kind !== 'Accepted' ||
      successor.kind !== 'Accepted' ||
      successor.revision.arm !== 'C2' ||
      reviewed.treatment.kind !== 'ReviewedWorkflow' ||
      reviewed.implementation === undefined ||
      reviewed.replay === undefined ||
      hypothesis.implicatedComponent !== 'Workflow' ||
      constructed.influence.hypothesisSaid !== hypothesis.d ||
      constructed.influence.review.queryReceiptSaid !== hypothesis.retrievalReceiptSaid ||
      constructed.influence.review.source.rawEvidenceSaid !== hypothesis.source.rawEvidenceSaid ||
      constructed.influence.review.source.episodeSaid !== hypothesis.source.episodeSaid ||
      constructed.influence.review.fixed.publicFailureWindowSaid !==
        hypothesis.publicReplay.failureWindowSaid ||
      window.artifact.d !== hypothesis.publicReplay.failureWindowSaid ||
      window.window.taskId !== hypothesis.taskId ||
      window.window.taskRevisionSaid !== hypothesis.taskRevisionSaid ||
      window.window.originRunId !== hypothesis.originRunId ||
      window.window.retainedCheckpointSaid !== hypothesis.retainedCheckpointSaid ||
      window.window.retainedSealSaid !== hypothesis.retainedSealSaid ||
      window.window.failureEventSaid !== hypothesis.failure.eventSaid ||
      window.window.verifierReceiptSaid !== hypothesis.failure.rawEvidenceSaid ||
      manifest.hypothesisSaid !== hypothesis.d ||
      manifest.sourceInventorySaid !== dependencies.inventory.d ||
      manifest.ownerAid !== dependencies.inventory.ownerAid ||
      manifest.revisions.H1 !== reviewed.h1.d ||
      manifest.revisions.C2 !== successor.revision.d ||
      manifest.executionProfileSaid !== successor.revision.executionProfileSaid ||
      manifest.taskId !== hypothesis.taskId ||
      manifest.taskRevisionSaid !== hypothesis.taskRevisionSaid ||
      manifest.originRunId !== hypothesis.originRunId ||
      manifest.personalAgentAid !== hypothesis.personalAgentAid ||
      manifest.retainedCheckpointSaid !== hypothesis.retainedCheckpointSaid ||
      manifest.retainedSealSaid !== hypothesis.retainedSealSaid ||
      reviewed.successorRevisionSaid !== successor.revision.d ||
      reviewed.binding.arm !== 'C2' ||
      reviewed.binding.parentRevisionSaid !== reviewed.h1.d ||
      reviewed.binding.h0Said !== hypothesis.d ||
      reviewed.binding.taskRevisionSaid !== manifest.taskRevisionSaid ||
      reviewed.binding.sourceInventorySaid !== dependencies.inventory.d ||
      reviewed.binding.executionProfileSaid !== manifest.executionProfileSaid ||
      successor.revision.parentRevisionSaid !== reviewed.h1.d ||
      successor.revision.h0Said !== hypothesis.d ||
      successor.revision.taskRevisionSaid !== manifest.taskRevisionSaid ||
      successor.revision.sourceInventorySaid !== dependencies.inventory.d ||
      successor.revision.executionProfileSaid !== manifest.executionProfileSaid ||
      reviewed.configuration.d !== successor.revision.configurationArtifactSaid ||
      reviewed.implementation.d !== successor.revision.treatment.reviewedImplementationSaid ||
      reviewed.replay.d !== successor.revision.treatment.publicReplayReceiptSaid ||
      input.successorRevisionSaid !== successor.revision.d ||
      input.candidateCommit !== dependencies.candidateCommit ||
      input.candidateTree !== dependencies.candidateTree ||
      !sha1.test(input.candidateCommit) ||
      !sha1.test(input.candidateTree)
    )
      return { kind: 'Blocked' };
    let treatment: Awaited<ReturnType<C2WorkflowTreatmentCustody['read']>>;
    try {
      treatment = await dependencies.custody.read({
        repositoryDirectory: dependencies.repositoryDirectory,
        parentCommit: reviewed.h1.repository.commit,
        parentTree: reviewed.h1.repository.tree,
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
      !exactWorkflow(treatment.configurationBytes, treatment.implementationBytes)
    )
      return { kind: 'Blocked' };
    const influence = await reviewEvolutionHypothesisInfluence(
      {
        hypothesis,
        inventory: dependencies.inventory,
        retained: {
          taskId: hypothesis.taskId,
          taskRevisionSaid: hypothesis.taskRevisionSaid,
          originRunId: hypothesis.originRunId,
          retainedCheckpointSaid: hypothesis.retainedCheckpointSaid,
          retainedSealSaid: hypothesis.retainedSealSaid,
          parentRevisionSaid: hypothesis.parentRevisionSaid,
          personalAgentAid: hypothesis.personalAgentAid,
          failureEventSaid: window.window.failureEventSaid,
          failureRawEvidenceSaid: window.window.verifierReceiptSaid,
        },
      },
      dependencies,
    );
    if (influence.kind !== 'Influenced' || interrupted(input.signal)) return { kind: 'Blocked' };
    const withSource = influence.review.withSource;
    const withoutSource = influence.review.withoutSource;
    if (withSource.kind !== 'Chosen') return { kind: 'Blocked' };
    const contextText = [
      `Qualified C2 workflow for ${hypothesis.d}.`,
      `Reviewed analogous episode ${influence.review.source.episodeSaid}; exact read ${influence.review.source.readReceiptSaid}.`,
      `Observation: ${influence.review.source.observation}`,
      `Recovery hint: ${influence.review.source.recoveryHint}`,
      `Parent replanned action: ${withSource.action}.`,
      'Use the mediated tools. A submitted source is checked against the original public verifier after all writers stop.',
    ].join('\n');
    if (Buffer.byteLength(contextText, 'utf8') > 32 * 1024) return { kind: 'Blocked' };
    return {
      kind: 'Prepared',
      manifestSaid: manifest.d,
      successorRevisionSaid: successor.revision.d,
      hypothesisSaid: hypothesis.d,
      sourceInventorySaid: dependencies.inventory.d,
      failureWindowSaid: window.artifact.d,
      queryReceiptSaid: influence.review.queryReceiptSaid,
      readReceiptSaid: influence.review.source.readReceiptSaid,
      sourceEvidenceSaid: influence.review.source.rawEvidenceSaid,
      withSourceChoiceSaid: withSource.sourceChoiceSaid,
      withSourceAction: withSource.action,
      withoutSource:
        withoutSource.kind === 'Chosen'
          ? {
              kind: 'Chosen',
              action: withoutSource.action,
              sourceChoiceSaid: withoutSource.sourceChoiceSaid,
            }
          : { kind: 'Unsupported', sourceSpecificTo: withoutSource.sourceSpecificTo },
      contextText,
    };
  }
}
