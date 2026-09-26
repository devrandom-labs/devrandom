import type { Collection, Db } from 'mongodb';

import type { EvolutionSourceScope } from '@devrandom/domain';
import { decodeEvaluationSourceInventory } from '@devrandom/protocol';

import type {
  CurrentTaskMandateAuthorization,
  CurrentTaskMandateInput,
} from '../../mandate/application/current-task-mandate.js';
import type { MandatePresentations } from '../../mandate/application/presentations.js';
import type { Tasks } from '../../task/application/tasks.js';
import {
  evaluationCollectionNames,
  type EvaluationPreparationDocument,
} from './mongo-evaluation-reservations.js';

type ScopeInspection =
  | { readonly kind: 'Authorized'; readonly scope: EvolutionSourceScope }
  | { readonly kind: 'Denied' | 'Unavailable' };

/** Maps current v2 Task and admitted, live TEL mandate evidence to source rights. */
export class CurrentEvaluationSourceScopes {
  readonly #tasks: Pick<Tasks, 'findById'>;
  readonly #presentations: Pick<MandatePresentations, 'findByCredential'>;
  readonly #currentTaskMandate: {
    authorize(input: CurrentTaskMandateInput): Promise<CurrentTaskMandateAuthorization>;
  };
  readonly #preparations: Collection<EvaluationPreparationDocument>;

  constructor(input: {
    readonly database: Db;
    readonly tasks: Pick<Tasks, 'findById'>;
    readonly presentations: Pick<MandatePresentations, 'findByCredential'>;
    readonly currentTaskMandate: {
      authorize(input: CurrentTaskMandateInput): Promise<CurrentTaskMandateAuthorization>;
    };
  }) {
    this.#tasks = input.tasks;
    this.#presentations = input.presentations;
    this.#currentTaskMandate = input.currentTaskMandate;
    this.#preparations = input.database.collection(evaluationCollectionNames.preparations);
  }

  async inspectPreparation(input: {
    readonly ownerAid: string;
    readonly taskId: string;
    readonly experienceMandateSaid: string;
  }): Promise<ScopeInspection> {
    try {
      const located = await this.#tasks.findById(input.ownerAid, input.taskId);
      if (located.kind === 'DependencyUnavailable') return { kind: 'Unavailable' };
      if (located.kind !== 'TaskFound') return { kind: 'Denied' };
      const task = located.task;
      if (
        task.lifecycle.kind !== 'Open' ||
        task.revision.version !== 2 ||
        !task.revision.requestedCapabilities.includes('ReadTaskMemory') ||
        task.revision.unavailableCapabilities.includes('ReadTaskMemory')
      )
        return { kind: 'Denied' };
      const presentation = await this.#presentations.findByCredential(
        input.ownerAid,
        input.experienceMandateSaid,
      );
      if (presentation.kind === 'DependencyUnavailable') return { kind: 'Unavailable' };
      if (
        presentation.kind !== 'PresentationFound' ||
        presentation.stored.presentation.state.kind !== 'Admitted' ||
        presentation.stored.presentation.acceptedReference === null
      )
        return { kind: 'Denied' };
      const personalAgentAid = presentation.stored.presentation.acceptedReference.issueeAid;
      const current = await this.#currentTaskMandate.authorize({
        ownerAid: input.ownerAid,
        taskId: task.taskId,
        taskRevisionSaid: task.revisionSaid,
        harnessLineageId: task.harnessLineageId,
        personalAgentAid,
        taskMandateSaid: input.experienceMandateSaid,
        observedAt: new Date().toISOString(),
      });
      if (current.kind === 'DependencyUnavailable') return { kind: 'Unavailable' };
      if (
        current.kind !== 'CurrentTaskMandateAuthorized' ||
        current.mandate.credential.credentialSaid !== input.experienceMandateSaid ||
        !current.mandate.allowedCapabilities.includes('ReadTaskMemory')
      )
        return { kind: 'Denied' };
      const taskExperience = task.revision.constraints.experience;
      const mandateExperience = current.mandate.experience;
      if (
        mandateExperience?.disclosure !== 'AuthorizedAnalogy' ||
        taskExperience.corpusSaid !== mandateExperience.corpusSaid ||
        taskExperience.repositoryResourceSaid !== mandateExperience.repositoryResourceSaid
      )
        return { kind: 'Denied' };
      return {
        kind: 'Authorized',
        scope: {
          ownerAid: input.ownerAid,
          taskId: task.taskId,
          taskRevisionSaid: task.revisionSaid,
          repositoryResourceSaid: taskExperience.repositoryResourceSaid,
          allowedCorpusSaid: taskExperience.corpusSaid,
          mandate: { kind: 'AuthorizedExperience', mandateSaid: input.experienceMandateSaid },
        },
      };
    } catch {
      return { kind: 'Unavailable' };
    }
  }

  async inspectInventory(input: {
    readonly ownerAid: string;
    readonly taskId: string;
    readonly sourceInventorySaid: string;
  }): Promise<ScopeInspection> {
    try {
      const prepared = await this.#preparations.findOne({
        ownerAid: input.ownerAid,
        'sourceInventory.d': input.sourceInventorySaid,
        'sourceInventory.taskId': input.taskId,
      });
      if (
        prepared === null ||
        decodeEvaluationSourceInventory(prepared.sourceInventory).kind !== 'Accepted'
      )
        return { kind: 'Denied' };
      return await this.inspectPreparation({
        ownerAid: input.ownerAid,
        taskId: input.taskId,
        experienceMandateSaid: prepared.sourceInventory.experienceMandateSaid,
      });
    } catch {
      return { kind: 'Unavailable' };
    }
  }
}
