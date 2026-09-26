import type {
  RunWorkAccessGrant,
  RunWorkAccessRenewal,
} from '../../work-access/application/run-work-access.js';
import type { ProtectedCredentials } from '@devrandom/domain';
import type { HostedWorkIdentityOutcome } from '../../identity/application/user-identity.js';
import {
  acquireWorkAccess,
  type WorkAccessAcquisition,
} from '../../work-access/application/work-access-acquisition.js';
import {
  prepareAuthorizedTaskCommand,
  taskTimestampIsCanonical,
  taskLabelSchema,
  authorizedTaskSourceCommandSchema,
  type PreparedRepository,
  type AuthorizedPreparedTaskCommand,
  type SourceRepository,
  type TaskListProjection,
  type TaskListQuery,
  type TaskPreparationRejectionReason,
  type TaskProblem,
  type TaskProjection,
} from '@devrandom/protocol';
import Value from 'typebox/value';

const requestRetryLimit = 3;
const retryIntervalMilliseconds = 1_000;

type ReadyHostedWorkIdentity = Extract<HostedWorkIdentityOutcome, { readonly kind: 'Ready' }>;
type GrantedWorkAccess = Extract<WorkAccessAcquisition, { readonly kind: 'Granted' }>;

export type TaskDocumentReading =
  | { readonly kind: 'Read'; readonly document: unknown }
  | {
      readonly kind: 'Rejected';
      readonly reason:
        | 'FileUnavailable'
        | 'FileTooLarge'
        | 'Utf8Invalid'
        | 'BomForbidden'
        | 'JsonInvalid'
        | 'DuplicateMember';
    };

export interface TaskDocument {
  read(path: string): Promise<TaskDocumentReading>;
}

export type TaskRepositoryResolution =
  | { readonly kind: 'Resolved'; readonly repository: PreparedRepository }
  | {
      readonly kind: 'Rejected';
      readonly reason: 'RepositoryUnavailable' | 'WorktreeDirty' | 'CommitUnavailable';
    };

export interface TaskRepositoryBinding {
  resolve(source: SourceRepository): Promise<TaskRepositoryResolution>;
}

export type HostedTaskFailure =
  | { readonly kind: 'InputInvalid' }
  | { readonly kind: 'ServerUnavailable' }
  | { readonly kind: 'ResponseInvalid' }
  | { readonly kind: 'RequestRejected'; readonly problem: TaskProblem };

export type HostedTaskCreation =
  | { readonly kind: 'Created'; readonly task: TaskProjection }
  | { readonly kind: 'Reconciled'; readonly task: TaskProjection }
  | HostedTaskFailure;

export type HostedTaskListing =
  { readonly kind: 'Listed'; readonly page: TaskListProjection } | HostedTaskFailure;

export type HostedTaskInspection =
  { readonly kind: 'Inspected'; readonly task: TaskProjection } | HostedTaskFailure;

export interface HostedTasks {
  create(command: AuthorizedPreparedTaskCommand): Promise<HostedTaskCreation>;
  list(query: TaskListQuery): Promise<HostedTaskListing>;
  inspect(label: string): Promise<HostedTaskInspection>;
}

export type TaskAuthorityAcquisition =
  | {
      readonly kind: 'Authorized';
      readonly tasks: HostedTasks;
      readonly protectedCredentials: ProtectedCredentials;
    }
  | TaskAuthorityFailure;

export type TaskAuthorityFailure =
  | {
      readonly kind: 'TaskIdentityRejected';
      readonly identity: Exclude<HostedWorkIdentityOutcome, ReadyHostedWorkIdentity>;
    }
  | {
      readonly kind: 'TaskAccessRejected';
      readonly access: Exclude<WorkAccessAcquisition, GrantedWorkAccess>;
    };

