import type {
  EvidenceStreamProjection,
  EvidenceTimelinePage,
  EvidenceTimelineQuery,
  RunProjection,
  RunSuccessorSegment,
  TaskProjection,
} from '@devrandom/protocol';

import type { HostedEvidenceFailure } from './evidence-delivery.js';
import type { HostedRunFailure, StableBaselineRunAdmission } from './baseline-run-admission.js';
import type { HostedTaskFailure, TaskAuthorityFailure } from '../../task/application/user-tasks.js';

type AcceptedRunAdmission = Extract<StableBaselineRunAdmission, { readonly kind: 'LeaseAccepted' }>;

export type AcceptedRunAdmissionLocation =
  | { readonly kind: 'Located'; readonly admission: AcceptedRunAdmission }
  | { readonly kind: 'NotFound' }
  | { readonly kind: 'NotAccepted' }
  | { readonly kind: 'Unavailable' };

export interface AcceptedRunAdmissions {
  locateAcceptedRun(taskId: string): Promise<AcceptedRunAdmissionLocation>;
}

export type HostedRunInspection =
  { readonly kind: 'Found'; readonly run: RunProjection } | HostedRunFailure;

export interface HostedRunStatuses {
  inspect(runId: string): Promise<HostedRunInspection>;
  readSuccessorSegment?(
    runId: string,
    segmentSaid: string,
  ): Promise<{ readonly kind: 'Found'; readonly segment: RunSuccessorSegment } | HostedRunFailure>;
}

export type HostedRunTimelineInspection =
  { readonly kind: 'Found'; readonly page: EvidenceTimelinePage } | HostedEvidenceFailure;

export interface HostedRunTimelines {
  inspect(runId: string, query: EvidenceTimelineQuery): Promise<HostedRunTimelineInspection>;
}

type TaskRunObservationAuthorization =
  | {
      readonly kind: 'Authorized';
      readonly tasks: {
        inspect(
          label: string,
        ): Promise<
          { readonly kind: 'Inspected'; readonly task: TaskProjection } | HostedTaskFailure
        >;
      };
      readonly runs: HostedRunStatuses;
      readonly evidence: HostedRunTimelines;
      readonly grantExpiresAt: string;
    }
  | TaskAuthorityFailure;

export interface TaskRunObservationAuthority {
  acquireHostedWork(): Promise<TaskRunObservationAuthorization>;
}

export type TaskWatchWaiting =
  | { readonly kind: 'Elapsed' }
  | { readonly kind: 'Interrupted' }
  | { readonly kind: 'Unavailable' };

export interface TaskRunObservationDependencies {
  readonly authority: TaskRunObservationAuthority;
  readonly admissions: AcceptedRunAdmissions;
  now(): number;
  wait(milliseconds: number, signal: AbortSignal): Promise<TaskWatchWaiting>;
}

export interface TaskRunStatus {
  readonly task: TaskProjection;
  readonly run: RunProjection;
  readonly stream: EvidenceStreamProjection;
}

export type TaskRunObservationFailure =
  | TaskAuthorityFailure
  | { readonly kind: 'TaskInspectionRejected'; readonly failure: HostedTaskFailure }
  | {
      readonly kind: 'AcceptedRunUnavailable';
      readonly disposition: Exclude<
        AcceptedRunAdmissionLocation,
        { readonly kind: 'Located' }
      >['kind'];
    }
  | { readonly kind: 'RunBindingRejected' }
  | { readonly kind: 'RunInspectionRejected'; readonly failure: HostedRunFailure }
  | { readonly kind: 'TimelineInspectionRejected'; readonly failure: HostedEvidenceFailure }
  | { readonly kind: 'TimelineBindingRejected' }
  | { readonly kind: 'TimelineCursorUnavailable' }
  | { readonly kind: 'GrantExpired' }
  | { readonly kind: 'WatchInterrupted' }
  | { readonly kind: 'WatchClockUnavailable' };

export type TaskRunStatusObservation =
  { readonly kind: 'Observed'; readonly status: TaskRunStatus } | TaskRunObservationFailure;

export type TaskRunWatchObservation =
  | {
      readonly kind: 'Observed';
      readonly status: TaskRunStatus;
      readonly events: EvidenceTimelinePage['events'];
    }
  | TaskRunObservationFailure;

