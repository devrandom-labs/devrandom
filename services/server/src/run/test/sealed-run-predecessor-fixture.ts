import {
  acquireFirstRunLease,
  createEvidenceStream,
  taskBudgetNames,
  type Run,
} from '@devrandom/domain';
import {
  prepareEvidenceEvent,
  prepareVerifiedCheckpoint,
  preparePublicVerifierReceipt,
  type EvidenceEvent,
  type EvidenceEventDetail,
} from '@devrandom/protocol';
import { runFixture } from './run-fixture.js';
const incarnationId = 'ee87e11d-fb5f-46b4-841f-8a7a5faad97c';
export function sealedRunPredecessorFixture(
  extraBeforeCheckpoint: readonly EvidenceEventDetail[] = [],
  reason:
    | 'CheckpointPause'
    | 'HarnessCompatibilityFailure'
    | 'ContextLimitReached'
    | 'ProcessLost' = 'CheckpointPause',
  options?: {
    readonly run: Run;
    readonly leaseAt: string;
    readonly at: string;
    readonly completionConditionIds?: readonly string[];
    readonly outputArtifactSaids?: readonly string[];
  },
) {
  const base = options?.run ?? runFixture();
  const at = options?.at ?? '2026-09-24T20:00:01.000Z';
  const initial =
    reason === 'ContextLimitReached' || reason === 'ProcessLost'
      ? {
          ...base,
          binding: {
            ...base.binding,
            initialSpecialization: {
              ...base.binding.initialSpecialization,
              runId: base.binding.runId,
              acceptedAt: base.binding.acceptedAt,
            },
            purpose: {
              kind: 'PreparedCompatibilityCalibration' as const,
              campaignId: '11111111-1111-4111-8111-111111111111',
              ordinal: 1 as const,
            },
          },
        }
      : base;
  const leased = acquireFirstRunLease(initial, {
    incarnationId,
    expectedRunVersion: initial.version,
    serverTime: options?.leaseAt ?? '2026-09-24T20:00:00.000Z',
  });
  if (leased.kind !== 'Acquired') throw new Error('lease fixture');
  const events: EvidenceEvent[] = [];
  function add(detail: EvidenceEventDetail) {
    const sequence = events.length;
    const prepared = prepareEvidenceEvent({
      version: 1,
      sequence,
      predecessor:
        sequence === 0
          ? { kind: 'Genesis' }
          : { kind: 'Previous', eventSaid: events[sequence - 1]?.d ?? '' },
      taskId: initial.binding.taskId,
      taskRevisionSaid: initial.binding.taskRevisionSaid,
      runId: initial.binding.runId,
      incarnationId,
      harnessRevisionSaid: initial.binding.initialHarnessRevisionSaid,
      personalAgentAid: initial.binding.personalAgentAid,
      taskMandateSaid: initial.binding.taskMandateSaid,
      occurredAt: at,
      recordedAt: at,
      producer: { kind: 'RunSupervisor' },
      event: detail,
    });
    if (prepared.kind !== 'Prepared') throw new Error('event fixture');
    events.push(prepared.event);
  }
  add({ kind: 'RunStarted', fromRunVersion: leased.run.version });
  add({ kind: 'IncarnationStarted' });
  for (const detail of extraBeforeCheckpoint) add(detail);
  const head = events.at(-1);
  if (head === undefined) throw new Error('head fixture');
  const remaining = { ...initial.binding.budget };
  for (const name of taskBudgetNames) remaining[name] -= leased.run.consumedBudget[name];
  const preparedCheckpoint = prepareVerifiedCheckpoint(
    {
      version: 1,
      taskId: initial.binding.taskId,
      taskRevisionSaid: initial.binding.taskRevisionSaid,
      runId: initial.binding.runId,
      incarnationId,
      harnessRevisionSaid: initial.binding.initialHarnessRevisionSaid,
      harnessLineageId: initial.binding.harnessLineageId,
      personalAgentAid: initial.binding.personalAgentAid,
      governorAid: initial.binding.governorAid,
      taskMandateSaid: initial.binding.taskMandateSaid,
      promotionMandateSaid: initial.binding.promotionMandateSaid,
      purpose: initial.binding.purpose,
      repository: {
        objectFormat: 'sha1',
        baseCommit: initial.binding.repository.commit,
        baseTree: initial.binding.repository.tree,
        changedFiles: [],
      },
      outputArtifactSaids: [...(options?.outputArtifactSaids ?? [])],
      verifierReceipts: (options?.completionConditionIds ?? []).map((completionConditionId) => {
        const receipt = preparePublicVerifierReceipt({
          version: 1,
          completionConditionId,
          commandSaid: `E${'v'.repeat(43)}`,
          recordedAt: at,
          outcome: { kind: 'Unresolved', reason: 'RunBlocked' },
        });
        if (receipt.kind !== 'Prepared') throw new Error('verifier fixture');
        return receipt.receipt;
      }),
      evidence: {
        eventCount: events.length,
        finalSequence: head.sequence,
        chainHeadSaid: head.d,
      },
      budget: { consumed: leased.run.consumedBudget, remaining },
      runState: {
        kind: 'Active',
        phase: { kind: 'Blocked', reason },
        verification: { kind: 'NotSubmitted' },
      },
      continuation:
        reason === 'ContextLimitReached'
          ? { kind: 'ExternalResolutionRequired', reason: 'ContextLimitReached' }
          : {
              kind:
                reason === 'HarnessCompatibilityFailure'
                  ? 'LaterHarnessCompatibilityResolutionRequired'
                  : 'LaterRuntimeRecoveryRequired',
            },
    },
    options?.completionConditionIds ?? [],
  );
  if (preparedCheckpoint.kind !== 'Prepared') throw new Error('checkpoint fixture');
  const checkpoint = preparedCheckpoint.checkpoint;
  add({ kind: 'RunBlocked', reason, checkpointSaid: checkpoint.d });
  const last = events.at(-1);
  if (last === undefined) throw new Error('last fixture');
  const run = {
    ...leased.run,
    lifecycle: {
      kind: 'Active' as const,
      phase: {
        kind: 'Blocked' as const,
        reason,
        checkpointSaid: checkpoint.d,
      },
    },
  };
  const createdStream = createEvidenceStream({
    streamId: initial.binding.evidenceStreamId,
    runId: initial.binding.runId,
    ownerAid: initial.binding.ownerAid,
    taskId: initial.binding.taskId,
    taskRevisionSaid: initial.binding.taskRevisionSaid,
    incarnationId,
    harnessRevisionSaid: initial.binding.initialHarnessRevisionSaid,
    personalAgentAid: initial.binding.personalAgentAid,
    taskMandateSaid: initial.binding.taskMandateSaid,
    combinedByteCeiling: initial.binding.budget.evidencePlusArtifactsPerRunBytes,
  });
  if (createdStream.kind !== 'Created') throw new Error('stream fixture');
  const stream = {
    ...createdStream.stream,
    version: 2,
    acceptedEvidenceBytes: Buffer.byteLength(JSON.stringify(events), 'utf8'),
    cursor: { kind: 'Continued' as const, acceptedThrough: last.sequence, chainHeadSaid: last.d },
    provisional: {
      kind: 'Checkpointed' as const,
      checkpointSaid: checkpoint.d,
      lifecycle: run.lifecycle,
      submissionVerification: run.submissionVerification,
    },
    seal: { kind: 'Sealed' as const, exchangeSaid: `E${'s'.repeat(43)}`, sealedAt: at },
  };
  return {
    run,
    stream,
    checkpoint,
    events,
    sealExchangeSaid: stream.seal.exchangeSaid,
    chainHeadSaid: last.d,
    completionConditionIds: [],
  };
}
