import { isDeepStrictEqual } from 'node:util';

import {
  MongoServerError,
  type ClientSession,
  type Collection,
  type Db,
  type MongoClient,
} from 'mongodb';

import { acquireFirstRunLease, renewRunLease, type Run } from '@devrandom/domain';

import { harnessRevisionsCollectionName } from '../../harness/infrastructure/mongo-harness-revisions.js';
import {
  decodeHarnessDocument,
  type HarnessDocument,
} from '../../harness/infrastructure/harness-document.js';
import {
  assessRunPurposeAdmission,
  type RunPurposeAdmission,
} from '../domain/run-purpose-admission.js';
import type {
  RunAdmissionReservation,
  RunAdmissionReservations,
} from '../application/run-admissions.js';
import type {
  RunCommitment,
  RunCommitmentInput,
  RunInspection,
  Runs,
} from '../application/runs.js';
import type {
  RunLeaseAcquisition,
  RunLeaseAcquisitionInput,
  RunLeases,
  RunLeaseRenewal,
  RunLeaseRenewalInput,
} from '../application/run-leases.js';
import {
  decodeRunAdmissionDocument,
  encodeAwaitingRunAdmission,
  type RunAdmissionDocument,
} from './run-admission-document.js';
import { decodeRunDocument, encodeRunDocument, type RunDocument } from './run-document.js';

export const runAdmissionsCollectionName = 'runAdmissions' as const;
export const runsCollectionName = 'runs' as const;

export const runAdmissionIndexDefinitions = Object.freeze([
  {
    name: 'run-admission-owner-command-unique',
    key: { ownerAid: 1, commandId: 1 },
    unique: true,
  },
] as const);

export const runIndexNames = Object.freeze({
  ownerCommand: 'run-owner-command-unique',
  calibrationPurpose: 'run-calibration-purpose-unique',
  retainedPurpose: 'run-retained-purpose-unique',
  activeOwner: 'run-active-owner-unique',
  activeGlobal: 'run-active-global-unique',
});

export const runIndexDefinitions = Object.freeze([
  {
    name: runIndexNames.ownerCommand,
    key: { ownerAid: 1, commandId: 1 },
    unique: true,
  },
  {
    name: runIndexNames.calibrationPurpose,
    key: {
      taskId: 1,
      taskRevisionSaid: 1,
      'purpose.campaignId': 1,
      'purpose.ordinal': 1,
    },
    unique: true,
    partialFilterExpression: { 'purpose.kind': 'PreparedCompatibilityCalibration' },
  },
  {
    name: runIndexNames.retainedPurpose,
    key: { taskId: 1, taskRevisionSaid: 1 },
    unique: true,
    partialFilterExpression: { 'purpose.kind': 'Retained' },
  },
  {
    name: runIndexNames.activeOwner,
    key: { activeOwnerSlot: 1 },
    unique: true,
    partialFilterExpression: { activeOwnerSlot: { $exists: true } },
  },
  {
    name: runIndexNames.activeGlobal,
    key: { activeGlobalSlot: 1 },
    unique: true,
    partialFilterExpression: { activeGlobalSlot: { $exists: true } },
  },
] as const);

function duplicateKey(error: unknown): error is MongoServerError {
  return error instanceof MongoServerError && error.code === 11_000;
}

class RunCommitmentAborted extends Error {
  readonly outcome: RunCommitment;

  constructor(outcome: RunCommitment) {
    super(outcome.kind);
    this.name = 'RunCommitmentAborted';
    this.outcome = outcome;
  }
}

function runIsActive(run: Run): boolean {
  return run.lifecycle.kind === 'Active';
}