export type HostedWorkAuthorityAcquisition =
  | {
      readonly kind: 'Authorized';
      readonly user: ReadyHostedWorkIdentity['user'];
      readonly tasks: HostedTasks;
      readonly presentations: ReturnType<GrantedWorkAccess['server']['mandates']>;
      readonly harnesses: ReturnType<GrantedWorkAccess['server']['harnesses']>;
      readonly runs: ReturnType<GrantedWorkAccess['server']['runs']>;
      readonly evidence: ReturnType<GrantedWorkAccess['server']['evidence']>;
      readonly evaluations: ReturnType<GrantedWorkAccess['server']['evaluations']>;
      readonly activation: GrantedWorkAccess['server']['activation'];
      readonly activationPointer: GrantedWorkAccess['server']['activationPointer'];
      readonly publication: GrantedWorkAccess['server']['publication'];
      contextReady(): boolean;
      context(
        inventory: Parameters<GrantedWorkAccess['server']['context']>[0],
      ): ReturnType<GrantedWorkAccess['server']['context']>;
      readonly protectedCredentials: ProtectedCredentials;
      readonly grantExpiresAt: string;
      readonly workAccessRenewal: RunWorkAccessRenewal;
    }
  | TaskAuthorityFailure;

export interface TaskAuthority {
  acquire(): Promise<TaskAuthorityAcquisition>;
}

interface CurrentHostedWorkIdentity {
  admitHostedWork(): Promise<HostedWorkIdentityOutcome>;
}

type WorkAccessAcquirer = (
  serverUrl: string,
  identity: ReadyHostedWorkIdentity,
  signal?: AbortSignal,
) => Promise<WorkAccessAcquisition>;

export class CurrentTaskAuthority implements TaskAuthority {
  readonly #identity: CurrentHostedWorkIdentity;
  readonly #serverUrl: string;
  readonly #acquireWorkAccess: WorkAccessAcquirer;
  readonly #heldGrants: GrantedWorkAccess['server'][] = [];

  constructor(
    identity: CurrentHostedWorkIdentity,
    serverUrl: string,
    acquire: WorkAccessAcquirer = (url, identity, signal) =>
      acquireWorkAccess(url, identity, undefined, signal),
  ) {
    this.#identity = identity;
    this.#serverUrl = serverUrl;
    this.#acquireWorkAccess = acquire;
  }

  async acquire(): Promise<TaskAuthorityAcquisition> {
    const authority = await this.acquireHostedWork();
    return authority.kind === 'Authorized'
      ? {
          kind: 'Authorized',
          tasks: authority.tasks,
          protectedCredentials: authority.protectedCredentials,
        }
      : authority;
  }

