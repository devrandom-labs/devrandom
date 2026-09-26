import {
  decodeEvolutionHypothesis,
  decodeQualifiedFailureWindow,
  type EvaluationSourceInventory,
} from '@devrandom/protocol';
import {
  reviewEvolutionHypothesisInfluence,
  type ReviewedRunRecovery,
  type ExperienceRetrieval,
  type EvidenceReading,
  type ReviewedAnalogyProjection,
  type ReviewedChoiceRecalculation,
} from '@devrandom/runtime';
import type { QualifiedHypothesisConstruction } from '../../evolution/application/construct-qualified-hypothesis.js';

const interrupted = (signal: AbortSignal) => signal.aborted;

/** Repeats the reviewed retrieve/read/replan workflow under current Run authority, not trial identity. */
export interface QualifiedRunRecoveryDependencies {
  readonly constructed: Pick<QualifiedHypothesisConstruction, 'hypothesis' | 'window'>;
  readonly inventory: EvaluationSourceInventory;
  readonly retrieval: ExperienceRetrieval;
  readonly reading: EvidenceReading;
  readonly projection: ReviewedAnalogyProjection;
  readonly choice: ReviewedChoiceRecalculation;
}
export class QualifiedRunRecovery implements ReviewedRunRecovery {
  readonly #dependencies: QualifiedRunRecoveryDependencies;
  constructor(dependencies: QualifiedRunRecoveryDependencies) {
    this.#dependencies = dependencies;
  }
  async recover(
    input: Parameters<ReviewedRunRecovery['recover']>[0],
  ): ReturnType<ReviewedRunRecovery['recover']> {
    const dependencies = this.#dependencies;
    const hypothesis = dependencies.constructed.hypothesis;
    const window = decodeQualifiedFailureWindow(
      dependencies.constructed.window.artifact,
      dependencies.constructed.window.bytes,
    );
    if (
      interrupted(input.signal) ||
      window.kind !== 'Accepted' ||
      decodeEvolutionHypothesis(hypothesis).kind !== 'Accepted' ||
      input.successor.binding.arm !== 'C2' ||
      input.successor.binding.h0Said !== hypothesis.d ||
      input.successor.binding.sourceInventorySaid !== dependencies.inventory.d ||
      input.run.currentExecution?.harnessRevisionSaid !== input.successor.successorRevisionSaid ||
      input.run.binding.runId !== hypothesis.originRunId ||
      input.run.binding.taskId !== hypothesis.taskId ||
      input.run.binding.taskRevisionSaid !== hypothesis.taskRevisionSaid ||
      input.run.binding.personalAgentAid !== hypothesis.personalAgentAid ||
      input.run.binding.initialHarnessRevisionSaid !== hypothesis.parentRevisionSaid ||
      window.window.failureEventSaid !== hypothesis.failure.eventSaid ||
      window.window.verifierReceiptSaid !== hypothesis.failure.rawEvidenceSaid
    )
      return { kind: 'Rejected' };
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
    if (
      interrupted(input.signal) ||
      influence.kind !== 'Influenced' ||
      influence.review.withSource.kind !== 'Chosen'
    )
      return { kind: 'Rejected' };
    const contextText = [
      `Qualified C2 workflow for ${hypothesis.d}.`,
      `Reviewed analogous episode ${influence.review.source.episodeSaid}; exact read ${influence.review.source.readReceiptSaid}.`,
      `Observation: ${influence.review.source.observation}`,
      `Recovery hint: ${influence.review.source.recoveryHint}`,
      `Parent replanned action: ${influence.review.withSource.action}.`,
      'Use mediated tools and the original public verifier. Protected final verification follows immutable submission after all writers stop.',
    ].join('\n');
    return {
      kind: 'Recovered',
      contextText,
      receiptBytes: Buffer.from(
        JSON.stringify({
          version: 1,
          kind: 'RunRecoveryWorkflow',
          runId: input.run.binding.runId,
          segmentSaid: input.run.currentExecution.segmentSaid,
          successorRevisionSaid: input.successor.successorRevisionSaid,
          hypothesisSaid: hypothesis.d,
          queryReceiptSaid: influence.review.queryReceiptSaid,
          readReceiptSaid: influence.review.source.readReceiptSaid,
          sourceEvidenceSaid: influence.review.source.rawEvidenceSaid,
          withSource: influence.review.withSource,
          withoutSource: influence.review.withoutSource,
          contextText,
        }),
        'utf8',
      ),
    };
  }
}
