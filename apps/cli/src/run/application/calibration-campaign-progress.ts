import { readCalibrationContinuationHistory } from './calibration-continuation-history.js';
import { isDeepStrictEqual } from 'node:util';
import {
  preparedCompatibilityFailureCategoriesMatch,
  type CalibrationRejectionReason,
} from '@devrandom/domain';
import {
  decodeEvidenceEvent,
  decodeRunProjection,
  type EvidenceEvent,
  type EvidenceStreamProjection,
  type RunProjection,
  type TaskProjection,
} from '@devrandom/protocol';
import type { BaselineRunBinding, StableBaselineRunAdmission } from './baseline-run-admission.js';
import type {
  CompatibilityCalibrationRecordReading,
  PreparedCompatibilityCalibrationEntry,
} from './prepared-compatibility-calibration.js';
import type {
  HostedRunStatuses,
  HostedRunTimelines,
  TaskRunObservationAuthority,
} from './task-run-observation.js';

type CalibrationOrdinal = 1 | 2 | 3 | 4 | 5;

export type CalibrationCampaignProgress =
  | {
      readonly kind: 'Ready';
      readonly nextOrdinal: CalibrationOrdinal | 6;
      readonly confirmed: number;
      readonly excluded: number;
      readonly priorBinding?: BaselineRunBinding;
    }
  | {
      readonly kind: 'RecoveryRequired';
      readonly runId: string;
      readonly ordinal: CalibrationOrdinal;
    }
  | {
      readonly kind: 'Rejected';
      readonly runId: string;
      readonly ordinal: CalibrationOrdinal;
      readonly reason: CalibrationRejectionReason;
    }
  | { readonly kind: 'RetainedRunExists'; readonly runId: string }
  | { readonly kind: 'Unavailable' };

/** Run-owned conversation: which exact campaign slot can lawfully start next? */
export interface CalibrationCampaignProgressReading {
  inspect(taskLabel: string, campaignId: string): Promise<CalibrationCampaignProgress>;
}

export interface TaskRunAdmissionHistory {
  inspectTaskAdmissions(
    taskId: string,
  ): Promise<
    | { readonly kind: 'Found'; readonly admissions: readonly StableBaselineRunAdmission[] }
    | { readonly kind: 'Unavailable' }
  >;
}

export interface CalibrationCampaignRecords {
  read(taskId: string, harnessRevisionSaid: string): Promise<CompatibilityCalibrationRecordReading>;
}

export interface CalibrationCampaignProgressDependencies {
  readonly authority: TaskRunObservationAuthority;
  readonly admissions: TaskRunAdmissionHistory;
  readonly records: CalibrationCampaignRecords;
  now(): number;
}

function ordinal(admission: StableBaselineRunAdmission): CalibrationOrdinal | 6 {
  return admission.binding.purpose.kind === 'Retained' ? 6 : admission.binding.purpose.ordinal;
}

function bindingMatchesTask(binding: BaselineRunBinding, task: TaskProjection): boolean {
  return (
    binding.ownerAid === task.ownerAid &&
    binding.taskId === task.taskId &&
    binding.taskRevisionSaid === task.revisionSaid &&
    binding.harnessLineageId === task.harnessLineageId &&
    isDeepStrictEqual(binding.repository, task.revision.repository)
  );
}

function sameCampaignAuthority(left: BaselineRunBinding, right: BaselineRunBinding): boolean {
  return isDeepStrictEqual({ ...left, purpose: right.purpose }, right);
}

