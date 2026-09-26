import { MongoServerError, type Collection, type Db } from 'mongodb';

import type { WorkAccessScope } from '@devrandom/protocol';

import type {
  GrantAuthorization,
  StoredWorkAccessAttempt,
  WorkAccessAttemptCommit,
  WorkAccessAttemptCreation,
  WorkAccessAttemptLookup,
  WorkAccessAttempts,
  WorkAccessCommandReconciliation,
} from '../application/work-access-attempts.js';
import type { WorkAccessAttempt, WorkAccessCommand } from '../domain/work-access.js';
import { workAccessPolicy, type WorkAccessPolicy } from '../domain/work-access-policy.js';
import {
  decodeWorkAccessAttemptDocument,
  encodeWorkAccessAttemptDocument,
  type WorkAccessAttemptDocument,
  type WorkAccessCapacityAllocation,
} from './work-access-document.js';
import {
  workAccessAttemptsCollectionName,
  workAccessIndexNames,
} from './work-access-storage-contract.js';

type UncommittedGrantAuthorization = Exclude<
  GrantAuthorization,
  { readonly kind: 'GrantAuthorized' }
>;

export function classifyUncommittedWorkAccessGrant(
  stored: StoredWorkAccessAttempt,
  scope: WorkAccessScope,
  observedAt: Date,
): UncommittedGrantAuthorization {
  if (stored.attempt.state.kind !== 'Granted') {
    return { kind: 'GrantNotFound' };
  }
  if (stored.attempt.state.disposition.kind === 'Released') {
    return { kind: 'GrantReleased' };
  }
  if (new Date(stored.attempt.state.expiresAt) <= observedAt) {
    return { kind: 'GrantExpired' };
  }
  switch (stored.attempt.state.disposition.kind) {
    case 'Expired':
      return { kind: 'GrantExpired' };
    case 'Exhausted':
      return { kind: 'GrantExhausted' };
    case 'Revoked':
      return { kind: 'GrantRevoked', reason: stored.attempt.state.disposition.reason };
    case 'Active':
      return stored.attempt.state.scopes.includes(scope)
        ? { kind: 'GrantAuthorizationConflict' }
        : { kind: 'GrantScopeRejected' };
  }
}

function duplicateKey(error: unknown): error is MongoServerError {
  return error instanceof MongoServerError && error.code === 11_000;
}

function duplicateIndex(error: MongoServerError, indexName: string): boolean {
  return error.message.includes(indexName);
}

function currentAllocation(
  current: WorkAccessCapacityAllocation,
  next: WorkAccessAttempt,
): readonly WorkAccessCapacityAllocation[] {
  if (next.state.kind === 'AwaitingProof' || next.state.kind === 'VerifyingProof') {
    return current.kind === 'AttemptCapacity' ? [current] : [];
  }
  if (next.state.kind === 'Granted' && next.state.disposition.kind === 'Active') {
    return current.kind === 'GrantCapacity'
      ? [current]
      : [
          { kind: 'GrantCapacity', userSlot: 0 },
          { kind: 'GrantCapacity', userSlot: 1 },
        ];
  }
  return [{ kind: 'ReleasedCapacity' }];
}

export class MongoWorkAccessAttempts implements WorkAccessAttempts {
  readonly #database: Db;
  readonly #policy: WorkAccessPolicy;
  readonly #attempts: Collection<WorkAccessAttemptDocument>;

