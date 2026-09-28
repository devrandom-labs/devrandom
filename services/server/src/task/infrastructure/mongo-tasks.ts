import { MongoServerError, type Collection, type Db, type Filter } from 'mongodb';

import { taskBudgetCeilings, type TaskProjection } from '@devrandom/protocol';

import { summarizeTask } from '../application/task-projection.js';
import type {
  TaskCommandReconciliation,
  TaskCreation,
  TaskInspection,
  TaskPage,
  TaskPageQuery,
  Tasks,
} from '../application/tasks.js';
import { decodeTaskDocument, encodeTaskDocument, type TaskDocument } from './task-document.js';

export const tasksCollectionName = 'tasks' as const;

export const taskIndexNames = Object.freeze({
  ownerLabel: 'task-owner-label-unique',
  ownerCommand: 'task-owner-command-unique',
  ownerSlot: 'task-owner-capacity-slot-unique',
  globalSlot: 'task-global-capacity-slot-unique',
  ownerPage: 'task-owner-page',
});

export const taskIndexDefinitions = Object.freeze([
  {
    name: taskIndexNames.ownerLabel,
    key: { ownerAid: 1, label: 1 },
    unique: true,
  },
  {
    name: taskIndexNames.ownerCommand,
    key: { ownerAid: 1, commandId: 1 },
    unique: true,
  },
  {
    name: taskIndexNames.ownerSlot,
    key: { ownerAid: 1, ownerSlot: 1 },
    unique: true,
  },
  {
    name: taskIndexNames.globalSlot,
    key: { globalSlot: 1 },
    unique: true,
  },
  {
    name: taskIndexNames.ownerPage,
    key: { ownerAid: 1, createdAt: 1, _id: 1 },
  },
] as const);

function duplicateKey(error: unknown): error is MongoServerError {
  return error instanceof MongoServerError && error.code === 11_000;
}

function duplicateIndex(error: MongoServerError, indexName: string): boolean {
  return error.message.includes(indexName);
}

export class MongoTasks implements Tasks {
  readonly #tasks: Collection<TaskDocument>;

  constructor(database: Db) {
    this.#tasks = database.collection<TaskDocument>(tasksCollectionName);
  }

  async reconcile(
    ownerAid: string,
    commandId: string,
    commandFingerprint: string,
  ): Promise<TaskCommandReconciliation> {
    try {
      const existing = await this.#byCommand(ownerAid, commandId);
      if (existing === undefined) {
        return { kind: 'NoTask' };
      }
      return existing.commandFingerprint === commandFingerprint
        ? { kind: 'ExistingTask', task: existing.task }
        : { kind: 'CommandConflict' };
    } catch {
      return { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' };
    }
  }

  async create(proposedTask: {
    readonly task: TaskProjection;
    readonly commandFingerprint: string;
  }): Promise<TaskCreation> {
    for (
      let ownerSlot = 0;
      ownerSlot < proposedTask.task.revision.budgets.tasksPerAdmittedUser;
      ownerSlot += 1
    ) {
      let ownerSlotOccupied = false;
      for (
        let globalSlot = 0;
        globalSlot < taskBudgetCeilings.hostedWorkTasksGlobally;
        globalSlot += 1
      ) {
        try {
          await this.#tasks.insertOne(
            encodeTaskDocument(proposedTask.task, proposedTask.commandFingerprint, {
              ownerSlot,
              globalSlot,
            }),
          );
          return { kind: 'TaskCreated', task: proposedTask.task };
        } catch (error) {
          if (!duplicateKey(error)) {
            return { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' };
          }
          let conflict: Exclude<TaskCreation, { readonly kind: 'TaskCreated' }> | undefined;
          try {
            conflict = await this.#creationConflict(proposedTask);
          } catch {
            return { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' };
          }
          if (conflict !== undefined) {
            return conflict;
          }
          if (duplicateIndex(error, taskIndexNames.ownerSlot)) {
            ownerSlotOccupied = true;
            break;
          }
          if (!duplicateIndex(error, taskIndexNames.globalSlot)) {
            return { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' };
          }
        }
      }
      if (!ownerSlotOccupied) {
        return { kind: 'GlobalCapacityExceeded' };
      }
    }
    return { kind: 'OwnerCapacityExceeded' };
  }

  async list(ownerAid: string, query: TaskPageQuery): Promise<TaskPage> {
    try {
      const filter: Filter<TaskDocument> =
        query.after === null
          ? { ownerAid }
          : {
              ownerAid,
              $or: [
                { createdAt: { $gt: new Date(query.after.createdAt) } },
                {
                  createdAt: new Date(query.after.createdAt),
                  _id: { $gt: query.after.taskId },
                },
              ],
            };
      const documents = await this.#tasks
        .find(filter)
        .sort({ createdAt: 1, _id: 1 })
        .limit(query.limit + 1)
        .toArray();
      const bounded = documents
        .slice(0, query.limit)
        .map((document) => decodeTaskDocument(document));
      const tasks = bounded.map((decoded) => summarizeTask(decoded.task));
      const finalTask = tasks.at(-1);
      return {
        kind: 'TaskPage',
        tasks,
        nextPosition:
          documents.length > query.limit && finalTask !== undefined
            ? { createdAt: finalTask.createdAt, taskId: finalTask.taskId }
            : null,
      };
    } catch {
      return { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' };
    }
  }

  async findByLabel(ownerAid: string, label: string): Promise<TaskInspection> {
    try {
      const document = await this.#tasks.findOne({ ownerAid, label });
      return document === null
        ? { kind: 'TaskNotFound' }
        : { kind: 'TaskFound', task: decodeTaskDocument(document).task };
    } catch {
      return { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' };
    }
  }

  async findById(ownerAid: string, taskId: string): Promise<TaskInspection> {
    try {
      const document = await this.#tasks.findOne({ _id: taskId, ownerAid });
      return document === null
        ? { kind: 'TaskNotFound' }
        : { kind: 'TaskFound', task: decodeTaskDocument(document).task };
    } catch {
      return { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' };
    }
  }

  async #byCommand(ownerAid: string, commandId: string) {
    const document = await this.#tasks.findOne({ ownerAid, commandId });
    return document === null ? undefined : decodeTaskDocument(document);
  }

  async #creationConflict(proposedTask: {
    readonly task: TaskProjection;
    readonly commandFingerprint: string;
  }): Promise<Exclude<TaskCreation, { readonly kind: 'TaskCreated' }> | undefined> {
    const task = proposedTask.task;
    const existingCommand = await this.#byCommand(task.ownerAid, task.commandId);
    if (existingCommand !== undefined) {
      return existingCommand.commandFingerprint === proposedTask.commandFingerprint
        ? { kind: 'ExistingTask', task: existingCommand.task }
        : { kind: 'CommandConflict' };
    }
    const existingLabel = await this.#tasks.findOne({ ownerAid: task.ownerAid, label: task.label });
    return existingLabel === null ? undefined : { kind: 'LabelConflict' };
  }
}
