import { readCalibrationContinuationHistory } from '../../run/application/calibration-continuation-history.js';
import { isDeepStrictEqual } from 'node:util';

import {
  assessFailureQualification,
  type RetainedFailureObservation,
  type SealedRunObservation,
} from '@devrandom/domain';
import {
  decodeEvaluationExecutionProfile,
  decodeEvidenceArtifact,
  decodeEvidenceEvent,
  decodePublicVerifierReceipt,
  decodeRunProjection,
  evidenceArtifactReferences,
  type EvidenceStreamProjection,
} from '@devrandom/protocol';

import type { RunQualification } from './harness-evaluation.js';

export interface CalibrationCampaignHistory {
  read(input: {
    readonly taskId: string;
    readonly harnessRevisionSaid: string;
  }): Promise<
    | { readonly kind: 'Found'; readonly runIds: readonly string[] }
    | { readonly kind: 'Missing' | 'Unavailable' }
  >;
}

function sameStream(left: EvidenceStreamProjection, right: EvidenceStreamProjection): boolean {
  return (
    left.runId === right.runId &&
    left.evidenceStreamId === right.evidenceStreamId &&
    isDeepStrictEqual(left.cursor, right.cursor) &&
    isDeepStrictEqual(left.checkpoint, right.checkpoint) &&
    isDeepStrictEqual(left.seal, right.seal)
  );
}

function interrupted(signal: AbortSignal): boolean {
  return signal.aborted;
}

/** Reads six authoritative Run/timeline histories and their exact profile/receipt custody. */
export class VerifiedFailureCampaign implements RunQualification {
  readonly #history: CalibrationCampaignHistory;

  constructor(history: CalibrationCampaignHistory) {
    this.#history = history;
  }

