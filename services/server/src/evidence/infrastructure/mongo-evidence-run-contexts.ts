import type { Collection, Db } from 'mongodb';

import type { EvidenceRunContexts } from '../application/evidence-run-contexts.js';
import { runsCollectionName } from '../../run/infrastructure/mongo-runs.js';
import { decodeRunDocument, type RunDocument } from '../../run/infrastructure/run-document.js';
import { tasksCollectionName } from '../../task/infrastructure/mongo-tasks.js';
import { decodeTaskDocument, type TaskDocument } from '../../task/infrastructure/task-document.js';

export class MongoEvidenceRunContexts implements EvidenceRunContexts {
  readonly #runs: Collection<RunDocument>;
  readonly #tasks: Collection<TaskDocument>;

  constructor(database: Db) {
    this.#runs = database.collection<RunDocument>(runsCollectionName);
    this.#tasks = database.collection<TaskDocument>(tasksCollectionName);
  }

  async inspect(input: { readonly ownerAid: string; readonly runId: string }) {
    try {
      const runDocument = await this.#runs.findOne({ _id: input.runId, ownerAid: input.ownerAid });
      if (runDocument === null) {
        return { kind: 'EvidenceRunNotFound' } as const;
      }
      const run = decodeRunDocument(runDocument).run;
      const taskDocument = await this.#tasks.findOne({
        _id: run.binding.taskId,
        ownerAid: input.ownerAid,
      });
      if (taskDocument === null) {
        return { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' } as const;
      }
      const task = decodeTaskDocument(taskDocument).task;
      if (
        task.revisionSaid !== run.binding.taskRevisionSaid ||
        task.harnessLineageId !== run.binding.harnessLineageId
      ) {
        return { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' } as const;
      }
      return {
        kind: 'EvidenceRunContextFound',
        run,
        completionConditionIds: task.revision.completionConditions.map((condition) => condition.id),
      } as const;
    } catch {
      return { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' } as const;
    }
  }
}