  constructor(database: Db, policy: WorkAccessPolicy = workAccessPolicy) {
    this.#database = database;
    this.#policy = policy;
    this.#attempts = database.collection<WorkAccessAttemptDocument>(
      workAccessAttemptsCollectionName,
    );
  }

  async reconcileCommand(
    command: WorkAccessCommand,
    commandFingerprint: string,
  ): Promise<WorkAccessCommandReconciliation> {
    const existing = await this.#byCommand(command);
    if (existing === undefined) {
      return { kind: 'NoAttempt' };
    }
    return existing.commandFingerprint === commandFingerprint
      ? { kind: 'ExistingAttempt', stored: existing }
      : { kind: 'CommandConflict' };
  }

  async create(
    attempt: WorkAccessAttempt,
    commandFingerprint: string,
  ): Promise<WorkAccessAttemptCreation> {
    const existing = await this.#byCommand(attempt.binding);
    if (existing !== undefined) {
      return existing.commandFingerprint === commandFingerprint
        ? { kind: 'ExistingAttempt', stored: existing }
        : { kind: 'CommandConflict' };
    }
    await this.#releaseExpiredAttemptCapacity(new Date(attempt.binding.createdAt));
    const stored: StoredWorkAccessAttempt = { revision: 0, commandFingerprint, attempt };
    for (const userSlot of [0, 1] as const) {
      for (let globalSlot = 0; globalSlot < 32; globalSlot += 1) {
        try {
          await this.#attempts.insertOne(
            encodeWorkAccessAttemptDocument(stored, {
              kind: 'AttemptCapacity',
              userSlot,
              globalSlot,
            }),
          );
          return { kind: 'AttemptCreated', stored };
        } catch (error) {
          if (!duplicateKey(error)) {
            throw error;
          }
          const accepted = await this.#byCommand(attempt.binding);
          if (accepted !== undefined) {
            return accepted.commandFingerprint === commandFingerprint
              ? { kind: 'ExistingAttempt', stored: accepted }
              : { kind: 'CommandConflict' };
          }
          if (
            !duplicateIndex(error, workAccessIndexNames.userAttemptSlot) &&
            !duplicateIndex(error, workAccessIndexNames.globalAttemptSlot)
          ) {
            throw error;
          }
        }
      }
    }
    return { kind: 'AttemptCapacityExceeded' };
  }

  async retrieve(attemptId: string): Promise<StoredWorkAccessAttempt | undefined> {
    const document = await this.#attempts.findOne({ _id: attemptId });
    return document === null
      ? undefined
      : decodeWorkAccessAttemptDocument(document, this.#policy).stored;
  }

  async retrieveAuthorized(
    attemptId: string,
    grantSecretHash: string,
  ): Promise<WorkAccessAttemptLookup> {
    const document = await this.#attempts.findOne({
      _id: attemptId,
      grantSecretHash,
    });
    return document === null
      ? { kind: 'AttemptNotFound' }
      : {
          kind: 'AttemptFound',
          stored: decodeWorkAccessAttemptDocument(document, this.#policy).stored,
        };
  }

  async commit(
    current: StoredWorkAccessAttempt,
    next: WorkAccessAttempt,
  ): Promise<WorkAccessAttemptCommit> {
    const document = await this.#attempts.findOne({
      _id: current.attempt.binding.attemptId,
      revision: current.revision,
    });
    if (document === null) {
      return { kind: 'ConcurrentlyModified' };
    }
    const decoded = decodeWorkAccessAttemptDocument(document, this.#policy);
    if (decoded.stored.commandFingerprint !== current.commandFingerprint) {
      return { kind: 'ConcurrentlyModified' };
    }
    const nextStored: StoredWorkAccessAttempt = {
      revision: current.revision + 1,
      commandFingerprint: current.commandFingerprint,
      attempt: next,
    };
    if (next.state.kind === 'Granted' && next.state.disposition.kind === 'Active') {
      await this.#releaseExpiredGrantCapacity(
        next.binding.userAid,
        next.binding.clientInstanceId,
        new Date(next.state.grantedAt),
      );
    }
    const candidates = currentAllocation(decoded.allocation, next);
    for (const allocation of candidates) {
      try {
        const replaced = await this.#attempts.replaceOne(
          { _id: current.attempt.binding.attemptId, revision: current.revision },
          encodeWorkAccessAttemptDocument(nextStored, allocation),
        );
        return replaced.modifiedCount === 1
          ? { kind: 'AttemptCommitted', stored: nextStored }
          : { kind: 'ConcurrentlyModified' };
      } catch (error) {
        if (!duplicateKey(error)) {
          throw error;
        }
        if (duplicateIndex(error, workAccessIndexNames.proofResponse)) {
          return { kind: 'ProofResponseReplayed' };
        }
        if (
          allocation.kind === 'GrantCapacity' &&
          (duplicateIndex(error, workAccessIndexNames.userGrantSlot) ||
            duplicateIndex(error, workAccessIndexNames.activeGrantSecret))
        ) {
          continue;
        }
        throw error;
      }
    }
    return { kind: 'GrantCapacityExceeded' };
  }

  async authorizeGrant(input: {
    readonly grantSecretHash: string;
    readonly scope: WorkAccessScope;
    readonly observedAt: string;
  }): Promise<GrantAuthorization> {
    const observedAt = new Date(input.observedAt);
    if (Number.isNaN(observedAt.valueOf()) || observedAt.toISOString() !== input.observedAt) {
      throw new Error('Grant authorization time is invalid');
    }
    const updated = await this.#attempts.findOneAndUpdate(
      {
        grantSecretHash: input.grantSecretHash,
        'state.kind': 'Granted',
        'state.disposition.kind': 'Active',
        'state.disposition.remainingRequests': { $gt: 0 },
        'state.expiresAt': { $gt: observedAt },
        'state.scopes': input.scope,
      },
      [
        {
          $set: {
            revision: { $add: ['$revision', 1] },
            'state.disposition': {
              $cond: [
                { $eq: ['$state.disposition.remainingRequests', 1] },
                { kind: 'Exhausted' },
                {
                  kind: 'Active',
                  remainingRequests: {
                    $subtract: ['$state.disposition.remainingRequests', 1],
                  },
                },
              ],
            },
            grantSlot: {
              $cond: [
                { $eq: ['$state.disposition.remainingRequests', 1] },
                '$$REMOVE',
                '$grantSlot',
              ],
            },
          },
        },
      ],
      { returnDocument: 'after' },
    );
    if (updated !== null) {
      const stored = decodeWorkAccessAttemptDocument(updated, this.#policy).stored;
      const remainingRequests =
        stored.attempt.state.kind === 'Granted' &&
        stored.attempt.state.disposition.kind === 'Active'
          ? stored.attempt.state.disposition.remainingRequests
          : 0;
      return { kind: 'GrantAuthorized', stored, remainingRequests };
    }
    return this.#classifyGrant(input.grantSecretHash, input.scope, observedAt);
  }

  async verify(): Promise<void> {
    await this.#database.command({ ping: 1 });
  }

  async #byCommand(command: WorkAccessCommand): Promise<StoredWorkAccessAttempt | undefined> {
    const document = await this.#attempts.findOne({
      userAid: command.userAid,
      clientInstanceId: command.clientInstanceId,
      commandId: command.commandId,
    });
    return document === null
      ? undefined
      : decodeWorkAccessAttemptDocument(document, this.#policy).stored;
  }

  async #classifyGrant(
    grantSecretHash: string,
    scope: WorkAccessScope,
    observedAt: Date,
  ): Promise<GrantAuthorization> {
    const document = await this.#attempts.findOne({ grantSecretHash });
    if (document === null) {
      return { kind: 'GrantNotFound' };
    }
    const stored = decodeWorkAccessAttemptDocument(document, this.#policy).stored;
    return classifyUncommittedWorkAccessGrant(stored, scope, observedAt);
  }

  async #releaseExpiredGrantCapacity(
    userAid: string,
    clientInstanceId: string,
    observedAt: Date,
  ): Promise<void> {
    await this.#attempts.updateMany(
      {
        userAid,
        clientInstanceId,
        'state.kind': 'Granted',
        'state.disposition.kind': 'Active',
        'state.expiresAt': { $lte: observedAt },
      },
      {
        $inc: { revision: 1 },
        $set: { 'state.disposition.kind': 'Expired' },
        $unset: { 'state.disposition.remainingRequests': '', grantSlot: '' },
      },
    );
  }

  async #releaseExpiredAttemptCapacity(observedAt: Date): Promise<void> {
    await this.#attempts.updateMany(
      {
        'state.kind': { $in: ['AwaitingProof', 'VerifyingProof'] },
        attemptExpiresAt: { $lte: observedAt },
      },
      {
        $inc: { revision: 1 },
        $set: { state: { kind: 'Expired', expiredAt: observedAt } },
        $unset: { attemptSlot: '', globalAttemptSlot: '', proofResponseSaid: '' },
      },
    );
  }
}
