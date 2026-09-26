import type { Run } from '@devrandom/domain';
import {
  decodeAppendEvidenceBatchCommand,
  evidenceBatchCommandFingerprint,
  type AppendEvidenceBatchBody,
  type EvidenceBatchParameters,
  type EvidenceEvent,
  type EvidenceEventDetail,
} from '@devrandom/protocol';

import type {
  CurrentTaskMandateAuthorization,
  CurrentTaskMandateInput,
} from '../../mandate/application/current-task-mandate.js';
import type { EvidenceBatchCommitment, EvidenceBatches } from './evidence-batches.js';
import type { EvidenceRunContexts } from './evidence-run-contexts.js';
import { bodyCheckpointBelongsToRun, evidenceEventBelongsToRun } from '../domain/run-binding.js';

export interface EvidenceBatchCommandInput {
  readonly ownerAid: string;
  readonly parameters: EvidenceBatchParameters;
  readonly body: AppendEvidenceBatchBody;
  readonly receivedAt: string;
}

export interface RecordedTaskMandateAuthority {
  authorize(input: CurrentTaskMandateInput): Promise<CurrentTaskMandateAuthorization>;
}

export interface AcceptEvidenceBatchDependencies {
  readonly contexts: EvidenceRunContexts;
  readonly authority: RecordedTaskMandateAuthority;
  readonly batches: EvidenceBatches;
}

export type AcceptEvidenceBatchOutcome =
  | EvidenceBatchCommitment
  | { readonly kind: 'EvidenceRequestInvalid' }
  | {
      readonly kind: 'EvidenceBatchRejected';
      readonly reason:
        | 'BatchSaidMismatch'
        | 'RunBindingMismatch'
        | 'EventBindingMismatch'
        | 'CheckpointInvalid'
        | 'CheckpointBindingMismatch';
    }
  | { readonly kind: 'DependencyUnavailable'; readonly dependency: 'Keria' | 'Witness' };

function effectRequiresAuthority(event: EvidenceEventDetail): boolean {
  switch (event.kind) {
    case 'MandateVerified':
    case 'ModelRequest':
    case 'ToolAuthorized':
    case 'EffectCompleted':
    case 'EffectFailed':
      return true;
    case 'RunStarted':
    case 'IncarnationStarted':
    case 'ModelMessageCompleted':
    case 'ToolProposed':
    case 'ToolRejected':
    case 'ApprovalRequired':
    case 'Observation':
    case 'BudgetDebited':
    case 'FailureObserved':
    case 'ContextSummary':
    case 'CheckpointVerified':
    case 'CheckpointAccepted':
    case 'RunCalibrationRecorded':
    case 'RunBlocked':
    case 'ResultSubmitted':
    case 'TaskVerificationAccepted':
    case 'TaskVerificationRejected':
    case 'DataWithheld':
    case 'SecurityViolation':
      return false;
  }
}

function authorityInput(ownerAid: string, run: Run, recordedAt: string): CurrentTaskMandateInput {
  return {
    ownerAid,
    taskId: run.binding.taskId,
    taskRevisionSaid: run.binding.taskRevisionSaid,
    harnessLineageId: run.binding.harnessLineageId,
    personalAgentAid: run.binding.personalAgentAid,
    taskMandateSaid: run.binding.taskMandateSaid,
    observedAt: recordedAt,
  };
}

async function authorityFailure(
  ownerAid: string,
  run: Run,
  events: readonly EvidenceEvent[],
  authority: RecordedTaskMandateAuthority,
): Promise<AcceptEvidenceBatchOutcome | undefined> {
  for (const event of events) {
    if (!effectRequiresAuthority(event.event)) {
      continue;
    }
    const authorization = await authority.authorize(
      authorityInput(ownerAid, run, event.recordedAt),
    );
    if (authorization.kind === 'CurrentTaskMandateAuthorized') {
      continue;
    }
    if (authorization.kind === 'DependencyUnavailable') {
      return authorization;
    }
    return { kind: 'EvidenceBatchRejected', reason: 'EventBindingMismatch' };
  }
  return undefined;
}

export async function acceptEvidenceBatch(
  input: EvidenceBatchCommandInput,
  dependencies: AcceptEvidenceBatchDependencies,
): Promise<AcceptEvidenceBatchOutcome> {
  const context = await dependencies.contexts.inspect({
    ownerAid: input.ownerAid,
    runId: input.parameters.runId,
  });
  if (context.kind !== 'EvidenceRunContextFound') {
    return context;
  }
  const decoded = decodeAppendEvidenceBatchCommand(
    input.parameters,
    input.body,
    context.completionConditionIds,
  );
  if (decoded.kind === 'Rejected') {
    switch (decoded.reason) {
      case 'SchemaInvalid':
        return { kind: 'EvidenceRequestInvalid' };
      case 'CheckpointInvalid':
        return { kind: 'EvidenceBatchRejected', reason: 'CheckpointInvalid' };
      case 'CheckpointRunMismatch':
      case 'CheckpointEvidenceMismatch':
        return { kind: 'EvidenceBatchRejected', reason: 'CheckpointBindingMismatch' };
      case 'BatchRunMismatch':
        return { kind: 'EvidenceBatchRejected', reason: 'RunBindingMismatch' };
      case 'BatchInvalid':
      case 'BatchPathMismatch':
        return { kind: 'EvidenceBatchRejected', reason: 'BatchSaidMismatch' };
    }
  }
  const command = decoded.command;
  const run = context.run;
  if (
    command.body.batch.evidenceStreamId !== run.binding.evidenceStreamId ||
    command.body.events.some((event) => !evidenceEventBelongsToRun(event, run))
  ) {
    return { kind: 'EvidenceBatchRejected', reason: 'EventBindingMismatch' };
  }
  if (!bodyCheckpointBelongsToRun(command.body, run)) {
    return { kind: 'EvidenceBatchRejected', reason: 'CheckpointBindingMismatch' };
  }
  const rejectedAuthority = await authorityFailure(
    input.ownerAid,
    run,
    command.body.events,
    dependencies.authority,
  );
  if (rejectedAuthority !== undefined) {
    return rejectedAuthority;
  }
  return dependencies.batches.accept({
    ownerAid: input.ownerAid,
    expectedRunVersion: run.version,
    commandFingerprint: evidenceBatchCommandFingerprint(command.body),
    body: command.body,
    receivedAt: input.receivedAt,
  });
}