function runMatchesAdmission(
  run: RunProjection,
  admission: Extract<StableBaselineRunAdmission, { kind: 'RunAccepted' | 'LeaseAccepted' }>,
): boolean {
  const binding = admission.binding;
  return (
    decodeRunProjection(run).kind === 'Accepted' &&
    run.runId === admission.run.runId &&
    run.ownerAid === binding.ownerAid &&
    run.taskId === binding.taskId &&
    run.taskRevisionSaid === binding.taskRevisionSaid &&
    run.harnessLineageId === binding.harnessLineageId &&
    run.harnessRevisionSaid === binding.harnessRevisionSaid &&
    run.personalAgentAid === binding.personalAgentAid &&
    run.taskMandateSaid === binding.taskMandateSaid &&
    run.governorAid === binding.governorAid &&
    run.promotionMandateSaid === binding.promotionMandateSaid &&
    run.commandId === admission.commandId &&
    run.admissionExchangeSaid === admission.exchangeSaid &&
    run.evidenceStreamId === admission.run.evidenceStreamId &&
    isDeepStrictEqual(run.purpose, binding.purpose) &&
    isDeepStrictEqual(run.repository, binding.repository) &&
    (run.currentExecution !== undefined ||
      run.lease.kind === 'Unassigned' ||
      run.lease.incarnationId === admission.incarnationId)
  );
}

function sameStream(left: EvidenceStreamProjection, right: EvidenceStreamProjection): boolean {
  return isDeepStrictEqual(left, right);
}

/** This checks the complete accepted chain; it never turns a local counter into hosted truth. */
async function sealedCalibration(
  run: RunProjection,
  admission: StableBaselineRunAdmission,
  evidence: HostedRunTimelines,
  runs: HostedRunStatuses,
): Promise<'Verified' | 'RecoveryRequired' | 'Unavailable'> {
  if (run.lifecycle.kind !== 'Ended') return 'RecoveryRequired';
  const history = await readCalibrationContinuationHistory(run, runs, evidence);
  if (
    history.kind !== 'Verified' ||
    (history.predecessorIncarnationId !== undefined &&
      history.predecessorIncarnationId !== admission.incarnationId)
  )
    return 'Unavailable';
  const scope =
    history.predecessorEvents.length === 0 ? {} : { evidenceStreamId: history.evidenceStreamId };
  const first = await evidence.inspect(run.runId, { limit: 100, ...scope });
  if (first.kind !== 'Found') return 'Unavailable';
  const stream = first.page.stream;
  if (stream.runId !== run.runId || stream.evidenceStreamId !== history.evidenceStreamId)
    return 'Unavailable';
  if (
    stream.seal.kind !== 'Sealed' ||
    stream.checkpoint.kind !== 'Accepted' ||
    stream.cursor.kind !== 'Accepted'
  )
    return 'RecoveryRequired';
  const checkpointSaid = run.lifecycle.outcome.checkpointSaid;
  if (stream.checkpoint.checkpointSaid !== checkpointSaid) return 'Unavailable';
  let page = first.page;
  let sequence = 0;
  let head: string | undefined;
  let started = false;
  let accepted = false;
  let recorded: Extract<EvidenceEvent['event'], { kind: 'RunCalibrationRecorded' }> | undefined;
  const cursors = new Set<string>();
  for (let pages = 0; ; pages += 1) {
    if (pages >= 64 || !sameStream(stream, page.stream)) return 'Unavailable';
    for (const { event } of page.events) {
      if (
        decodeEvidenceEvent(event).kind !== 'Accepted' ||
        event.sequence !== sequence ||
        event.runId !== run.runId ||
        event.incarnationId !== (history.incarnationId ?? admission.incarnationId) ||
        event.taskId !== run.taskId ||
        event.taskRevisionSaid !== run.taskRevisionSaid ||
        event.harnessRevisionSaid !== run.harnessRevisionSaid ||
        event.personalAgentAid !== run.personalAgentAid ||
        event.taskMandateSaid !== run.taskMandateSaid ||
        (head === undefined
          ? event.predecessor.kind !== 'Genesis'
          : event.predecessor.kind !== 'Previous' || event.predecessor.eventSaid !== head)
      )
        return 'Unavailable';
      if (
        event.event.kind === 'RunStarted' &&
        event.producer.kind === 'RunSupervisor' &&
        event.sequence === 0
      )
        started = true;
      if (event.event.kind === 'RunCalibrationRecorded') {
        if (
          recorded !== undefined ||
          event.producer.kind !== 'RunSupervisor' ||
          event.event.checkpointSaid !== checkpointSaid
        )
          return 'Unavailable';
        recorded = event.event;
      }
      if (
        event.event.kind === 'CheckpointAccepted' &&
        event.producer.kind === 'EvidenceRecorder' &&
        event.event.checkpointSaid === checkpointSaid &&
        recorded !== undefined
      )
        accepted = true;
      head = event.d;
      sequence += 1;
    }
    if (page.nextCursor === null) break;
    if (page.events.length === 0 || cursors.has(page.nextCursor)) return 'Unavailable';
    cursors.add(page.nextCursor);
    const next = await evidence.inspect(run.runId, {
      limit: 100,
      cursor: page.nextCursor,
      ...scope,
    });
    if (next.kind !== 'Found') return 'Unavailable';
    page = next.page;
  }
  if (
    !started ||
    !accepted ||
    recorded === undefined ||
    sequence !== stream.cursor.eventCount ||
    sequence !== stream.seal.eventCount ||
    sequence - 1 !== stream.cursor.acceptedThroughSequence ||
    sequence - 1 !== stream.seal.finalSequence ||
    head !== stream.cursor.chainHeadSaid ||
    head !== stream.seal.chainHeadSaid
  )
    return 'Unavailable';
  const outcome = run.lifecycle.outcome;
  switch (outcome.kind) {
    case 'CalibrationConfirmed':
      return recorded.disposition.kind === 'Confirmed' &&
        preparedCompatibilityFailureCategoriesMatch(recorded.disposition.category, outcome.category)
        ? 'Verified'
        : 'Unavailable';
    case 'CalibrationExcluded':
      return recorded.disposition.kind === 'Excluded' &&
        recorded.disposition.reason === outcome.reason
        ? 'Verified'
        : 'Unavailable';
    case 'CalibrationRejected':
      return recorded.disposition.kind === 'Rejected' &&
        recorded.disposition.reason === outcome.reason
        ? 'Verified'
        : 'Unavailable';
    case 'Cancelled':
    case 'Submitted':
    case 'Failed':
    case 'AuthorityRevoked':
      return 'Unavailable';
  }
}

