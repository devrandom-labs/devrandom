import { Buffer } from 'node:buffer';
import { isDeepStrictEqual } from 'node:util';

import { Binary, MongoServerError, type Collection, type Db, type MongoClient } from 'mongodb';

import { taskBudgetCeilings, taskEvaluationBudgetCeilings } from '@devrandom/domain';
import {
  bindEvaluationVerifierBundle,
  decodeEvaluationVerifierBundleBytes,
  decodeProtectedEvaluationArtifact,
  type EvaluationManifest,
  type EvaluationVerifierBundle,
  type ProtectedEvaluationArtifact,
} from '@devrandom/protocol';

import {
  evidenceCollectionNames,
  evidenceUsageDocumentId,
} from '../../evidence/infrastructure/evidence-storage-contract.js';
import type { EvidenceUsageDocument } from '../../evidence/infrastructure/evidence-usage-document.js';
import type {
  EvaluationManifestLockOutcome,
  EvaluationManifestLocks,
} from '../application/lock-evaluation-manifest.js';
import {
  evaluationCollectionNames,
  type EvaluationDocument,
} from './mongo-evaluation-reservations.js';

export interface EvaluationManifestLockDocument {
  readonly _id: string;
  readonly ownerAid: string;
  readonly manifest: EvaluationManifest;
  readonly verifierBundle: EvaluationVerifierBundle;
  readonly verifierBytes: Binary;
  readonly protectedArtifactSaids: readonly string[];
  readonly leaseId: string;
  readonly lockedAtLeaseVersion: number;
  readonly lockedAtEvaluationVersion: number;
  readonly commandId: string;
  readonly fingerprint: string;
  readonly acceptedAt: Date;
}

interface EvaluationProtectedArtifactDocument {
  readonly _id: string;
  readonly ownerAid: string;
  readonly evaluationId: string;
  readonly custody: 'Public' | 'ProtectedCiphertext';
  readonly artifact: ProtectedEvaluationArtifact;
  readonly acceptedAt: Date;
}

class ManifestTransactionAborted extends Error {
  readonly outcome: Awaited<ReturnType<EvaluationManifestLocks['lock']>>;

  constructor(outcome: Awaited<ReturnType<EvaluationManifestLocks['lock']>>) {
    super(outcome.kind);
    this.outcome = outcome;
  }
}

function duplicateKey(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11000;
}

function matchesAdmission(
  evaluation: EvaluationDocument,
  manifest: EvaluationManifest,
  ownerAid: string,
): boolean {
  const admitted = evaluation.command;
  return (
    manifest.evaluationId === evaluation._id &&
    manifest.taskId === admitted.taskId &&
    manifest.taskRevisionSaid === admitted.taskRevisionSaid &&
    manifest.originRunId === admitted.originRunId &&
    manifest.ownerAid === ownerAid &&
    manifest.personalAgentAid === admitted.personalAgentAid &&
    manifest.taskMandateSaid === admitted.taskMandateSaid &&
    manifest.retainedCheckpointSaid === admitted.retainedCheckpointSaid &&
    manifest.retainedSealSaid === admitted.retainedSealSaid &&
    manifest.policySaid === admitted.policySaid &&
    manifest.revisions.H1 === admitted.expectedActiveRevisionSaid &&
    manifest.executionProfileSaid === admitted.executionProfileSaid &&
    manifest.sourceInventorySaid === admitted.sourceInventorySaid &&
    isDeepStrictEqual(manifest.allocation, admitted.allocation)
  );
}

/** One-owner immutable M with raw verifier and ciphertext custody in the same replica transaction. */
export class MongoEvaluationManifestLocks implements EvaluationManifestLocks {
  readonly #client: MongoClient;
  readonly #evaluations: Collection<EvaluationDocument>;
  readonly #locks: Collection<EvaluationManifestLockDocument>;
  readonly #artifacts: Collection<EvaluationProtectedArtifactDocument>;
  readonly #usage: Collection<EvidenceUsageDocument>;

  constructor(client: MongoClient, database: Db) {
    this.#client = client;
    this.#evaluations = database.collection(evaluationCollectionNames.evaluations);
    this.#locks = database.collection(evaluationCollectionNames.manifests);
    this.#artifacts = database.collection(evaluationCollectionNames.artifacts);
    this.#usage = database.collection(evidenceCollectionNames.usage);
  }

