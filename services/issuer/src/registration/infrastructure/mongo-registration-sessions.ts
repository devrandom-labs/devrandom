import { MongoServerError, type Collection, type Db, type WithId } from 'mongodb';

import {
  observeRegistrationSession,
  type RegistrationSession,
} from '../domain/registration-session.js';
import type {
  RegistrationCommit,
  RegistrationCreation,
  RegistrationSessions,
  RegistrationSnapshot,
} from '../application/registration-enrollment.js';
import {
  decodeRegistrationSessionDocument,
  encodeRegistrationSessionDocument,
  RegistrationSessionDocumentFailure,
} from './registration-session-document.js';

interface RegistrationSessionDocument {
  readonly _id: string;
  readonly revision: number;
  readonly session: string;
  readonly creationKeyHash: string;
  readonly proofResponseSaid?: string;
  readonly purgeAt: Date;
}

export type RegistrationRepositoryError =
  | { readonly kind: 'registration-already-exists'; readonly registrationId: string }
  | { readonly kind: 'registration-document-invalid'; readonly reason: string };

export class RegistrationRepositoryFailure extends Error {
  readonly detail: RegistrationRepositoryError;

  constructor(detail: RegistrationRepositoryError) {
    super(registrationRepositoryErrorMessage(detail));
    this.name = 'RegistrationRepositoryFailure';
    this.detail = detail;
  }
}

export class MongoRegistrationSessions implements RegistrationSessions {
  readonly #database: Db;
  readonly #sessions: Collection<RegistrationSessionDocument>;
  readonly #retentionMilliseconds: number;

  constructor(database: Db, retentionMilliseconds: number) {
    if (!Number.isSafeInteger(retentionMilliseconds) || retentionMilliseconds < 0) {
      throw new RegistrationRepositoryFailure({
        kind: 'registration-document-invalid',
        reason: 'retention must be a non-negative integer number of milliseconds',
      });
    }

    this.#database = database;
    this.#sessions = database.collection<RegistrationSessionDocument>('registration_sessions');
    this.#retentionMilliseconds = retentionMilliseconds;
  }

  async prepare(): Promise<void> {
    await this.verify();
    await this.#sessions.createIndex(
      { purgeAt: 1 },
      { name: 'registration-expiry', expireAfterSeconds: 0 },
    );
    await this.#sessions.createIndex(
      { creationKeyHash: 1 },
      { name: 'registration-creation-key', unique: true },
    );
    await this.#sessions.createIndex(
      { proofResponseSaid: 1 },
      {
        name: 'registration-proof-response',
        unique: true,
        partialFilterExpression: { proofResponseSaid: { $type: 'string' } },
      },
    );
  }

  async verify(): Promise<void> {
    await this.#database.command({ ping: 1 });
  }

  async create(
    session: RegistrationSession,
    creationKeyHash: string,
  ): Promise<RegistrationCreation> {
    if (!/^[a-f0-9]{64}$/u.test(creationKeyHash)) {
      throw new RegistrationRepositoryFailure({
        kind: 'registration-document-invalid',
        reason: 'creation key hash is invalid',
      });
    }
    const document = this.#document(session, creationKeyHash);
    try {
      await this.#sessions.insertOne(document);
    } catch (error) {
      if (duplicateKey(error)) {
        const existing = await this.#sessions.findOne({ creationKeyHash });
        if (existing !== null) {
          return { kind: 'registration-already-created', ...decodeSnapshot(existing) };
        }
        throw new RegistrationRepositoryFailure({
          kind: 'registration-already-exists',
          registrationId: session.binding.registrationId,
        });
      }
      throw error;
    }

    return { kind: 'registration-created', revision: 0, session };
  }

  async retrieveByCreationKeyHash(
    creationKeyHash: string,
    observedAt: number,
  ): Promise<RegistrationSnapshot | undefined> {
    const stored = await this.#sessions.findOne({ creationKeyHash });
    if (stored === null) {
      return undefined;
    }
    const snapshot = decodeSnapshot(stored);
    return this.retrieve(snapshot.session.binding.registrationId, observedAt);
  }

  async retrieve(
    registrationId: string,
    observedAt: number,
  ): Promise<RegistrationSnapshot | undefined> {
    for (;;) {
      const stored = await this.#sessions.findOne({ _id: registrationId });
      if (stored === null) {
        return undefined;
      }

      const snapshot = decodeSnapshot(stored);
      const observed = observeRegistrationSession(snapshot.session, observedAt);
      if (observed.kind !== 'expired' || snapshot.session.kind === 'expired') {
        return snapshot;
      }

      const expiration = await this.commit(snapshot, observed);
      if (expiration.kind === 'registration-committed') {
        return expiration.snapshot;
      }
      if (expiration.kind === 'registration-proof-replayed') {
        throw new RegistrationRepositoryFailure({
          kind: 'registration-document-invalid',
          reason: 'expiry attempted to consume proof evidence',
        });
      }
    }
  }

  async commit(
    current: RegistrationSnapshot,
    next: RegistrationSession,
  ): Promise<RegistrationCommit> {
    const registrationId = current.session.binding.registrationId;
    if (next.binding.registrationId !== registrationId) {
      throw new RegistrationRepositoryFailure({
        kind: 'registration-document-invalid',
        reason: 'a transition cannot replace the Registration Session identity',
      });
    }

    const set: RegistrationSessionUpdate = {
      revision: current.revision + 1,
      session: encodeRegistrationSessionDocument(next),
      purgeAt: this.#purgeAt(next.binding.expiresAt),
    };
    const responseSaid = proofResponseSaid(next);
    if (responseSaid !== undefined) {
      set.proofResponseSaid = responseSaid;
    }

    try {
      const result = await this.#sessions.updateOne(
        { _id: registrationId, revision: current.revision },
        { $set: set },
      );
      if (result.modifiedCount !== 1) {
        return { kind: 'registration-concurrently-modified' };
      }
    } catch (error) {
      if (duplicateKey(error)) {
        return { kind: 'registration-proof-replayed' };
      }
      throw error;
    }

    return {
      kind: 'registration-committed',
      snapshot: { revision: current.revision + 1, session: next },
    };
  }

  #document(session: RegistrationSession, creationKeyHash: string): RegistrationSessionDocument {
    return {
      _id: session.binding.registrationId,
      revision: 0,
      session: encodeRegistrationSessionDocument(session),
      creationKeyHash,
      purgeAt: this.#purgeAt(session.binding.expiresAt),
    };
  }

  #purgeAt(expiresAt: number): Date {
    const purgeAt = expiresAt + this.#retentionMilliseconds;
    if (!Number.isSafeInteger(purgeAt)) {
      throw new RegistrationRepositoryFailure({
        kind: 'registration-document-invalid',
        reason: 'retention exceeds the supported timestamp range',
      });
    }
    return new Date(purgeAt);
  }
}