function localEntryMatches(
  entry: PreparedCompatibilityCalibrationEntry,
  run: RunProjection,
): boolean {
  if (entry.runId !== run.runId || run.lifecycle.kind !== 'Ended') return false;
  const outcome = run.lifecycle.outcome;
  switch (entry.kind) {
    case 'Counted':
      return (
        outcome.kind === 'CalibrationConfirmed' &&
        preparedCompatibilityFailureCategoriesMatch(entry.category, outcome.category)
      );
    case 'Excluded':
      return outcome.kind === 'CalibrationExcluded' && entry.reason === outcome.reason;
    case 'Rejected':
      return outcome.kind === 'CalibrationRejected' && entry.reason === outcome.reason;
  }
}

/** Application sequencing over local admission custody and owner-authenticated hosted facts. */
export class VerifiedCalibrationCampaignProgress implements CalibrationCampaignProgressReading {
  readonly #dependencies: CalibrationCampaignProgressDependencies;
  constructor(dependencies: CalibrationCampaignProgressDependencies) {
    this.#dependencies = dependencies;
  }

  async inspect(taskLabel: string, campaignId: string): Promise<CalibrationCampaignProgress> {
    try {
      return await this.#inspect(taskLabel, campaignId);
    } catch {
      return { kind: 'Unavailable' };
    }
  }