  async inspect(
    input: Parameters<EvaluationManifestLocks['inspect']>[0],
  ): ReturnType<EvaluationManifestLocks['inspect']> {
    try {
      const lock = await this.#locks.findOne({ _id: input.evaluationId, ownerAid: input.ownerAid });
      if (lock === null || lock.manifest.d !== input.manifestSaid) return { kind: 'Conflict' };
      const raw = decodeEvaluationVerifierBundleBytes(lock.verifierBytes.buffer);
      if (
        raw.kind !== 'Accepted' ||
        !isDeepStrictEqual(raw.bundle, lock.verifierBundle) ||
        bindEvaluationVerifierBundle(raw.bundle, lock.manifest).kind !== 'Bound'
      )
        return { kind: 'Unavailable' };
      const artifacts = [
        raw.bundle.protectedCase.stimulus,
        raw.bundle.protectedCase.expected,
        raw.bundle.terminalCase.stimulus,
        raw.bundle.terminalCase.expected,
      ];
      if (
        !isDeepStrictEqual(
          lock.protectedArtifactSaids,
          artifacts.map((artifact) => artifact.d),
        )
      )
        return { kind: 'Unavailable' };
      const held = await this.#artifacts
        .find({
          evaluationId: input.evaluationId,
          ownerAid: input.ownerAid,
          _id: { $in: lock.protectedArtifactSaids },
        })
        .toArray();
      if (
        held.length !== 4 ||
        artifacts.some(
          (artifact) =>
            decodeProtectedEvaluationArtifact(artifact).kind !== 'Accepted' ||
            !held.some(
              (document) =>
                document._id === artifact.d &&
                document.custody === 'ProtectedCiphertext' &&
                isDeepStrictEqual(document.artifact, artifact),
            ),
        )
      )
        return { kind: 'Unavailable' };
      const evaluation = await this.#evaluations.findOne({
        _id: input.evaluationId,
        ownerAid: input.ownerAid,
      });
      if (evaluation === null || evaluation.closure !== undefined) return { kind: 'Lost' };
      if (
        evaluation.lease.leaseId !== lock.leaseId ||
        evaluation.lease.version < lock.lockedAtLeaseVersion ||
        evaluation.version < lock.lockedAtEvaluationVersion ||
        Date.parse(evaluation.lease.expiresAt) <= Date.now() ||
        !matchesAdmission(evaluation, lock.manifest, input.ownerAid)
      )
        return { kind: 'Lost' };
      return {
        kind: 'Locked',
        evaluationId: lock._id,
        manifestSaid: lock.manifest.d,
        ownerAid: lock.ownerAid,
        policySaid: lock.manifest.policySaid,
        leaseId: lock.leaseId,
        lockedAtLeaseVersion: lock.lockedAtLeaseVersion,
        lockedAtEvaluationVersion: lock.lockedAtEvaluationVersion,
        currentLeaseVersion: evaluation.lease.version,
        currentEvaluationVersion: evaluation.version,
        taskId: lock.manifest.taskId,
        taskRevisionSaid: lock.manifest.taskRevisionSaid,
        personalAgentAid: lock.manifest.personalAgentAid,
        taskMandateSaid: lock.manifest.taskMandateSaid,
        sourceInventorySaid: lock.manifest.sourceInventorySaid,
      };
    } catch {
      return { kind: 'Unavailable' };
    }
  }

  async lock(
    input: Parameters<EvaluationManifestLocks['lock']>[0],
  ): Promise<EvaluationManifestLockOutcome> {
    const { ownerAid, command, manifest, verifierBytes, protectedArtifacts } = input;
    const reconcile = async (): ReturnType<EvaluationManifestLocks['lock']> => {
      const prior = await this.#locks.findOne({ _id: manifest.evaluationId, ownerAid });
      if (prior === null) return { kind: 'Conflict' };
      if (
        prior.manifest.d !== manifest.d ||
        !isDeepStrictEqual(prior.manifest, manifest) ||
        !isDeepStrictEqual(prior.verifierBundle, command.verifierBundle) ||
        !isDeepStrictEqual(Buffer.from(prior.verifierBytes.buffer), Buffer.from(verifierBytes)) ||
        !isDeepStrictEqual(
          prior.protectedArtifactSaids,
          protectedArtifacts.map((artifact) => artifact.d),
        )
      )
        return { kind: 'Conflict' };
      for (const artifact of protectedArtifacts) {
        const held = await this.#artifacts.findOne({
          _id: artifact.d,
          ownerAid,
          evaluationId: manifest.evaluationId,
          custody: 'ProtectedCiphertext',
        });
        if (held === null || !isDeepStrictEqual(held.artifact, artifact))
          return { kind: 'Conflict' };
      }
      const inspected = await this.inspect({
        ownerAid,
        evaluationId: manifest.evaluationId,
        manifestSaid: manifest.d,
      });
      if (inspected.kind === 'Locked' || inspected.kind === 'AlreadyLocked') {
        return {
          kind: 'AlreadyLocked',
          evaluationId: inspected.evaluationId,
          manifestSaid: inspected.manifestSaid,
          ownerAid: inspected.ownerAid,
          policySaid: inspected.policySaid,
          leaseId: inspected.leaseId,
          lockedAtLeaseVersion: inspected.lockedAtLeaseVersion,
          lockedAtEvaluationVersion: inspected.lockedAtEvaluationVersion,
          currentLeaseVersion: inspected.currentLeaseVersion,
          currentEvaluationVersion: inspected.currentEvaluationVersion,
        };
      }
      return inspected.kind === 'Lost' ? { kind: 'Conflict' } : { kind: inspected.kind };
    };
    try {
      return await this.#client.withSession(async (session) =>
        session.withTransaction(async () => {
          const prior = await this.#locks.findOne({ _id: manifest.evaluationId }, { session });
          if (prior !== null) return reconcile();
          const evaluation = await this.#evaluations.findOne(
            { _id: manifest.evaluationId, ownerAid },
            { session },
          );
          if (evaluation === null || evaluation.closure !== undefined)
            return { kind: 'Conflict' as const };
          if (
            evaluation.version !== command.expectedEvaluationVersion ||
            evaluation.lease.leaseId !== command.leaseId ||
            Date.parse(evaluation.lease.expiresAt) <= Date.now() ||
            !matchesAdmission(evaluation, manifest, ownerAid)
          )
            return { kind: 'Conflict' as const };

          const held = await this.#artifacts
            .find(
              {
                evaluationId: manifest.evaluationId,
                ownerAid,
                _id: { $in: protectedArtifacts.map((artifact) => artifact.d) },
              },
              { session },
            )
            .toArray();
          const newArtifacts = protectedArtifacts.filter(
            (artifact) => !held.some((item) => item._id === artifact.d),
          );
          if (
            held.some(
              (item) =>
                item.custody !== 'ProtectedCiphertext' ||
                !protectedArtifacts.some(
                  (artifact) =>
                    artifact.d === item._id && isDeepStrictEqual(artifact, item.artifact),
                ),
            )
          )
            return { kind: 'Conflict' as const };
          const acceptedBytes =
            verifierBytes.byteLength +
            newArtifacts.reduce(
              (sum, artifact) => sum + Buffer.from(artifact.ciphertext, 'base64url').byteLength,
              0,
            );
          const ceiling = Math.min(
            evaluation.reserved.evidencePlusArtifactsPerRunBytes,
            taskEvaluationBudgetCeilings.evidencePlusArtifactsPerRunBytes,
          );
          if (evaluation.acceptedBytes + acceptedBytes > ceiling)
            return { kind: 'QuotaExceeded' as const };

          const usage = await this.#usage.findOneAndUpdate(
            {
              _id: evidenceUsageDocumentId,
              acceptedBytes: {
                $lte: taskBudgetCeilings.acceptedEvidencePlusArtifactsGloballyBytes - acceptedBytes,
              },
            },
            { $inc: { acceptedBytes, version: 1 } },
            { session, returnDocument: 'after' },
          );
          if (usage === null) return { kind: 'QuotaExceeded' as const };
          if (newArtifacts.length > 0)
            await this.#artifacts.insertMany(
              newArtifacts.map((artifact) => ({
                _id: artifact.d,
                ownerAid,
                evaluationId: manifest.evaluationId,
                custody: 'ProtectedCiphertext' as const,
                artifact,
                acceptedAt: new Date(),
              })),
              { session },
            );
          await this.#locks.insertOne(
            {
              _id: manifest.evaluationId,
              ownerAid,
              manifest,
              verifierBundle: command.verifierBundle,
              verifierBytes: new Binary(Uint8Array.from(verifierBytes)),
              protectedArtifactSaids: protectedArtifacts.map((artifact) => artifact.d),
              leaseId: command.leaseId,
              lockedAtLeaseVersion: evaluation.lease.version,
              lockedAtEvaluationVersion: evaluation.version + 1,
              commandId: command.commandId,
              fingerprint: command.fingerprint,
              acceptedAt: new Date(),
            },
            { session },
          );
          const advanced = await this.#evaluations.updateOne(
            {
              _id: manifest.evaluationId,
              ownerAid,
              version: evaluation.version,
              'lease.leaseId': command.leaseId,
              closure: { $exists: false },
            },
            { $inc: { version: 1, acceptedBytes } },
            { session },
          );
          if (advanced.matchedCount !== 1)
            throw new ManifestTransactionAborted({ kind: 'Conflict' });
          return {
            kind: 'Locked' as const,
            evaluationId: manifest.evaluationId,
            manifestSaid: manifest.d,
            ownerAid,
            policySaid: manifest.policySaid,
            leaseId: command.leaseId,
            lockedAtLeaseVersion: evaluation.lease.version,
            lockedAtEvaluationVersion: evaluation.version + 1,
            currentLeaseVersion: evaluation.lease.version,
            currentEvaluationVersion: evaluation.version + 1,
          };
        }),
      );
    } catch (error) {
      if (error instanceof ManifestTransactionAborted) return error.outcome;
      if (duplicateKey(error)) return reconcile();
      return { kind: 'Unavailable' };
    }
  }
}
