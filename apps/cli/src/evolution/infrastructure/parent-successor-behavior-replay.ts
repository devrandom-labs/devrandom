import { createHash } from 'node:crypto';

import {
  decodeBaselineHarnessRevision,
  decodeEvaluationExecutionProfile,
  decodeEvaluationSourceInventory,
  decodeEvolutionHypothesis,
  type BaselineHarnessRevision,
  type EvaluationExecutionProfile,
  type EvaluationSourceInventory,
  type EvolutionHypothesis,
} from '@devrandom/protocol';
import {
  digestRunRuntimePrompt,
  reviewEvolutionHypothesisInfluence,
  selectVersionedFormatHistory,
  type PublicHistorySource,
  type ReviewedHistoryProjection,
  type VersionedFormatHistoryPolicy,
} from '@devrandom/runtime';

import type {
  SuccessorBehaviorReplay,
  SuccessorPublicReplayInput,
} from '../application/observe-successor-public-replay.js';
import { reviewTreatmentBytes } from './parent-successor-treatment-review.js';

export interface CurrentPublicHistory {
  read(input: {
    readonly taskId: string;
    readonly taskRevisionSaid: string;
    readonly sourceInventorySaid: string;
    readonly sourceDirectory: string;
    readonly h1Commit: string;
    readonly h1Tree: string;
    readonly formatMarker: string;
  }): Promise<
    | {
        readonly kind: 'Read';
        readonly edit: { readonly path: string; readonly content: string };
        readonly sources: readonly PublicHistorySource[];
      }
    | { readonly kind: 'Unavailable' }
  >;
}

export interface ParentSuccessorBehaviorDependencies {
  readonly h1: BaselineHarnessRevision;
  readonly hypothesis: EvolutionHypothesis;
  readonly inventory: EvaluationSourceInventory;
  readonly profile: EvaluationExecutionProfile;
  readonly baseSystemPrompt: string;
  readonly taskPrompt: string;
  readonly c2: Parameters<typeof reviewEvolutionHypothesisInfluence>[1];
  readonly c3: {
    readonly history: CurrentPublicHistory;
    readonly projection: ReviewedHistoryProjection;
  };
}

