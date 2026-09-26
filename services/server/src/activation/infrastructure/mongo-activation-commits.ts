import { isDeepStrictEqual } from 'node:util';

import { MongoServerError, type Collection, type Db, type MongoClient } from 'mongodb';

import {
  decodeActivationCommitCommand,
  type ActivationCommitCommand,
  type ActivationCommitReceipt,
} from '@devrandom/protocol';

import {
  decodeHarnessDocument,
  type HarnessDocument,
} from '../../harness/infrastructure/harness-document.js';
import { harnessRevisionsCollectionName } from '../../harness/infrastructure/mongo-harness-revisions.js';
import type { ActivationCommitStorage } from '../application/commit-activation.js';

export const activationCollectionNames = Object.freeze({
  pointers: 'activationPointers',
  decisions: 'activationDecisions',
  transitions: 'activationTransitions',
});

interface ActivationPointerDocument {
  readonly _id: string;
  readonly ownerAid: string;
  readonly taskRevisionSaid: string;
  readonly harnessLineageId: string;
  readonly activeRevisionSaid: string;
  readonly version: number;
  readonly pendingCommandId?: string;
}

interface ActivationDecisionDocument {
  readonly _id: string;
  readonly ownerAid: string;
  readonly recipientAid: string;
  readonly command: ActivationCommitCommand;
  readonly preparedAt: number;
  readonly state: 'PendingReceipt' | 'Committed';
  readonly targetRevisionSaid: string;
  readonly nextPointerVersion: number;
  readonly receipt?: Extract<ActivationCommitReceipt, { kind: 'Committed' | 'AlreadyCommitted' }>;
}

interface ActivationTransitionDocument {
  readonly _id: string;
  readonly ownerAid: string;
  readonly taskId: string;
  readonly commandId: string;
  readonly previousRevisionSaid: string;
  readonly activeRevisionSaid: string;
  readonly pointerVersion: number;
  readonly receiptSaid: string;
  readonly committedAt: Date;
}

function duplicate(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11000;
}

class ActivationConflict extends Error {}

/** Version-only pointer plus append-only transitions; pending decisions cannot route a successor. */
export class MongoActivationCommits implements ActivationCommitStorage {
  readonly #client: MongoClient;
  readonly #pointers: Collection<ActivationPointerDocument>;
  readonly #decisions: Collection<ActivationDecisionDocument>;
  readonly #transitions: Collection<ActivationTransitionDocument>;
  readonly #harnesses: Collection<HarnessDocument>;

  constructor(client: MongoClient, database: Db) {
    this.#client = client;
    this.#pointers = database.collection(activationCollectionNames.pointers);
    this.#decisions = database.collection(activationCollectionNames.decisions);
    this.#transitions = database.collection(activationCollectionNames.transitions);
    this.#harnesses = database.collection(harnessRevisionsCollectionName);
  }