interface OpenTaskRunObservation {
  readonly task: TaskProjection;
  readonly admission: AcceptedRunAdmission;
  readonly runs: HostedRunStatuses;
  readonly timelines: HostedRunTimelines;
  readonly grantExpiresAt: number;
}

type TaskRunObservationOpening =
  | { readonly kind: 'Opened'; readonly observation: OpenTaskRunObservation }
  | TaskRunObservationFailure;

type CurrentTaskRunReading =
  | {
      readonly kind: 'Read';
      readonly status: TaskRunStatus;
      readonly page: EvidenceTimelinePage;
    }
  | TaskRunObservationFailure;

const timelinePageLimit = 25;
const watchIntervalMilliseconds = 1_000;

function watchWasInterrupted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function repositoryMatches(
  left: TaskProjection['revision']['repository'],
  right: TaskProjection['revision']['repository'],
): boolean {
  return (
    left.objectFormat === right.objectFormat &&
    left.commit === right.commit &&
    left.tree === right.tree
  );
}

function admissionMatchesTask(admission: AcceptedRunAdmission, task: TaskProjection): boolean {
  const binding = admission.binding;
  const run = admission.run;
  return (
    binding.ownerAid === task.ownerAid &&
    binding.taskId === task.taskId &&
    binding.taskRevisionSaid === task.revisionSaid &&
    binding.harnessLineageId === task.harnessLineageId &&
    repositoryMatches(binding.repository, task.revision.repository) &&
    run.ownerAid === task.ownerAid &&
    run.taskId === task.taskId &&
    run.taskRevisionSaid === task.revisionSaid &&
    run.harnessLineageId === task.harnessLineageId &&
    repositoryMatches(run.repository, task.revision.repository)
  );
}

function runMatchesAdmission(run: RunProjection, admission: AcceptedRunAdmission): boolean {
  const accepted = admission.run;
  return (
    run.runId === accepted.runId &&
    run.ownerAid === accepted.ownerAid &&
    run.commandId === admission.commandId &&
    run.taskId === accepted.taskId &&
    run.taskRevisionSaid === accepted.taskRevisionSaid &&
    run.harnessLineageId === accepted.harnessLineageId &&
    run.harnessRevisionSaid === accepted.harnessRevisionSaid &&
    run.personalAgentAid === accepted.personalAgentAid &&
    run.taskMandateSaid === accepted.taskMandateSaid &&
    run.governorAid === accepted.governorAid &&
    run.promotionMandateSaid === accepted.promotionMandateSaid &&
    run.admissionExchangeSaid === admission.exchangeSaid &&
    run.evidenceStreamId === accepted.evidenceStreamId &&
    repositoryMatches(run.repository, accepted.repository) &&
    run.lease.kind === 'Held' &&
    run.lease.incarnationId === admission.incarnationId
  );
}

function streamMatchesRun(stream: EvidenceStreamProjection, run: RunProjection): boolean {
  return stream.runId === run.runId && stream.evidenceStreamId === run.evidenceStreamId;
}

function runObservationStopsWatch(run: RunProjection): boolean {
  return run.lifecycle.kind === 'Ended' || run.lifecycle.phase.kind === 'Blocked';
}