function digest(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

/** Executes each reviewed treatment law on the known public H0 timeline before M. */
export class ParentSuccessorBehaviorReplay implements SuccessorBehaviorReplay {
  readonly #dependencies: ParentSuccessorBehaviorDependencies;

  constructor(dependencies: ParentSuccessorBehaviorDependencies) {
    this.#dependencies = dependencies;
  }

  async replay(input: SuccessorPublicReplayInput): ReturnType<SuccessorBehaviorReplay['replay']> {
    const { h1, hypothesis, inventory, profile } = this.#dependencies;
    if (
      decodeBaselineHarnessRevision(h1).kind !== 'Accepted' ||
      decodeEvolutionHypothesis(hypothesis).kind !== 'Accepted' ||
      decodeEvaluationSourceInventory(inventory).kind !== 'Accepted' ||
      decodeEvaluationExecutionProfile(profile).kind !== 'Accepted' ||
      input.signal.aborted ||
      hypothesis.d !== input.h0Said ||
      hypothesis.parentRevisionSaid !== h1.d ||
      hypothesis.taskId !== h1.task.taskId ||
      hypothesis.taskRevisionSaid !== h1.task.revisionSaid ||
      hypothesis.sourceInventorySaid !== inventory.d ||
      inventory.d !== input.sourceInventorySaid ||
      h1.repository.commit !== input.h1Commit ||
      h1.repository.tree !== input.h1Tree ||
      profile.sourceGitCommit !== input.h1Commit ||
      profile.sourceGitTree !== input.h1Tree ||
      digestRunRuntimePrompt(this.#dependencies.baseSystemPrompt, this.#dependencies.taskPrompt) !==
        profile.h1RuntimePromptDigest ||
      !reviewTreatmentBytes(input.arm, input.configuration.bytes, input.implementation?.bytes)
    )
      return { kind: 'Blocked' };
    if (input.arm === 'C1') {
      const config = JSON.parse(Buffer.from(input.configuration.bytes).toString('utf8')) as {
        readonly instructionText: string;
      };
      const systemPrompt = `${this.#dependencies.baseSystemPrompt}\n\nReviewed C1 instruction (${input.configurationArtifactSaid}):\n${config.instructionText}`;
      if (Buffer.byteLength(systemPrompt, 'utf8') > 128 * 1024) return { kind: 'Blocked' };
      return {
        kind: 'Replayed',
        proof: {
          kind: 'C1Instruction',
          hypothesisSaid: hypothesis.d,
          augmentedPromptDigest: digestRunRuntimePrompt(
            systemPrompt,
            this.#dependencies.taskPrompt,
          ),
        },
      };
    }
    if (input.arm === 'C2') {
      // The arm identifies the remedy; the shared H0 identifies the observed limitation.
      // Source-dependent replay, rather than a diagnosis label, admits this workflow.
      const reviewed = await reviewEvolutionHypothesisInfluence(
        {
          hypothesis,
          inventory,
          retained: {
            taskId: hypothesis.taskId,
            taskRevisionSaid: hypothesis.taskRevisionSaid,
            originRunId: hypothesis.originRunId,
            retainedCheckpointSaid: hypothesis.retainedCheckpointSaid,
            retainedSealSaid: hypothesis.retainedSealSaid,
            parentRevisionSaid: hypothesis.parentRevisionSaid,
            personalAgentAid: hypothesis.personalAgentAid,
            failureEventSaid: hypothesis.failure.eventSaid,
            failureRawEvidenceSaid: hypothesis.failure.rawEvidenceSaid,
          },
        },
        this.#dependencies.c2,
      );
      if (
        reviewed.kind !== 'Influenced' ||
        reviewed.review.withSource.kind !== 'Chosen' ||
        reviewed.review.withSource.action !== hypothesis.publicReplay.predictedAction ||
        reviewed.review.withSource.sourceChoiceSaid !==
          hypothesis.publicReplay.predictedSourceChoiceSaid ||
        reviewed.review.source.episodeSaid !== hypothesis.source.episodeSaid
      )
        return { kind: 'Blocked' };
      return {
        kind: 'Replayed',
        proof: {
          kind: 'C2Workflow',
          hypothesisSaid: hypothesis.d,
          sourceEpisodeSaid: reviewed.review.source.episodeSaid,
          readReceiptSaid: reviewed.review.source.readReceiptSaid,
          action: reviewed.review.withSource.action,
        },
      };
    }
    const policy = JSON.parse(
      Buffer.from(input.configuration.bytes).toString('utf8'),
    ) as VersionedFormatHistoryPolicy;
    let history: Awaited<ReturnType<CurrentPublicHistory['read']>>;
    try {
      history = await this.#dependencies.c3.history.read({
        taskId: hypothesis.taskId,
        taskRevisionSaid: hypothesis.taskRevisionSaid,
        sourceInventorySaid: inventory.d,
        sourceDirectory: input.sourceDirectory,
        h1Commit: input.h1Commit,
        h1Tree: input.h1Tree,
        formatMarker: policy.formatMarker,
      });
    } catch {
      return { kind: 'Blocked' };
    }
    if (history.kind !== 'Read') return { kind: 'Blocked' };
    const selected = await selectVersionedFormatHistory(
      {
        policy,
        taskId: hypothesis.taskId,
        taskRevisionSaid: hypothesis.taskRevisionSaid,
        sourceInventorySaid: inventory.d,
        edit: history.edit,
        sources: history.sources,
      },
      this.#dependencies.c3.projection,
    );
    if (selected.kind !== 'Selected' || selected.includedSourceIds.length === 0)
      return { kind: 'Blocked' };
    return {
      kind: 'Replayed',
      proof: {
        kind: 'C3ContextSelection',
        hypothesisSaid: hypothesis.d,
        includedSourceIds: selected.includedSourceIds,
        contextDigest: digest(selected.contextText),
      },
    };
  }
}