interface RegistrationSessionUpdate {
  revision: number;
  session: string;
  proofResponseSaid?: string;
  purgeAt: Date;
}

function decodeSnapshot(document: WithId<RegistrationSessionDocument>): RegistrationSnapshot {
  if (
    !Number.isSafeInteger(document.revision) ||
    document.revision < 0 ||
    typeof document.session !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(document.creationKeyHash) ||
    !(document.purgeAt instanceof Date) ||
    Number.isNaN(document.purgeAt.valueOf()) ||
    (document.proofResponseSaid !== undefined && typeof document.proofResponseSaid !== 'string')
  ) {
    throw new RegistrationRepositoryFailure({
      kind: 'registration-document-invalid',
      reason: 'MongoDB metadata does not match the current schema',
    });
  }

  let session: RegistrationSession;
  try {
    session = decodeRegistrationSessionDocument(document.session);
  } catch (error) {
    if (error instanceof RegistrationSessionDocumentFailure) {
      throw new RegistrationRepositoryFailure({
        kind: 'registration-document-invalid',
        reason: error.message,
      });
    }
    throw error;
  }

  if (session.binding.registrationId !== document._id) {
    throw new RegistrationRepositoryFailure({
      kind: 'registration-document-invalid',
      reason: 'MongoDB identity does not match the Registration Session identity',
    });
  }

  const activeProof = proofResponseSaid(session);
  if (activeProof !== undefined && document.proofResponseSaid !== activeProof) {
    throw new RegistrationRepositoryFailure({
      kind: 'registration-document-invalid',
      reason: 'MongoDB proof replay metadata does not match the Registration Session proof',
    });
  }

  return { revision: document.revision, session };
}

function proofResponseSaid(session: RegistrationSession): string | undefined {
  switch (session.kind) {
    case 'pending-proof':
    case 'rejected':
    case 'expired':
      return undefined;
    case 'pending-approval':
    case 'approved':
    case 'issuing':
    case 'issued':
      return session.proof.responseSaid;
  }
}

function duplicateKey(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11_000;
}

function registrationRepositoryErrorMessage(error: RegistrationRepositoryError): string {
  switch (error.kind) {
    case 'registration-already-exists':
      return `Registration Session ${error.registrationId} already exists`;
    case 'registration-document-invalid':
      return error.reason;
  }
}
