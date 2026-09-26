import type { TaskProjection, TaskSummary } from '@devrandom/protocol';

export interface AuthenticatedTaskOwner {
  readonly ownerAid: string;
  readonly credentialSaid: string;
}

export interface TaskPagePosition {
  readonly createdAt: string;
  readonly taskId: string;
}

export type TaskCommandReconciliation =
  | { readonly kind: 'NoTask' }
  | { readonly kind: 'ExistingTask'; readonly task: TaskProjection }
  | { readonly kind: 'CommandConflict' }
  | { readonly kind: 'DependencyUnavailable'; readonly dependency: 'HostedMongoDB' };

export type TaskCreation =
  | { readonly kind: 'TaskCreated'; readonly task: TaskProjection }
  | { readonly kind: 'ExistingTask'; readonly task: TaskProjection }
  | { readonly kind: 'CommandConflict' }
  | { readonly kind: 'LabelConflict' }
  | { readonly kind: 'OwnerCapacityExceeded' }
  | { readonly kind: 'GlobalCapacityExceeded' }
  | { readonly kind: 'DependencyUnavailable'; readonly dependency: 'HostedMongoDB' };

export type TaskPageQuery = {
  readonly limit: number;
  readonly after: TaskPagePosition | null;
};

export type TaskPage =
  | {
      readonly kind: 'TaskPage';
      readonly tasks: readonly TaskSummary[];
      readonly nextPosition: TaskPagePosition | null;
    }
  | { readonly kind: 'DependencyUnavailable'; readonly dependency: 'HostedMongoDB' };

export type TaskInspection =
  | { readonly kind: 'TaskFound'; readonly task: TaskProjection }
  | { readonly kind: 'TaskNotFound' }
  | { readonly kind: 'DependencyUnavailable'; readonly dependency: 'HostedMongoDB' };

export interface Tasks {
  reconcile(
    ownerAid: string,
    commandId: string,
    commandFingerprint: string,
  ): Promise<TaskCommandReconciliation>;
  create(proposedTask: {
    readonly task: TaskProjection;
    readonly commandFingerprint: string;
  }): Promise<TaskCreation>;
  list(ownerAid: string, query: TaskPageQuery): Promise<TaskPage>;
  findById(ownerAid: string, taskId: string): Promise<TaskInspection>;
  findByLabel(ownerAid: string, label: string): Promise<TaskInspection>;
}
