import type { Collection, Db } from 'mongodb';

import type { EvaluationEligibility } from '../application/admit-evaluation.js';
import {
  evaluationCollectionNames,
  type EvaluationPreparationDocument,
} from './mongo-evaluation-reservations.js';
import type { CurrentEvaluationSourceScopes } from './current-evaluation-source-scopes.js';
import { evidenceCollectionNames } from '../../evidence/infrastructure/evidence-storage-contract.js';
import type { EvidenceCheckpointDocument } from '../../evidence/infrastructure/evidence-checkpoint-document.js';
import type { EvidenceEventDocument } from '../../evidence/infrastructure/evidence-event-document.js';
import {
  decodeEvidenceStreamDocument,
  type EvidenceStreamDocument,
} from '../../evidence/infrastructure/evidence-stream-document.js';
import { runsCollectionName } from '../../run/infrastructure/mongo-runs.js';
import { decodeRunDocument, type RunDocument } from '../../run/infrastructure/run-document.js';

/** Current source rights and the retained failure are checked before complete campaign qualification. */
export class CurrentEvaluationEligibility implements EvaluationEligibility {
  readonly #sources: CurrentEvaluationSourceScopes;
  readonly #preparations: Collection<EvaluationPreparationDocument>;
  readonly #runs: Collection<RunDocument>;
  readonly #streams: Collection<EvidenceStreamDocument>;
  readonly #checkpoints: Collection<EvidenceCheckpointDocument>;
  readonly #events: Collection<EvidenceEventDocument>;

  constructor(database: Db, sources: CurrentEvaluationSourceScopes) {
    this.#sources = sources;
    this.#preparations = database.collection(evaluationCollectionNames.preparations);
    this.#runs = database.collection(runsCollectionName);
    this.#streams = database.collection(evidenceCollectionNames.streams);
    this.#checkpoints = database.collection(evidenceCollectionNames.checkpoints);
    this.#events = database.collection(evidenceCollectionNames.events);
  }

  async inspect(
    input: Parameters<EvaluationEligibility['inspect']>[0],
  ): ReturnType<EvaluationEligibility['inspect']> {
    const { command, ownerAid } = input;
    try {
      const source = await this.#sources.inspectInventory({
        ownerAid,
        taskId: command.taskId,
        sourceInventorySaid: command.sourceInventorySaid,
      });
      if (source.kind === 'Unavailable') return { kind: 'Unavailable' };
      if (
        source.kind !== 'Authorized' ||
        source.scope.taskRevisionSaid !== command.taskRevisionSaid ||
        source.scope.mandate.kind !== 'AuthorizedExperience' ||
        source.scope.mandate.mandateSaid !== command.taskMandateSaid
      )
        return { kind: 'Blocked', gate: 'Authority' };
      const preparation = await this.#preparations.findOne({
        ownerAid,
        'command.taskId': command.taskId,
        'sourceInventory.d': command.sourceInventorySaid,
        'executionProfile.d': command.executionProfileSaid,
      });
      if (preparation === null || preparation.command.taskRevisionSaid !== command.taskRevisionSaid)
        return { kind: 'Blocked', gate: 'Profile' };
      const locatedRun = await this.#runs.findOne({ _id: command.originRunId, ownerAid });
      if (locatedRun === null) return { kind: 'Blocked', gate: 'Qualification' };
      const run = decodeRunDocument(locatedRun).run;
      if (
        run.binding.purpose.kind !== 'Retained' ||
        run.binding.taskId !== command.taskId ||
        run.binding.taskRevisionSaid !== command.taskRevisionSaid ||
        run.binding.personalAgentAid !== command.personalAgentAid ||
        run.binding.taskMandateSaid !== command.taskMandateSaid ||
        run.binding.initialHarnessRevisionSaid !== command.expectedActiveRevisionSaid ||
        run.lifecycle.kind !== 'Active' ||
        run.lifecycle.phase.kind !== 'Blocked' ||
        run.lifecycle.phase.reason !== 'HarnessCompatibilityFailure' ||
        preparation.executionProfile.sourceGitCommit !== run.binding.repository.commit ||
        preparation.executionProfile.sourceGitTree !== run.binding.repository.tree
      )
        return { kind: 'Blocked', gate: 'Qualification' };
      const streamDocument = await this.#streams.findOne({
        _id: run.binding.evidenceStreamId,
        'binding.runId': command.originRunId,
      });
      if (streamDocument === null) return { kind: 'Blocked', gate: 'Evidence' };
      const stream = decodeEvidenceStreamDocument(streamDocument);
      if (
        stream.seal.kind !== 'Sealed' ||
        stream.seal.exchangeSaid !== command.retainedSealSaid ||
        stream.cursor.kind !== 'Continued'
      )
        return { kind: 'Blocked', gate: 'Evidence' };
      const checkpoint = await this.#checkpoints.findOne({
        _id: command.retainedCheckpointSaid,
        ownerAid,
        runId: command.originRunId,
      });
      if (
        checkpoint === null ||
        checkpoint.evidenceStreamId !== run.binding.evidenceStreamId ||
        checkpoint.checkpoint.taskRevisionSaid !== command.taskRevisionSaid ||
        checkpoint.checkpoint.runId !== command.originRunId ||
        checkpoint.checkpoint.personalAgentAid !== command.personalAgentAid ||
        checkpoint.checkpoint.harnessRevisionSaid !== command.expectedActiveRevisionSaid ||
        checkpoint.checkpoint.evidence.finalSequence > stream.cursor.acceptedThrough ||
        checkpoint.checkpoint.evidence.eventCount > stream.cursor.acceptedThrough + 1
      )
        return { kind: 'Blocked', gate: 'Evidence' };
      const checkpointHead = await this.#events.findOne({
        ownerAid,
        runId: command.originRunId,
        sequence: checkpoint.checkpoint.evidence.finalSequence,
        'event.d': checkpoint.checkpoint.evidence.chainHeadSaid,
      });
      if (checkpointHead === null) return { kind: 'Blocked', gate: 'Evidence' };
      // The five sealed calibration Runs and all six ordinal bindings are not yet sourced here.
      // A sixth retained failure alone cannot qualify a comparison.
      return { kind: 'Blocked', gate: 'Qualification' };
    } catch {
      return { kind: 'Unavailable' };
    }
  }
}