function rejectedPurposeAdmission(
  admission: Exclude<RunPurposeAdmission, { readonly kind: 'RunPurposeAdmitted' }>,
): RunCommitment {
  switch (admission.kind) {
    case 'ExistingRetainedRunActive':
      return { kind: 'ExistingRunRequiresLaterResume', runId: admission.runId };
    case 'ExistingRetainedRunEnded':
      return { kind: 'RunAlreadyEnded', runId: admission.runId };
    case 'InitialSpecializationMismatch':
      return { kind: 'InitialHarnessIncumbentConflict' };
    case 'PurposeSlotOccupied':
    case 'CalibrationCampaignMismatch':
    case 'CalibrationOrdinalNotNext':
    case 'PriorCalibrationTerminalRequired':
    case 'CalibrationTerminalOutcomeRequired':
    case 'CalibrationCampaignRejected':
    case 'CalibrationCampaignComplete':
    case 'CalibrationCampaignIncomplete':
    case 'CalibrationConfirmationInsufficient':
    case 'CalibrationConfirmationCategoryMismatch':
      return { kind: 'RunCommandConflict' };
  }
}

export class MongoRuns implements RunAdmissionReservations, Runs, RunLeases {
  readonly #client: MongoClient;
  readonly #admissions: Collection<RunAdmissionDocument>;
  readonly #runs: Collection<RunDocument>;
  readonly #harnesses: Collection<HarnessDocument>;

  constructor(client: MongoClient, database: Db) {
    this.#client = client;
    this.#admissions = database.collection<RunAdmissionDocument>(runAdmissionsCollectionName);
    this.#runs = database.collection<RunDocument>(runsCollectionName);
    this.#harnesses = database.collection<HarnessDocument>(harnessRevisionsCollectionName);
  }