  async acquireHostedWork(): Promise<HostedWorkAuthorityAcquisition> {
    const identity = await this.#identity.admitHostedWork();
    if (identity.kind !== 'Ready') {
      return { kind: 'TaskIdentityRejected', identity };
    }
    const access = await this.#acquireWorkAccess(this.#serverUrl, identity);
    if (access.kind !== 'Granted') {
      return { kind: 'TaskAccessRejected', access };
    }
    const disposition = access.server.grant.disposition;
    if (disposition.kind !== 'Active') {
      return { kind: 'TaskAccessRejected', access: { kind: 'ServerResponseInvalid' } };
    }
    this.#heldGrants.push(access.server);
    return {
      kind: 'Authorized',
      user: identity.user,
      tasks: access.server.tasks(),
      presentations: access.server.mandates(),
      harnesses: access.server.harnesses(),
      runs: access.server.runs(),
      evidence: access.server.evidence(),
      evaluations: access.server.evaluations(),
      activation: (receipts, issuerAid, personalAgentAid) =>
        access.server.activation(receipts, issuerAid, personalAgentAid),
      activationPointer: () => access.server.activationPointer(),
      publication: () => access.server.publication(),
      contextReady: () => access.server.contextReady(),
      context: (inventory) => access.server.context(inventory),
      protectedCredentials: access.server.protectedCredentials,
      grantExpiresAt: disposition.expiresAt,
      workAccessRenewal: {
        initialGrant: runWorkAccessGrant(access, () => this.#releaseHeldGrant(access.server)),
        acquire: async (signal) => {
          const replacement = await this.#acquireWorkAccess(this.#serverUrl, identity, signal);
          if (replacement.kind === 'Granted') {
            this.#heldGrants.push(replacement.server);
          }
          return replacement.kind === 'Granted'
            ? {
                kind: 'Granted',
                grant: runWorkAccessGrant(replacement, () =>
                  this.#releaseHeldGrant(replacement.server),
                ),
              }
            : { kind: 'Unavailable' };
        },
      },
    };
  }

  async releaseHeldGrants(): Promise<
    | { readonly kind: 'Released' }
    | { readonly kind: 'ReleaseUnavailable'; readonly attemptIds: readonly string[] }
  > {
    const unavailable: string[] = [];
    for (const grant of [...this.#heldGrants].reverse()) {
      try {
        await this.#releaseHeldGrant(grant);
      } catch {
        unavailable.push(grant.grant.attemptId);
      }
    }
    return unavailable.length === 0
      ? { kind: 'Released' }
      : { kind: 'ReleaseUnavailable', attemptIds: unavailable };
  }

  async #releaseHeldGrant(grant: GrantedWorkAccess['server']): Promise<void> {
    if (!this.#heldGrants.includes(grant)) return;
    await grant.releaseGrant();
    const index = this.#heldGrants.indexOf(grant);
    if (index >= 0) this.#heldGrants.splice(index, 1);
  }
}

function runWorkAccessGrant(
  access: GrantedWorkAccess,
  release: () => Promise<void>,
): RunWorkAccessGrant {
  const grant = access.server.grant;
  return {
    userAid: grant.userAid,
    credentialSaid: grant.credentialSaid,
    clientInstanceId: grant.clientInstanceId,
    issuerAid: grant.issuerRecipientAid,
    scopes: grant.scopes,
    deadline: access.grantDeadline,
    runs: access.server.runs(),
    evidence: access.server.evidence(),
    release,
  };
}

export type TaskCommandFailure =
  | { readonly kind: 'TaskSecretDetected' }
  | {
      readonly kind: 'TaskFileRejected';
      readonly reason: Extract<TaskDocumentReading, { readonly kind: 'Rejected' }>['reason'];
    }
  | {
      readonly kind: 'TaskContractRejected';
      readonly reason: TaskPreparationRejectionReason;
    }
  | {
      readonly kind: 'TaskRepositoryRejected';
      readonly reason: Extract<TaskRepositoryResolution, { readonly kind: 'Rejected' }>['reason'];
    }
  | { readonly kind: 'TaskCommandIdUnavailable' }
  | Exclude<TaskAuthorityAcquisition, { readonly kind: 'Authorized' }>
  | { readonly kind: 'TaskRequestInvalid' }
  | { readonly kind: 'TaskServerUnavailable' }
  | { readonly kind: 'TaskServerResponseInvalid' }
  | { readonly kind: 'TaskServerRejected'; readonly problem: TaskProblem };

export type TaskCreation =
  | { readonly kind: 'TaskCreated'; readonly task: TaskProjection }
  | { readonly kind: 'TaskReconciled'; readonly task: TaskProjection }
  | TaskCommandFailure;

export type TaskListing =
  { readonly kind: 'TasksListed'; readonly page: TaskListProjection } | TaskCommandFailure;

export type TaskInspection =
  | { readonly kind: 'TaskInspected'; readonly task: TaskProjection }
  | { readonly kind: 'TaskLabelRejected' }
  | TaskCommandFailure;

export interface UserTasksDependencies {
  readonly protectedCredentials: ProtectedCredentials;
  readonly documents: TaskDocument;
  readonly repository: TaskRepositoryBinding;
  readonly authority: TaskAuthority;
  newCommandId(): string;
  wait(milliseconds: number): Promise<void>;
}

export class UserTasks {
  readonly #dependencies: UserTasksDependencies;

  constructor(dependencies: UserTasksDependencies) {
    this.#dependencies = dependencies;
  }

  async create(path: string): Promise<TaskCreation> {
    const reading = await this.#dependencies.documents.read(path);
    if (reading.kind === 'Rejected') {
      return { kind: 'TaskFileRejected', reason: reading.reason };
    }
    if (!Value.Check(authorizedTaskSourceCommandSchema, reading.document)) {
      return { kind: 'TaskContractRejected', reason: 'SchemaInvalid' };
    }
    const source = Value.Parse(authorizedTaskSourceCommandSchema, reading.document);
    const sourceBytes = new TextEncoder().encode(JSON.stringify(source));
    if (this.#dependencies.protectedCredentials.inspect(sourceBytes).kind === 'WithheldSecret') {
      return { kind: 'TaskSecretDetected' };
    }
    if (!taskTimestampIsCanonical(source.expiresAt)) {
      return { kind: 'TaskContractRejected', reason: 'DeadlineInvalid' };
    }
    const authority = await this.#dependencies.authority.acquire();
    if (authority.kind !== 'Authorized') {
      return authority;
    }
    if (authority.protectedCredentials.inspect(sourceBytes).kind === 'WithheldSecret') {
      return { kind: 'TaskSecretDetected' };
    }
    const repository = await this.#dependencies.repository.resolve(source.repository);
    if (repository.kind === 'Rejected') {
      return { kind: 'TaskRepositoryRejected', reason: repository.reason };
    }
    let commandId: string;
    try {
      commandId = this.#dependencies.newCommandId();
    } catch {
      return { kind: 'TaskCommandIdUnavailable' };
    }
    const prepared = prepareAuthorizedTaskCommand(source, commandId, repository.repository);
    if (prepared.kind === 'Rejected') {
      return { kind: 'TaskContractRejected', reason: prepared.reason };
    }
    const hosted = await retryHostedTask(
      () => authority.tasks.create(prepared.command),
      (milliseconds) => this.#dependencies.wait(milliseconds),
    );
    switch (hosted.kind) {
      case 'Created':
        return { kind: 'TaskCreated', task: hosted.task };
      case 'Reconciled':
        return { kind: 'TaskReconciled', task: hosted.task };
      case 'InputInvalid':
      case 'ServerUnavailable':
      case 'ResponseInvalid':
      case 'RequestRejected':
        return taskCommandFailure(hosted);
    }
  }

  async list(): Promise<TaskListing> {
    const authority = await this.#dependencies.authority.acquire();
    if (authority.kind !== 'Authorized') {
      return authority;
    }
    const hosted = await retryHostedTask(
      () => authority.tasks.list({}),
      (milliseconds) => this.#dependencies.wait(milliseconds),
    );
    return hosted.kind === 'Listed'
      ? { kind: 'TasksListed', page: hosted.page }
      : taskCommandFailure(hosted);
  }

  async inspect(label: string): Promise<TaskInspection> {
    if (!Value.Check(taskLabelSchema, label)) {
      return { kind: 'TaskLabelRejected' };
    }
    const authority = await this.#dependencies.authority.acquire();
    if (authority.kind !== 'Authorized') {
      return authority;
    }
    const hosted = await retryHostedTask(
      () => authority.tasks.inspect(label),
      (milliseconds) => this.#dependencies.wait(milliseconds),
    );
    return hosted.kind === 'Inspected'
      ? { kind: 'TaskInspected', task: hosted.task }
      : taskCommandFailure(hosted);
  }
}

async function retryHostedTask<
  Outcome extends HostedTaskCreation | HostedTaskListing | HostedTaskInspection,
>(
  request: () => Promise<Outcome>,
  wait: (milliseconds: number) => Promise<void>,
): Promise<Outcome> {
  let outcome = await request();
  for (
    let requestCount = 1;
    requestCount < requestRetryLimit && outcome.kind === 'ServerUnavailable';
    requestCount += 1
  ) {
    await wait(retryIntervalMilliseconds);
    outcome = await request();
  }
  return outcome;
}

function taskCommandFailure(failure: HostedTaskFailure): TaskCommandFailure {
  switch (failure.kind) {
    case 'InputInvalid':
      return { kind: 'TaskRequestInvalid' };
    case 'ServerUnavailable':
      return { kind: 'TaskServerUnavailable' };
    case 'ResponseInvalid':
      return { kind: 'TaskServerResponseInvalid' };
    case 'RequestRejected':
      return { kind: 'TaskServerRejected', problem: failure.problem };
  }
}