  async inspect(
    input: Parameters<RunQualification['inspect']>[0],
  ): ReturnType<RunQualification['inspect']> {
    if (interrupted(input.signal)) return { kind: 'Unavailable' };
    const history = await this.#history.read({
      taskId: input.task.taskId,
      harnessRevisionSaid: input.expectedActiveRevisionSaid,
    });
    if (history.kind !== 'Found') {
      return { kind: history.kind === 'Missing' ? 'Blocked' : 'Unavailable' };
    }
    if (history.runIds.length !== 5 || new Set([...history.runIds, input.originRunId]).size !== 6)
      return { kind: 'Blocked' };
    let campaignId: string | undefined;
    const incarnationIds = new Set<string>();
    const calibrations: SealedRunObservation[] = [];
    let retained: SealedRunObservation | undefined;
    let retainedFailureReference:
      { readonly eventSaid: string; readonly receiptSaid: string } | undefined;
    for (const [index, runId] of [...history.runIds, input.originRunId].entries()) {
      if (interrupted(input.signal)) return { kind: 'Unavailable' };
      const inspected = await input.runs.inspect(runId);
      if (inspected.kind !== 'Found') return { kind: 'Blocked' };
      const decoded = decodeRunProjection(inspected.run);
      if (decoded.kind !== 'Accepted') return { kind: 'Blocked' };
      const run = decoded.run;
      const purpose = run.binding.purpose;
      if (
        run.binding.runId !== runId ||
        run.binding.taskId !== input.task.taskId ||
        run.binding.taskRevisionSaid !== input.task.revisionSaid ||
        run.binding.ownerAid !== input.task.ownerAid ||
        run.binding.harnessLineageId !== input.task.harnessLineageId ||
        run.binding.initialHarnessRevisionSaid !== input.expectedActiveRevisionSaid ||
        !isDeepStrictEqual(run.binding.repository, input.task.revision.repository) ||
        (index < 5 &&
          (purpose.kind !== 'PreparedCompatibilityCalibration' || purpose.ordinal !== index + 1)) ||
        (index === 5 && purpose.kind !== 'Retained')
      )
        return { kind: 'Blocked' };
      if (purpose.kind === 'PreparedCompatibilityCalibration') {
        if (campaignId !== undefined && purpose.campaignId !== campaignId)
          return { kind: 'Blocked' };
        campaignId = purpose.campaignId;
      }
      if (
        (index < 5 && run.lifecycle.kind !== 'Ended') ||
        (index === 5 &&
          (run.lifecycle.kind !== 'Active' ||
            run.lifecycle.phase.kind !== 'Blocked' ||
            run.lifecycle.phase.reason !== 'HarnessCompatibilityFailure'))
      )
        return { kind: 'Blocked' };
      const history = await readCalibrationContinuationHistory(
        inspected.run,
        input.runs,
        input.evidence,
      );
      if (history.kind !== 'Verified') return { kind: 'Blocked' };
      if (history.predecessorIncarnationId !== undefined) {
        if (incarnationIds.has(history.predecessorIncarnationId)) return { kind: 'Blocked' };
        incarnationIds.add(history.predecessorIncarnationId);
      }
      const scope =
        history.predecessorEvents.length === 0
          ? {}
          : { evidenceStreamId: history.evidenceStreamId };
      const first = await input.evidence.inspect(runId, { limit: 100, ...scope });
      if (first.kind !== 'Found') return { kind: 'Blocked' };
      const stream = first.page.stream;
      if (
        stream.runId !== runId ||
        stream.evidenceStreamId !== history.evidenceStreamId ||
        stream.seal.kind !== 'Sealed' ||
        stream.checkpoint.kind !== 'Accepted' ||
        stream.cursor.kind !== 'Accepted'
      )
        return { kind: 'Blocked' };
      const checkpointSaid =
        run.lifecycle.kind === 'Ended'
          ? run.lifecycle.outcome.checkpointSaid
          : run.lifecycle.phase.kind === 'Blocked'
            ? run.lifecycle.phase.checkpointSaid
            : undefined;
      if (checkpointSaid !== stream.checkpoint.checkpointSaid) return { kind: 'Blocked' };
      let page = first.page;
      let sequence = 0;
      let head: string | undefined;
      let artifactCount = 0;
      const artifactSaids: string[] = [];
      let checkpointAccepted = false;
      let profileBound = false;
      let profileArtifactSaid: string | undefined;
      let worktreeBranch: string | undefined;
      let workerBegan = false;
      let incarnationId: string | undefined;
      let pages = 0;
      const cursors = new Set<string>();
      for (;;) {
        pages += 1;
        if (pages > 64 || !sameStream(stream, page.stream)) return { kind: 'Blocked' };
        if (page.events.length === 0 && page.nextCursor !== null) return { kind: 'Blocked' };
        for (const received of page.events) {
          const event = received.event;
          if (
            decodeEvidenceEvent(event).kind !== 'Accepted' ||
            event.sequence !== sequence ||
            event.runId !== runId ||
            event.taskId !== input.task.taskId ||
            event.taskRevisionSaid !== input.task.revisionSaid ||
            event.harnessRevisionSaid !== run.binding.initialHarnessRevisionSaid ||
            event.personalAgentAid !== run.binding.personalAgentAid ||
            event.taskMandateSaid !== run.binding.taskMandateSaid ||
            (incarnationId !== undefined && event.incarnationId !== incarnationId) ||
            (head === undefined
              ? event.predecessor.kind !== 'Genesis'
              : event.predecessor.kind !== 'Previous' || event.predecessor.eventSaid !== head)
          )
            return { kind: 'Blocked' };
          sequence += 1;
          head = event.d;
          incarnationId = event.incarnationId;
          const references = evidenceArtifactReferences(event.event);
          artifactCount += references.length;
          artifactSaids.push(...references);
          if (event.event.kind === 'RunExecutionProfileBound') {
            if (
              profileBound ||
              workerBegan ||
              event.event.executionProfileSaid !== input.executionProfileSaid ||
              event.event.worktreeBranch !== `devrandom/run/${runId}`
            )
              return { kind: 'Blocked' };
            profileBound = true;
            profileArtifactSaid = event.event.profileArtifactSaid;
            worktreeBranch = event.event.worktreeBranch;
          }
          if (
            event.event.kind === 'ModelRequest' ||
            event.event.kind === 'ModelMessageCompleted' ||
            event.event.kind === 'ToolProposed' ||
            event.event.kind === 'ToolAuthorized' ||
            event.event.kind === 'EffectCompleted' ||
            event.event.kind === 'EffectFailed'
          ) {
            if (!profileBound) return { kind: 'Blocked' };
            workerBegan = true;
          }
          if (
            event.event.kind === 'CheckpointAccepted' &&
            event.event.checkpointSaid === checkpointSaid
          )
            checkpointAccepted = true;
          if (
            index === 5 &&
            event.event.kind === 'FailureObserved' &&
            event.event.failure === 'HarnessCompatibilityFailure'
          ) {
            if (retainedFailureReference !== undefined) return { kind: 'Blocked' };
            retainedFailureReference = { eventSaid: event.d, receiptSaid: event.event.receiptSaid };
          }
        }
        if (page.nextCursor === null) break;
        if (cursors.has(page.nextCursor)) return { kind: 'Blocked' };
        cursors.add(page.nextCursor);
        const continuation = await input.evidence.inspect(runId, {
          limit: 100,
          cursor: page.nextCursor,
          ...scope,
        });
        if (continuation.kind !== 'Found') return { kind: 'Blocked' };
        page = continuation.page;
      }
      if (
        sequence !== stream.cursor.eventCount ||
        sequence !== stream.seal.eventCount ||
        head !== stream.cursor.chainHeadSaid ||
        head !== stream.seal.chainHeadSaid ||
        artifactCount === 0 ||
        !profileBound ||
        !checkpointAccepted ||
        profileArtifactSaid === undefined ||
        worktreeBranch === undefined ||
        (index === 5 && retainedFailureReference === undefined)
      )
        return { kind: 'Blocked' };
      if (
        incarnationId === undefined ||
        incarnationIds.has(incarnationId) ||
        (run.lease.kind === 'Held' && run.lease.incarnationId !== incarnationId)
      )
        return { kind: 'Blocked' };
      incarnationIds.add(incarnationId);
      let predecessorProfile: string | undefined;
      let predecessorWorkerBegan = false;
      for (const event of history.predecessorEvents) {
        artifactSaids.push(...evidenceArtifactReferences(event.event));
        if (event.event.kind === 'RunExecutionProfileBound') {
          if (
            predecessorProfile !== undefined ||
            predecessorWorkerBegan ||
            event.event.executionProfileSaid !== input.executionProfileSaid ||
            event.event.worktreeBranch !== worktreeBranch
          )
            return { kind: 'Blocked' };
          predecessorProfile = event.event.profileArtifactSaid;
        }
        if (
          [
            'ModelRequest',
            'ModelMessageCompleted',
            'ToolProposed',
            'ToolAuthorized',
            'EffectCompleted',
            'EffectFailed',
          ].includes(event.event.kind)
        ) {
          if (predecessorProfile === undefined) return { kind: 'Blocked' };
          predecessorWorkerBegan = true;
        }
      }
      if (history.predecessorEvents.length > 0 && predecessorProfile !== profileArtifactSaid)
        return { kind: 'Blocked' };
      if (input.evidence.readArtifact === undefined) return { kind: 'Blocked' };
      const profileReading = await input.evidence.readArtifact(
        runId,
        profileArtifactSaid,
        input.signal,
      );
      if (
        profileReading.kind !== 'Read' ||
        profileReading.artifact.d !== profileArtifactSaid ||
        profileReading.artifact.mediaType !== 'application/json' ||
        decodeEvidenceArtifact(profileReading.artifact, profileReading.bytes).kind !== 'Accepted'
      )
        return { kind: 'Blocked' };
      let encodedProfile: unknown;
      try {
        encodedProfile = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(profileReading.bytes),
        );
      } catch {
        return { kind: 'Blocked' };
      }
      const decodedProfile = decodeEvaluationExecutionProfile(encodedProfile);
      if (
        decodedProfile.kind !== 'Accepted' ||
        decodedProfile.profile.d !== input.executionProfileSaid ||
        decodedProfile.profile.sourceGitCommit !== input.task.revision.repository.commit ||
        decodedProfile.profile.sourceGitTree !== input.task.revision.repository.tree
      )
        return { kind: 'Blocked' };
      const observation: SealedRunObservation = {
        run,
        incarnationId,
        worktreeId: worktreeBranch,
        executionProfileSaid: decodedProfile.profile.d,
        seal: {
          kind: 'Acknowledged',
          runId,
          checkpointSaid,
          evidenceHeadSaid: head,
          sealSaid: stream.seal.sealExchangeSaid,
          artifactSaids,
        },
      };
      if (index < 5) calibrations.push(observation);
      else retained = observation;
    }
    if (
      retained === undefined ||
      retainedFailureReference === undefined ||
      input.evidence.readVerifierReceipt === undefined
    )
      return { kind: 'Blocked' };
    const confirmed = calibrations.find(
      (observation) =>
        observation.run.lifecycle.kind === 'Ended' &&
        observation.run.lifecycle.outcome.kind === 'CalibrationConfirmed',
    );
    if (
      confirmed === undefined ||
      confirmed.run.lifecycle.kind !== 'Ended' ||
      confirmed.run.lifecycle.outcome.kind !== 'CalibrationConfirmed' ||
      retained.run.lifecycle.kind !== 'Active' ||
      retained.run.lifecycle.phase.kind !== 'Blocked'
    )
      return { kind: 'Blocked' };
    const receiptReading = await input.evidence.readVerifierReceipt(
      input.originRunId,
      retainedFailureReference.receiptSaid,
      input.signal,
    );
    if (
      receiptReading.kind !== 'Read' ||
      receiptReading.checkpointSaid !== retained.run.lifecycle.phase.checkpointSaid ||
      receiptReading.receipt.d !== retainedFailureReference.receiptSaid ||
      decodePublicVerifierReceipt(receiptReading.receipt).kind !== 'Accepted' ||
      receiptReading.receipt.commandSaid !==
        confirmed.run.lifecycle.outcome.category.legacyCommandSaid ||
      receiptReading.receipt.outcome.kind !== 'Rejected' ||
      receiptReading.receipt.outcome.reason.kind !== 'UnexpectedExitCode' ||
      receiptReading.receipt.outcome.reason.expected !== 0 ||
      receiptReading.receipt.outcome.reason.observed !==
        confirmed.run.lifecycle.outcome.category.legacyObservedExitCode
    )
      return { kind: 'Blocked' };
    const retainedFailure: RetainedFailureObservation = {
      runId: input.originRunId,
      eventSaid: retainedFailureReference.eventSaid,
      category: confirmed.run.lifecycle.outcome.category,
    };
    const assessment = assessFailureQualification({
      task: {
        taskId: input.task.taskId,
        ownerAid: input.task.ownerAid,
        harnessLineageId: input.task.harnessLineageId,
        revision: { said: input.task.revisionSaid },
        lifecycle: input.task.lifecycle,
      },
      calibrations,
      retained,
      retainedFailure,
    });
    return assessment.kind === 'Qualified'
      ? {
          kind: 'Qualified',
          taskId: input.task.taskId,
          taskRevisionSaid: input.task.revisionSaid,
          originRunId: input.originRunId,
          retainedCheckpointSaid: retained.seal.checkpointSaid,
          retainedSealSaid: retained.seal.sealSaid,
          expectedActiveRevisionSaid: input.expectedActiveRevisionSaid,
          personalAgentAid: retained.run.binding.personalAgentAid,
          taskMandateSaid: retained.run.binding.taskMandateSaid,
          executionProfileSaid: input.executionProfileSaid,
        }
      : { kind: 'Blocked' };
  }
}
