import type { Collection, Db } from 'mongodb';

import type { EvaluationEligibility } from '../application/admit-evaluation.js';
import {
  evaluationCollectionNames,
  type EvaluationPreparationDocument,
} from './mongo-evaluation-reservations.js';
import type { CurrentEvaluationSourceScopes } from './current-evaluation-source-scopes.js';
import {
  MongoFailureQualification,
  type FailureQualificationReading,
} from './mongo-failure-qualification.js';
import { MongoTaskResidualAllowance } from './mongo-task-residual-allowance.js';

/** Current source rights, exact six-Run qualification, then a separate residual allowance gate. */
export class CurrentEvaluationEligibility implements EvaluationEligibility {
  readonly #sources: CurrentEvaluationSourceScopes;
  readonly #preparations: Collection<EvaluationPreparationDocument>;
  readonly #qualification: FailureQualificationReading;
  readonly #residual: Pick<MongoTaskResidualAllowance, 'inspect'>;

  constructor(
    database: Db,
    sources: CurrentEvaluationSourceScopes,
    qualification: FailureQualificationReading = new MongoFailureQualification(database),
    residual: Pick<MongoTaskResidualAllowance, 'inspect'> = new MongoTaskResidualAllowance(
      database,
    ),
  ) {
    this.#sources = sources;
    this.#preparations = database.collection(evaluationCollectionNames.preparations);
    this.#qualification = qualification;
    this.#residual = residual;
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
        source.personalAgentAid !== command.personalAgentAid ||
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
      if (
        preparation === null ||
        preparation.command.taskRevisionSaid !== command.taskRevisionSaid ||
        preparation.executionProfile.d !== command.executionProfileSaid
      )
        return { kind: 'Blocked', gate: 'Profile' };
      const qualification = await this.#qualification.assess({
        ownerAid,
        taskId: command.taskId,
        taskRevisionSaid: command.taskRevisionSaid,
        retainedRunId: command.originRunId,
        retainedCheckpointSaid: command.retainedCheckpointSaid,
        retainedSealSaid: command.retainedSealSaid,
        executionProfileSaid: command.executionProfileSaid,
        personalAgentAid: command.personalAgentAid,
        taskMandateSaid: command.taskMandateSaid,
        expectedActiveRevisionSaid: command.expectedActiveRevisionSaid,
      });
      if (qualification.kind === 'Unavailable') return { kind: 'Unavailable' };
      if (qualification.kind === 'Blocked') return qualification;
      const residual = await this.#residual.inspect({
        ownerAid,
        taskId: command.taskId,
        taskRevisionSaid: command.taskRevisionSaid,
        verifiedMandateCeiling: source.verifiedMandateCeiling,
      });
      if (residual.kind === 'Unavailable') return { kind: 'Unavailable' };
      if (residual.kind === 'Blocked') return { kind: 'Blocked', gate: 'Budget' };
      return {
        kind: 'Eligible',
        remaining: residual.remaining,
        verifiedMandateCeiling: source.verifiedMandateCeiling,
      };
    } catch {
      return { kind: 'Unavailable' };
    }
  }
}