function validGrantExpiry(expiresAt: string): number | undefined {
  const parsed = Date.parse(expiresAt);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export class TaskRunObservations {
  readonly #dependencies: TaskRunObservationDependencies;

  constructor(dependencies: TaskRunObservationDependencies) {
    this.#dependencies = dependencies;
  }

  async status(label: string): Promise<TaskRunStatusObservation> {
    const opened = await this.#open(label);
    if (opened.kind !== 'Opened') return opened;
    const reading = await this.#read(opened.observation, {});
    return reading.kind === 'Read' ? { kind: 'Observed', status: reading.status } : reading;
  }

  async *watch(label: string, signal: AbortSignal): AsyncGenerator<TaskRunWatchObservation, void> {
    if (watchWasInterrupted(signal)) {
      yield { kind: 'WatchInterrupted' };
      return;
    }
    const opened = await this.#open(label);
    if (opened.kind !== 'Opened') {
      yield opened;
      return;
    }
    let cursor: string | undefined;
    let lastSequence: number | undefined;
    for (;;) {
      if (watchWasInterrupted(signal)) {
        yield { kind: 'WatchInterrupted' };
        return;
      }
      if (this.#dependencies.now() >= opened.observation.grantExpiresAt) {
        yield { kind: 'GrantExpired' };
        return;
      }
      const reading = await this.#read(
        opened.observation,
        cursor === undefined ? { limit: timelinePageLimit } : { limit: timelinePageLimit, cursor },
      );
      if (reading.kind !== 'Read') {
        yield reading;
        return;
      }
      const firstSequence = reading.page.events[0]?.event.sequence;
      if (
        firstSequence !== undefined &&
        firstSequence !== (lastSequence === undefined ? 0 : lastSequence + 1)
      ) {
        yield { kind: 'TimelineBindingRejected' };
        return;
      }
      yield {
        kind: 'Observed',
        status: reading.status,
        events: reading.page.events,
      };
      lastSequence = reading.page.events.at(-1)?.event.sequence ?? lastSequence;
      const accepted = reading.status.stream.cursor;
      const caughtUp =
        accepted.kind === 'Empty' || lastSequence === accepted.acceptedThroughSequence;
      if (runObservationStopsWatch(reading.status.run) && caughtUp) return;
      if (
        reading.page.nextCursor === null &&
        (reading.page.events.length !== 0 || reading.page.stream.cursor.kind !== 'Empty')
      ) {
        yield { kind: 'TimelineCursorUnavailable' };
        return;
      }
      cursor = reading.page.nextCursor ?? undefined;
      const waiting = await this.#dependencies.wait(watchIntervalMilliseconds, signal);
      if (waiting.kind === 'Interrupted') {
        yield { kind: 'WatchInterrupted' };
        return;
      }
      if (waiting.kind === 'Unavailable') {
        yield { kind: 'WatchClockUnavailable' };
        return;
      }
    }
  }

  async #open(label: string): Promise<TaskRunObservationOpening> {
    const authority = await this.#dependencies.authority.acquireHostedWork();
    if (authority.kind !== 'Authorized') return authority;
    const inspected = await authority.tasks.inspect(label);
    if (inspected.kind !== 'Inspected') {
      return { kind: 'TaskInspectionRejected', failure: inspected };
    }
    const located = await this.#dependencies.admissions.locateAcceptedRun(inspected.task.taskId);
    if (located.kind !== 'Located') {
      return { kind: 'AcceptedRunUnavailable', disposition: located.kind };
    }
    if (!admissionMatchesTask(located.admission, inspected.task)) {
      return { kind: 'RunBindingRejected' };
    }
    const grantExpiresAt = validGrantExpiry(authority.grantExpiresAt);
    if (grantExpiresAt === undefined) {
      return { kind: 'GrantExpired' };
    }
    return {
      kind: 'Opened',
      observation: {
        task: inspected.task,
        admission: located.admission,
        runs: authority.runs,
        timelines: authority.evidence,
        grantExpiresAt,
      },
    };
  }

  async #read(
    opened: OpenTaskRunObservation,
    query: EvidenceTimelineQuery,
  ): Promise<CurrentTaskRunReading> {
    const inspected = await opened.runs.inspect(opened.admission.run.runId);
    if (inspected.kind !== 'Found') {
      return { kind: 'RunInspectionRejected', failure: inspected };
    }
    if (!runMatchesAdmission(inspected.run, opened.admission)) {
      return { kind: 'RunBindingRejected' };
    }
    const timeline = await opened.timelines.inspect(inspected.run.runId, query);
    if (timeline.kind !== 'Found') {
      return { kind: 'TimelineInspectionRejected', failure: timeline };
    }
    if (
      timeline.page.events.length > (query.limit ?? timelinePageLimit) ||
      !streamMatchesRun(timeline.page.stream, inspected.run)
    ) {
      return { kind: 'TimelineBindingRejected' };
    }
    return {
      kind: 'Read',
      status: { task: opened.task, run: inspected.run, stream: timeline.page.stream },
      page: timeline.page,
    };
  }
}