  async #inspect(taskLabel: string, campaignId: string): Promise<CalibrationCampaignProgress> {
    const authority = await this.#dependencies.authority.acquireHostedWork();
    if (
      authority.kind !== 'Authorized' ||
      !Number.isFinite(this.#dependencies.now()) ||
      !Number.isFinite(Date.parse(authority.grantExpiresAt)) ||
      this.#dependencies.now() >= Date.parse(authority.grantExpiresAt)
    )
      return { kind: 'Unavailable' };
    const taskReading = await authority.tasks.inspect(taskLabel);
    if (taskReading.kind !== 'Inspected') return { kind: 'Unavailable' };
    const task = taskReading.task;
    const history = await this.#dependencies.admissions.inspectTaskAdmissions(task.taskId);
    if (history.kind !== 'Found' || history.admissions.length > 6) return { kind: 'Unavailable' };
    const admissions = [...history.admissions].sort(
      (left, right) => ordinal(left) - ordinal(right),
    );
    const first = admissions[0];
    if (first === undefined) return { kind: 'Ready', nextOrdinal: 1, confirmed: 0, excluded: 0 };
    for (const [index, admission] of admissions.entries()) {
      if (
        (index < admissions.length - 1 && admission.kind !== 'LeaseAccepted') ||
        ordinal(admission) !== index + 1 ||
        !bindingMatchesTask(admission.binding, task) ||
        !sameCampaignAuthority(first.binding, admission.binding) ||
        (admission.binding.purpose.kind === 'PreparedCompatibilityCalibration' &&
          admission.binding.purpose.campaignId !== campaignId)
      )
        return { kind: 'Unavailable' };
    }
    const local = await this.#dependencies.records.read(
      task.taskId,
      first.binding.harnessRevisionSaid,
    );
    if (local.kind !== 'Loaded' && local.kind !== 'NotFound') return { kind: 'Unavailable' };
    const attempts = local.kind === 'Loaded' ? local.record.attempts : [];
    if (
      new Set(attempts.map((attempt) => attempt.runId)).size !== attempts.length ||
      attempts.length > Math.min(5, admissions.length)
    )
      return { kind: 'Unavailable' };
    let confirmed = 0;
    let excluded = 0;
    let confirmedCategory:
      Extract<PreparedCompatibilityCalibrationEntry, { kind: 'Counted' }>['category'] | undefined;
    for (const admission of admissions) {
      const slot = ordinal(admission);
      if (admission.kind !== 'RunAccepted' && admission.kind !== 'LeaseAccepted') {
        return attempts.length === slot - 1
          ? { kind: 'Ready', nextOrdinal: slot, confirmed, excluded, priorBinding: first.binding }
          : { kind: 'Unavailable' };
      }
      const reading = await authority.runs.inspect(admission.run.runId);
      if (reading.kind !== 'Found' || !runMatchesAdmission(reading.run, admission))
        return { kind: 'Unavailable' };
      if (slot === 6) return { kind: 'RetainedRunExists', runId: reading.run.runId };
      const run = reading.run;
      const verified = await sealedCalibration(run, admission, authority.evidence, authority.runs);
      if (verified === 'Unavailable') return { kind: 'Unavailable' };
      if (verified === 'RecoveryRequired')
        return { kind: 'RecoveryRequired', runId: run.runId, ordinal: slot };
      const entry = attempts[slot - 1];
      if (entry === undefined) return { kind: 'RecoveryRequired', runId: run.runId, ordinal: slot };
      if (!localEntryMatches(entry, run)) return { kind: 'Unavailable' };
      if (entry.kind === 'Rejected')
        return { kind: 'Rejected', runId: run.runId, ordinal: slot, reason: entry.reason };
      if (entry.kind === 'Counted') {
        if (
          entry.category.taskId !== task.taskId ||
          entry.category.taskRevisionSaid !== task.revisionSaid ||
          entry.category.harnessRevisionSaid !== first.binding.harnessRevisionSaid ||
          (confirmedCategory !== undefined &&
            !preparedCompatibilityFailureCategoriesMatch(confirmedCategory, entry.category))
        )
          return { kind: 'Unavailable' };
        confirmedCategory = entry.category;
        confirmed += 1;
      } else excluded += 1;
    }
    if (
      local.kind === 'Loaded' &&
      (confirmedCategory === undefined
        ? local.record.binding.kind !== 'AwaitingConfirmedCategory'
        : local.record.binding.kind !== 'Bound' ||
          !preparedCompatibilityFailureCategoriesMatch(
            local.record.binding.category,
            confirmedCategory,
          ))
    )
      return { kind: 'Unavailable' };
    if (
      attempts.length !== admissions.length ||
      this.#dependencies.now() >= Date.parse(authority.grantExpiresAt)
    )
      return { kind: 'Unavailable' };
    return {
      kind: 'Ready',
      nextOrdinal: (attempts.length + 1) as CalibrationOrdinal | 6,
      confirmed,
      excluded,
      priorBinding: first.binding,
    };
  }
}
