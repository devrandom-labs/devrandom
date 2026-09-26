import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Run } from '@devrandom/domain';
import {
  decodeRunProjection,
  type EvidenceEvent,
  type EvidenceStreamProjection,
} from '@devrandom/protocol';
import type { LocalTaskMandatePreparation } from '../../task/application/task-run-preparation.js';
import type { LocalTaskResumptionInput } from './local-task-resumption.js';
import { RunContinuationFile } from '../infrastructure/run-continuation-file.js';
import { SqliteEvidenceOutboxes } from '../infrastructure/sqlite-evidence-outbox.js';
import { GitWorktreeChanges } from '../infrastructure/git-worktree-changes.js';
import { SealedEvidenceSettlement } from '../application/sealed-evidence-settlement.js';
import { reconcileInterruptedCalibration } from '../application/interrupted-calibration-reconciliation.js';

/** Exact historical source and signer custody for bookkeeping; execution is a separate admission. */
export async function reconcileLocalInterruptedCalibration(
  input: LocalTaskResumptionInput,
  run: Run,
  mandates: Extract<LocalTaskMandatePreparation, { kind: 'Prepared' }>,
): Promise<'Reconciled' | 'NotRequired' | 'Rejected'> {
  if (
    run.currentExecution === undefined ||
    run.lifecycle.kind !== 'Active' ||
    run.lifecycle.phase.kind !== 'Preparing' ||
    run.lease.kind !== 'Held'
  )
    return 'NotRequired';
  const now = () => new Date().toISOString();
  if (Date.parse(run.lease.expiresAt) > Date.now()) return 'Rejected';
  const root = join(input.stateRoot, 'runs', input.runId);
  try {
    await lstat(join(root, 'incarnations', run.lease.incarnationId, 'outbox.sqlite'));
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
      ? 'NotRequired'
      : 'Rejected';
  }
  const segment = await input.hosted.runs.readSuccessorSegment(
    input.runId,
    run.currentExecution.segmentSaid,
  );
  if (segment.kind !== 'Found') return 'Rejected';
  const retained = await new RunContinuationFile(
    join(input.stateRoot, 'continuations'),
    randomUUID,
  ).readPredecessor(input.runId, segment.segment.fromRunVersion);
  if (retained === undefined) return 'Rejected';
  const predecessorRun = decodeRunProjection(retained.run);
  if (predecessorRun.kind !== 'Accepted') return 'Rejected';
  const outboxes = new SqliteEvidenceOutboxes(now, input.hosted.protectedCredentials);
  const predecessor = outboxes.readPredecessor({
    run: predecessorRun.run,
    stateRoot: input.stateRoot,
    stream: retained.stream,
    events: retained.events,
  });
  if (
    predecessor.kind !== 'Read' ||
    predecessor.custody.checkpoint.d !== segment.segment.predecessor.checkpointSaid
  )
    return 'Rejected';
  const profile = predecessor.custody.events.find(
    (e) => e.event.kind === 'RunExecutionProfileBound',
  );
  if (
    profile?.event.kind !== 'RunExecutionProfileBound' ||
    profile.event.executionProfileSaid !== input.linux.profile.d
  )
    return 'Rejected';
  const historical = await input.hosted.evidence.inspect(input.runId, {
    evidenceStreamId: segment.segment.predecessor.evidenceStreamId,
    limit: 100,
  });
  if (historical.kind !== 'Found' || !isDeepStrictEqual(historical.page.stream, retained.stream))
    return 'Rejected';
  const events: EvidenceEvent[] = [];
  let cursor: string | undefined;
  let stream: EvidenceStreamProjection | undefined;
  for (let pageNumber = 0; pageNumber < 1000; pageNumber++) {
    input.signal.throwIfAborted();
    const page = await input.hosted.evidence.inspect(input.runId, {
      evidenceStreamId: run.currentExecution.evidenceStreamId,
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (
      page.kind !== 'Found' ||
      (stream !== undefined && !isDeepStrictEqual(stream, page.page.stream))
    )
      return 'Rejected';
    stream = page.page.stream;
    events.push(...page.page.events.map((e) => e.event));
    if (
      stream.cursor.kind === 'Accepted' &&
      events.at(-1)?.sequence === stream.cursor.acceptedThroughSequence
    )
      break;
    if (page.page.events.length === 0 || page.page.nextCursor === null) return 'Rejected';
    cursor = page.page.nextCursor;
  }
  if (
    stream?.seal.kind !== 'Unsealed' ||
    stream.cursor.kind !== 'Accepted' ||
    stream.cursor.eventCount !== events.length
  )
    return 'Rejected';
  const directory = join(root, 'worktree');
  const metadata = await lstat(directory);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (await realpath(directory)) !== directory
  )
    return 'Rejected';
  const reconciled = await reconcileInterruptedCalibration(
    {
      run,
      executionProfileSaid: input.linux.profile.d,
      segment: segment.segment,
      task: input.task,
      hostedPrefix: events,
      predecessor: predecessor.custody.checkpoint,
      stateRoot: input.stateRoot,
      worktree: {
        directory,
        branch: `devrandom/run/${input.runId}`,
        repository: run.binding.repository,
      },
      signal: input.signal,
    },
    {
      outboxes,
      repository: new GitWorktreeChanges(input.hosted.protectedCredentials),
      hosted: input.hosted.evidence,
      sealing: (hosted) =>
        new SealedEvidenceSettlement({
          hostedEvidence: hosted,
          hostedSeals: input.hosted.evidence,
          exchange: mandates.executionAuthority.evidenceSealExchange,
          sourceAid: mandates.executionAuthority.personalAgentAid,
          recipientAid: input.issuerAid,
          wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          maximumObservations: 30,
        }),
      now,
    },
  );
  return reconciled.kind === 'Reconciled' ? 'Reconciled' : 'Rejected';
}