  async inspect(
    input: Parameters<ActivationCommitStorage['inspect']>[0],
  ): ReturnType<ActivationCommitStorage['inspect']> {
    try {
      const decision = await this.#decisions.findOne({ _id: input.command.commandId });
      if (decision === null) return { kind: 'Absent' };
      if (
        decision.ownerAid !== input.ownerAid ||
        !isDeepStrictEqual(decision.command, input.command) ||
        decodeActivationCommitCommand(decision.command).kind !== 'Accepted'
      )
        return { kind: 'Conflict' };
      if (decision.state === 'PendingReceipt') return { kind: 'Pending' };
      const transition = await this.#transitions.findOne({
        _id: `${input.command.taskId}:${String(decision.nextPointerVersion)}`,
        ownerAid: input.ownerAid,
        commandId: input.command.commandId,
      });
      if (
        decision.receipt === undefined ||
        transition === null ||
        transition.receiptSaid !== decision.receipt.decisionReceiptSaid ||
        transition.activeRevisionSaid !== decision.receipt.activeRevisionSaid ||
        transition.pointerVersion !== decision.receipt.pointerVersion
      )
        return { kind: 'Unavailable' };
      return { kind: 'Committed', receipt: decision.receipt, recipientAid: decision.recipientAid };
    } catch {
      return { kind: 'Unavailable' };
    }
  }

  async reserve(
    input: Parameters<ActivationCommitStorage['reserve']>[0],
  ): ReturnType<ActivationCommitStorage['reserve']> {
    const { command, ownerAid, recipientAid } = input;
    if (decodeActivationCommitCommand(command).kind !== 'Accepted') return { kind: 'Conflict' };
    try {
      return await this.#client.withSession(async (session) =>
        session.withTransaction(async () => {
          const prior = await this.#decisions.findOne({ _id: command.commandId }, { session });
          if (prior !== null) {
            if (
              prior.ownerAid !== ownerAid ||
              prior.recipientAid !== recipientAid ||
              !isDeepStrictEqual(prior.command, command)
            )
              return { kind: 'Conflict' as const };
            if (prior.state === 'Committed') {
              if (prior.receipt === undefined) return { kind: 'Unavailable' as const };
              return { kind: 'Committed' as const, receipt: prior.receipt, recipientAid };
            }
            return { kind: 'Reserved' as const, preparedAt: prior.preparedAt };
          }
          let pointer = await this.#pointers.findOne({ _id: command.taskId }, { session });
          if (pointer === null) {
            if (command.expectedPointerVersion !== 1) return { kind: 'Conflict' as const };
            const harness = await this.#harnesses.findOne(
              { _id: command.expectedIncumbentRevisionSaid, ownerAid },
              { session },
            );
            if (harness === null) return { kind: 'Conflict' as const };
            try {
              const decoded = decodeHarnessDocument(harness);
              if (
                decoded.activation.kind !== 'InitialSpecializationAccepted' ||
                decoded.projection.revision.task.taskId !== command.taskId ||
                decoded.projection.revision.task.revisionSaid !== command.taskRevisionSaid ||
                decoded.projection.revision.task.harnessLineageId !== command.harnessLineageId
              )
                return { kind: 'Conflict' as const };
            } catch {
              return { kind: 'Conflict' as const };
            }
            pointer = {
              _id: command.taskId,
              ownerAid,
              taskRevisionSaid: command.taskRevisionSaid,
              harnessLineageId: command.harnessLineageId,
              activeRevisionSaid: command.expectedIncumbentRevisionSaid,
              version: 1,
            };
            await this.#pointers.insertOne(pointer, { session });
          }
          if (
            pointer.ownerAid !== ownerAid ||
            pointer.taskRevisionSaid !== command.taskRevisionSaid ||
            pointer.harnessLineageId !== command.harnessLineageId ||
            pointer.activeRevisionSaid !== command.expectedIncumbentRevisionSaid ||
            pointer.version !== command.expectedPointerVersion ||
            pointer.pendingCommandId !== undefined
          )
            return { kind: 'Conflict' as const };
          const reserved = await this.#pointers.updateOne(
            {
              _id: command.taskId,
              ownerAid,
              activeRevisionSaid: command.expectedIncumbentRevisionSaid,
              version: command.expectedPointerVersion,
              pendingCommandId: { $exists: false },
            },
            { $set: { pendingCommandId: command.commandId } },
            { session },
          );
          if (reserved.matchedCount !== 1) throw new ActivationConflict();
          const preparedAt = Date.now();
          await this.#decisions.insertOne(
            {
              _id: command.commandId,
              ownerAid,
              recipientAid,
              command,
              preparedAt,
              state: 'PendingReceipt',
              targetRevisionSaid:
                command.disposition.kind === 'Activate'
                  ? command.disposition.candidateRevisionSaid
                  : command.expectedIncumbentRevisionSaid,
              nextPointerVersion: command.expectedPointerVersion + 1,
            },
            { session },
          );
          return { kind: 'Reserved' as const, preparedAt };
        }),
      );
    } catch (error) {
      return duplicate(error) || error instanceof ActivationConflict
        ? { kind: 'Conflict' }
        : { kind: 'Unavailable' };
    }
  }

  async finalize(
    input: Parameters<ActivationCommitStorage['finalize']>[0],
  ): ReturnType<ActivationCommitStorage['finalize']> {
    const { ownerAid, command, recipientAid, receiptSaid } = input;
    try {
      return await this.#client.withSession(async (session) =>
        session.withTransaction(async () => {
          const decision = await this.#decisions.findOne(
            { _id: command.commandId, ownerAid },
            { session },
          );
          if (
            decision === null ||
            decision.recipientAid !== recipientAid ||
            !isDeepStrictEqual(decision.command, command)
          )
            return { kind: 'Conflict' as const };
          if (decision.state === 'Committed') {
            return decision.receipt?.decisionReceiptSaid === receiptSaid
              ? { kind: 'Committed' as const, receipt: decision.receipt }
              : { kind: 'Conflict' as const };
          }
          const pointer = await this.#pointers.findOne(
            { _id: command.taskId, ownerAid },
            { session },
          );
          if (
            pointer === null ||
            pointer.pendingCommandId !== command.commandId ||
            pointer.version !== command.expectedPointerVersion ||
            pointer.activeRevisionSaid !== command.expectedIncumbentRevisionSaid ||
            decision.nextPointerVersion !== command.expectedPointerVersion + 1
          )
            return { kind: 'Conflict' as const };
          const receipt: Extract<
            ActivationCommitReceipt,
            { kind: 'Committed' | 'AlreadyCommitted' }
          > = {
            kind: 'Committed',
            decisionReceiptSaid: receiptSaid,
            activeRevisionSaid: decision.targetRevisionSaid,
            pointerVersion: decision.nextPointerVersion,
            disposition: command.disposition.kind === 'Activate' ? 'Activated' : 'Retained',
          };
          await this.#transitions.insertOne(
            {
              _id: `${command.taskId}:${String(decision.nextPointerVersion)}`,
              ownerAid,
              taskId: command.taskId,
              commandId: command.commandId,
              previousRevisionSaid: pointer.activeRevisionSaid,
              activeRevisionSaid: decision.targetRevisionSaid,
              pointerVersion: decision.nextPointerVersion,
              receiptSaid,
              committedAt: new Date(),
            },
            { session },
          );
          const changed = await this.#pointers.updateOne(
            {
              _id: command.taskId,
              ownerAid,
              version: pointer.version,
              activeRevisionSaid: pointer.activeRevisionSaid,
              pendingCommandId: command.commandId,
            },
            {
              $set: {
                activeRevisionSaid: decision.targetRevisionSaid,
                version: decision.nextPointerVersion,
              },
              $unset: { pendingCommandId: '' },
            },
            { session },
          );
          if (changed.matchedCount !== 1) throw new ActivationConflict();
          const recorded = await this.#decisions.updateOne(
            { _id: command.commandId, ownerAid, state: 'PendingReceipt' },
            { $set: { state: 'Committed', receipt } },
            { session },
          );
          if (recorded.matchedCount !== 1) throw new ActivationConflict();
          return { kind: 'Committed' as const, receipt };
        }),
      );
    } catch (error) {
      return duplicate(error) || error instanceof ActivationConflict
        ? { kind: 'Conflict' }
        : { kind: 'Unavailable' };
    }
  }
}