  async #reconcileEquivalentRenewal(run: Run): Promise<RunLeaseRenewal> {
    if (run.lease.kind !== 'Held') return { kind: 'RunLeaseConcurrentUpdate' };
    const exact = {
      _id: run.binding.runId,
      ownerAid: run.binding.ownerAid,
      runVersion: run.version,
      'lease.kind': 'Held',
      'lease.incarnationId': run.lease.incarnationId,
    } as const;
    const live = await this.#runs.findOne({
      ...exact,
      $expr: { $gt: [{ $toDate: '$lease.expiresAt' }, '$$NOW'] },
    });
    if (live !== null) {
      return { kind: 'RunLeaseRenewalReconciled', run: decodeRunDocument(live).run };
    }
    const expired = await this.#runs.findOne({
      ...exact,
      $expr: { $lte: [{ $toDate: '$lease.expiresAt' }, '$$NOW'] },
    });
    if (expired !== null) {
      const lease = decodeRunDocument(expired).run.lease;
      if (lease.kind === 'Held') {
        return { kind: 'RunLeaseLaterResumeRequired', expiredAt: lease.expiresAt };
      }
    }
    return { kind: 'RunLeaseConcurrentUpdate' };
  }

  async #reconcileEquivalentFirstLease(run: Run): Promise<RunLeaseAcquisition> {
    if (run.lease.kind !== 'Held') return { kind: 'RunLeaseConcurrentUpdate' };
    const exact = {
      _id: run.binding.runId,
      ownerAid: run.binding.ownerAid,
      runVersion: run.version,
      'lease.kind': 'Held',
      'lease.incarnationId': run.lease.incarnationId,
    } as const;
    const live = await this.#runs.findOne({
      ...exact,
      $expr: { $gt: [{ $toDate: '$lease.expiresAt' }, '$$NOW'] },
    });
    if (live !== null) {
      return { kind: 'RunLeaseReconciled', run: decodeRunDocument(live).run };
    }
    const expired = await this.#runs.findOne({
      ...exact,
      $expr: { $lte: [{ $toDate: '$lease.expiresAt' }, '$$NOW'] },
    });
    if (expired !== null) {
      const lease = decodeRunDocument(expired).run.lease;
      if (lease.kind === 'Held') {
        return { kind: 'RunLeaseLaterResumeRequired', expiredAt: lease.expiresAt };
      }
    }
    return { kind: 'RunLeaseConcurrentUpdate' };
  }

  async reserve(
    input: Parameters<RunAdmissionReservations['reserve']>[0],
  ): Promise<RunAdmissionReservation> {
    try {
      await this.#admissions.insertOne(encodeAwaitingRunAdmission(input));
      return { kind: 'RunAdmissionReserved' };
    } catch (error) {
      if (!duplicateKey(error)) {
        return { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' };
      }
      try {
        const existing = await this.#admissions.findOne({
          ownerAid: input.ownerAid,
          commandId: input.commandId,
        });
        if (existing === null) {
          return { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' };
        }
        const decoded = decodeRunAdmissionDocument(existing);
        if (
          decoded.commandFingerprint !== input.commandFingerprint ||
          decoded.admissionExchangeSaid !== input.admissionExchangeSaid
        ) {
          return { kind: 'RunCommandConflict' };
        }
        if (decoded.state.kind === 'AwaitingExchange') {
          return { kind: 'RunAdmissionReserved' };
        }
        const accepted = await this.#runs.findOne({ _id: decoded.state.runId });
        return accepted === null
          ? { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' }
          : { kind: 'AcceptedRunAdmission', run: decodeRunDocument(accepted).run };
      } catch {
        return { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' };
      }
    }
  }

  async accept(input: RunCommitmentInput): Promise<RunCommitment> {
    try {
      const outcome = await this.#client.withSession((session) =>
        session.withTransaction(() => this.#commit(input, session), {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
        }),
      );
      return outcome;
    } catch (error) {
      if (error instanceof RunCommitmentAborted) {
        return error.outcome;
      }
      if (duplicateKey(error)) {
        if (error.message.includes(runIndexNames.activeOwner)) {
          return { kind: 'OwnerRunCapacityExceeded' };
        }
        if (error.message.includes(runIndexNames.activeGlobal)) {
          return { kind: 'GlobalRunCapacityExceeded' };
        }
        return this.#reconcileCommitConflict(input);
      }
      return { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' };
    }
  }

  async findById(ownerAid: string, runId: string): Promise<RunInspection> {
    try {
      const document = await this.#runs.findOne({ _id: runId, ownerAid });
      return document === null
        ? { kind: 'RunNotFound' }
        : { kind: 'RunFound', run: decodeRunDocument(document).run };
    } catch {
      return { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' };
    }
  }

  async acquire(input: RunLeaseAcquisitionInput): Promise<RunLeaseAcquisition> {
    try {
      const document = await this.#runs.findOne({ _id: input.runId, ownerAid: input.ownerAid });
      if (document === null) {
        return { kind: 'RunNotFound' };
      }
      const current = decodeRunDocument(document).run;
      const acquisition = acquireFirstRunLease(current, input);
      switch (acquisition.kind) {
        case 'Equivalent':
          return await this.#reconcileEquivalentFirstLease(acquisition.run);
        case 'VersionConflict':
          return { kind: 'RunVersionConflict', currentVersion: acquisition.currentVersion };
        case 'LeaseConflict':
          return {
            kind: 'RunLeaseConflict',
            incarnationId: acquisition.incarnationId,
            expiresAt: acquisition.expiresAt,
            currentVersion: acquisition.currentVersion,
          };
        case 'LaterResumeRequired':
          return { kind: 'RunLeaseLaterResumeRequired', expiredAt: acquisition.expiredAt };
        case 'RunNotPreparing':
          return acquisition;
        case 'ServerTimeInvalid':
          return { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' };
        case 'Acquired':
          break;
      }
      if (acquisition.run.lease.kind !== 'Held') return { kind: 'RunLeaseConcurrentUpdate' };
      const candidateExpiry = acquisition.run.lease.expiresAt;
      const replacement = encodeRunDocument(acquisition.run, document.commandFingerprint);
      const committed = await this.#runs.replaceOne(
        {
          _id: input.runId,
          ownerAid: input.ownerAid,
          runVersion: current.version,
          'lease.kind': 'Unassigned',
          $expr: { $gt: [new Date(candidateExpiry), '$$NOW'] },
        },
        replacement,
      );
      if (committed.modifiedCount === 1) {
        return { kind: 'RunLeaseAcquired', run: acquisition.run };
      }
      const expiredCandidate = await this.#runs.findOne({
        _id: input.runId,
        ownerAid: input.ownerAid,
        runVersion: current.version,
        'lease.kind': 'Unassigned',
        $expr: { $lte: [new Date(candidateExpiry), '$$NOW'] },
      });
      if (expiredCandidate !== null) {
        return { kind: 'RunLeaseLaterResumeRequired', expiredAt: candidateExpiry };
      }
      const concurrent = await this.#runs.findOne({ _id: input.runId, ownerAid: input.ownerAid });
      if (concurrent === null) {
        return { kind: 'RunNotFound' };
      }
      const observed = decodeRunDocument(concurrent).run;
      const reconciled = acquireFirstRunLease(observed, input);
      switch (reconciled.kind) {
        case 'Equivalent':
          return await this.#reconcileEquivalentFirstLease(reconciled.run);
        case 'VersionConflict':
          return { kind: 'RunVersionConflict', currentVersion: reconciled.currentVersion };
        case 'LeaseConflict':
          return {
            kind: 'RunLeaseConflict',
            incarnationId: reconciled.incarnationId,
            expiresAt: reconciled.expiresAt,
            currentVersion: reconciled.currentVersion,
          };
        case 'LaterResumeRequired':
          return { kind: 'RunLeaseLaterResumeRequired', expiredAt: reconciled.expiredAt };
        case 'RunNotPreparing':
          return reconciled;
        case 'Acquired':
        case 'ServerTimeInvalid':
          return { kind: 'RunLeaseConcurrentUpdate' };
      }
    } catch {
      return { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' };
    }
  }

  async renew(input: RunLeaseRenewalInput): Promise<RunLeaseRenewal> {
    try {
      const document = await this.#runs.findOne({ _id: input.runId, ownerAid: input.ownerAid });
      if (document === null) {
        return { kind: 'RunNotFound' };
      }
      const current = decodeRunDocument(document).run;
      const renewal = renewRunLease(current, input);
      switch (renewal.kind) {
        case 'Equivalent':
          return await this.#reconcileEquivalentRenewal(renewal.run);
        case 'VersionConflict':
          return { kind: 'RunVersionConflict', currentVersion: renewal.currentVersion };
        case 'LeaseConflict':
          return {
            kind: 'RunLeaseConflict',
            incarnationId: renewal.incarnationId,
            expiresAt: renewal.expiresAt,
            currentVersion: renewal.currentVersion,
          };
        case 'LeaseExpired':
          return { kind: 'RunLeaseLaterResumeRequired', expiredAt: renewal.expiredAt };
        case 'LeaseNotHeld':
          return { kind: 'RunLeaseNotHeld' };
        case 'RunNotRenewable':
          return renewal;
        case 'ServerTimeInvalid':
          return { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' };
        case 'Renewed':
          break;
      }
      const replacement = encodeRunDocument(renewal.run, document.commandFingerprint);
      const committed = await this.#runs.replaceOne(
        {
          _id: input.runId,
          ownerAid: input.ownerAid,
          runVersion: current.version,
          'lease.kind': 'Held',
          'lease.incarnationId': input.incarnationId,
          $expr: { $gt: [{ $toDate: '$lease.expiresAt' }, '$$NOW'] },
        },
        replacement,
      );
      if (committed.modifiedCount === 1) {
        return { kind: 'RunLeaseRenewed', run: renewal.run };
      }
      const expired = await this.#runs.findOne({
        _id: input.runId,
        ownerAid: input.ownerAid,
        runVersion: current.version,
        'lease.kind': 'Held',
        'lease.incarnationId': input.incarnationId,
        $expr: { $lte: [{ $toDate: '$lease.expiresAt' }, '$$NOW'] },
      });
      if (expired !== null) {
        const held = decodeRunDocument(expired).run.lease;
        if (held.kind === 'Held') {
          return { kind: 'RunLeaseLaterResumeRequired', expiredAt: held.expiresAt };
        }
      }
      const concurrent = await this.#runs.findOne({ _id: input.runId, ownerAid: input.ownerAid });
      if (concurrent === null) {
        return { kind: 'RunNotFound' };
      }
      const reconciled = renewRunLease(decodeRunDocument(concurrent).run, input);
      switch (reconciled.kind) {
        case 'Equivalent':
          return await this.#reconcileEquivalentRenewal(reconciled.run);
        case 'VersionConflict':
          return { kind: 'RunVersionConflict', currentVersion: reconciled.currentVersion };
        case 'LeaseConflict':
          return {
            kind: 'RunLeaseConflict',
            incarnationId: reconciled.incarnationId,
            expiresAt: reconciled.expiresAt,
            currentVersion: reconciled.currentVersion,
          };
        case 'LeaseExpired':
          return { kind: 'RunLeaseLaterResumeRequired', expiredAt: reconciled.expiredAt };
        case 'LeaseNotHeld':
          return { kind: 'RunLeaseNotHeld' };
        case 'RunNotRenewable':
          return reconciled;
        case 'Renewed':
        case 'ServerTimeInvalid':
          return { kind: 'RunLeaseConcurrentUpdate' };
      }
    } catch {
      return { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' };
    }
  }

  async #commit(input: RunCommitmentInput, session: ClientSession): Promise<RunCommitment> {
    const admissionDocument = await this.#admissions.findOne(
      { ownerAid: input.ownerAid, commandId: input.commandId },
      { session },
    );
    if (admissionDocument === null) {
      return { kind: 'ConcurrentRunAdmission' };
    }
    const admission = decodeRunAdmissionDocument(admissionDocument);
    if (admission.commandFingerprint !== input.commandFingerprint) {
      return { kind: 'RunCommandConflict' };
    }
    if (admission.state.kind === 'Accepted') {
      const existing = await this.#runs.findOne({ _id: admission.state.runId }, { session });
      if (existing === null) {
        return { kind: 'ConcurrentRunAdmission' };
      }
      const decoded = decodeRunDocument(existing);
      return decoded.commandFingerprint === input.commandFingerprint
        ? { kind: 'ExistingRun', run: decoded.run }
        : { kind: 'RunCommandConflict' };
    }

    const commandRun = await this.#runs.findOne(
      { ownerAid: input.ownerAid, commandId: input.commandId },
      { session },
    );
    if (commandRun !== null) {
      const decoded = decodeRunDocument(commandRun);
      return decoded.commandFingerprint === input.commandFingerprint
        ? { kind: 'ExistingRun', run: decoded.run }
        : { kind: 'RunCommandConflict' };
    }
    const taskRuns = await this.#runs
      .find(
        {
          taskId: input.run.binding.taskId,
          taskRevisionSaid: input.run.binding.taskRevisionSaid,
        },
        { session },
      )
      .toArray();
    const purposeAdmission = assessRunPurposeAdmission(
      taskRuns.map((document) => decodeRunDocument(document).run),
      input.run,
    );
    if (purposeAdmission.kind !== 'RunPurposeAdmitted') {
      return rejectedPurposeAdmission(purposeAdmission);
    }
    if (input.run.binding.budget.activeRunsPerAdmittedUser === 0) {
      return { kind: 'OwnerRunCapacityExceeded' };
    }
    if (input.run.binding.budget.activeHostedWorkRunsGlobally === 0) {
      return { kind: 'GlobalRunCapacityExceeded' };
    }
    const ownerRunCount = await this.#runs.countDocuments(
      { ownerAid: input.ownerAid },
      { session },
    );
    if (ownerRunCount >= input.run.binding.budget.runsPerAdmittedUser) {
      return { kind: 'OwnerRunCapacityExceeded' };
    }
    const globalRunCount = await this.#runs.countDocuments({}, { session });
    if (globalRunCount >= input.run.binding.budget.hostedWorkRunsGlobally) {
      return { kind: 'GlobalRunCapacityExceeded' };
    }
    const activeOwner = await this.#runs.findOne(
      { activeOwnerSlot: input.ownerAid },
      { session, projection: { _id: 1 } },
    );
    if (activeOwner !== null) {
      return { kind: 'OwnerRunCapacityExceeded' };
    }
    const activeGlobal = await this.#runs.findOne(
      { activeGlobalSlot: 'Active' },
      { session, projection: { _id: 1 } },
    );
    if (activeGlobal !== null) {
      return { kind: 'GlobalRunCapacityExceeded' };
    }
    const harnessDocument = await this.#harnesses.findOne(
      { _id: input.activation.harnessRevisionSaid, ownerAid: input.ownerAid },
      { session },
    );
    if (harnessDocument === null) {
      return { kind: 'InitialHarnessIncumbentConflict' };
    }
    const harness = decodeHarnessDocument(harnessDocument);
    if (!isDeepStrictEqual(input.run.binding.initialSpecialization, input.activation)) {
      return { kind: 'InitialHarnessIncumbentConflict' };
    }
    if (harness.activation.kind === 'AwaitingRunAdmission') {
      if (
        input.run.binding.purpose.kind !== 'PreparedCompatibilityCalibration' ||
        input.run.binding.purpose.ordinal !== 1 ||
        !isDeepStrictEqual(harness.activation, {
          kind: 'AwaitingRunAdmission',
          harnessLineageId: input.activation.harnessLineageId,
          harnessRevisionSaid: input.activation.harnessRevisionSaid,
        })
      ) {
        return { kind: 'InitialHarnessIncumbentConflict' };
      }
      const activated = await this.#harnesses.updateOne(
        {
          _id: input.activation.harnessRevisionSaid,
          ownerAid: input.ownerAid,
          'activation.kind': 'AwaitingRunAdmission',
        },
        {
          $set: {
            activation: {
              ...input.activation,
              acceptedAt: new Date(input.activation.acceptedAt),
            },
          },
        },
        { session },
      );
      if (activated.modifiedCount !== 1) {
        throw new RunCommitmentAborted({ kind: 'InitialHarnessIncumbentConflict' });
      }
    } else if (!isDeepStrictEqual(harness.activation, input.activation)) {
      return { kind: 'InitialHarnessIncumbentConflict' };
    }
    await this.#runs.insertOne(encodeRunDocument(input.run, input.commandFingerprint), { session });
    const acknowledged = await this.#admissions.updateOne(
      {
        ownerAid: input.ownerAid,
        commandId: input.commandId,
        commandFingerprint: input.commandFingerprint,
        'state.kind': 'AwaitingExchange',
      },
      {
        $set: {
          state: {
            kind: 'Accepted',
            runId: input.run.binding.runId,
            acceptedAt: input.run.binding.acceptedAt,
          },
        },
      },
      { session },
    );
    if (acknowledged.modifiedCount !== 1) {
      throw new RunCommitmentAborted({ kind: 'ConcurrentRunAdmission' });
    }
    return { kind: 'RunCommitted', run: input.run };
  }

  async #reconcileCommitConflict(input: RunCommitmentInput): Promise<RunCommitment> {
    try {
      const commandRun = await this.#runs.findOne({
        ownerAid: input.ownerAid,
        commandId: input.commandId,
      });
      if (commandRun !== null) {
        const decoded = decodeRunDocument(commandRun);
        return decoded.commandFingerprint === input.commandFingerprint
          ? { kind: 'ExistingRun', run: decoded.run }
          : { kind: 'RunCommandConflict' };
      }
      const purpose = input.run.binding.purpose;
      const purposeRun = await this.#runs.findOne(
        purpose.kind === 'Retained'
          ? {
              taskId: input.run.binding.taskId,
              taskRevisionSaid: input.run.binding.taskRevisionSaid,
              'purpose.kind': 'Retained',
            }
          : {
              taskId: input.run.binding.taskId,
              taskRevisionSaid: input.run.binding.taskRevisionSaid,
              'purpose.kind': 'PreparedCompatibilityCalibration',
              'purpose.campaignId': purpose.campaignId,
              'purpose.ordinal': purpose.ordinal,
            },
      );
      if (purposeRun !== null) {
        const decoded = decodeRunDocument(purposeRun).run;
        if (decoded.binding.purpose.kind === 'Retained') {
          return runIsActive(decoded)
            ? { kind: 'ExistingRunRequiresLaterResume', runId: decoded.binding.runId }
            : { kind: 'RunAlreadyEnded', runId: decoded.binding.runId };
        }
        return { kind: 'RunCommandConflict' };
      }
      return { kind: 'ConcurrentRunAdmission' };
    } catch {
      return { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' };
    }
  }
}
