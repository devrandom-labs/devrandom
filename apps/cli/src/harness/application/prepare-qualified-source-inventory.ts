import { isDeepStrictEqual } from 'node:util';

import {
  decodeEvidenceArtifact,
  decodeEvidenceEvent,
  decodePublicVerifierReceipt,
  decodeRunProjection,
  prepareEvaluationSourceInventory,
  type EvaluationSourceInventory,
  type EvidenceEvent,
  type EvidenceTimelinePage,
} from '@devrandom/protocol';

import type { RunQualification } from './harness-evaluation.js';
import type { CalibrationCampaignHistory } from './verified-failure-campaign.js';

type QualificationInput = Parameters<RunQualification['inspect']>[0];
type Qualified = Extract<Awaited<ReturnType<RunQualification['inspect']>>, { kind: 'Qualified' }>;

export interface CurrentExperienceMandate {
  inspect(input: {
    readonly taskId: string;
    readonly taskRevisionSaid: string;
    readonly ownerAid: string;
  }): Promise<
    | {
        readonly kind: 'Current';
        readonly mandateSaid: string;
        readonly ownerAid: string;
        readonly taskId: string;
        readonly taskRevisionSaid: string;
        readonly repositoryResourceSaid: string;
        readonly corpusSaid: string;
        readonly disclosure: string;
      }
    | { readonly kind: 'Denied' | 'Unavailable' }
  >;
}

export interface QualifiedInventorySource {
  readonly runId: string;
  readonly observationEventSaid: string;
  readonly rawEvidenceSaid: string;
  readonly failureEventSaid: string;
  readonly verifierReceiptSaid: string;
}

export type QualifiedSourceInventoryPreparation =
  | {
      readonly kind: 'Prepared';
      readonly qualified: Qualified;
      readonly inventory: EvaluationSourceInventory;
      readonly sources: readonly QualifiedInventorySource[];
    }
  | {
      readonly kind: 'Blocked';
      readonly gate:
        | 'Qualification'
        | 'Mandate'
        | 'History'
        | 'Timeline'
        | 'Receipt'
        | 'RawSource'
        | 'Inventory';
    };

type SourceReading =
  | {
      readonly kind: 'Found';
      readonly source: QualifiedInventorySource;
      readonly campaignId: string;
    }
  | { readonly kind: 'Excluded'; readonly campaignId: string }
  | { readonly kind: 'Blocked'; readonly gate: 'Timeline' | 'Receipt' | 'RawSource' };

function sameStream(
  first: EvidenceTimelinePage['stream'],
  next: EvidenceTimelinePage['stream'],
): boolean {
  return isDeepStrictEqual(first, next);
}

/** Rechecks the complete sealed calibration chain before exposing one public source. */
async function readCalibration(
  runId: string,
  ordinal: number,
  input: QualificationInput,
  qualified: Qualified,
): Promise<SourceReading> {
  const inspected = await input.runs.inspect(runId);
  if (inspected.kind !== 'Found') return { kind: 'Blocked', gate: 'Timeline' };
  const decoded = decodeRunProjection(inspected.run);
  if (decoded.kind !== 'Accepted') return { kind: 'Blocked', gate: 'Timeline' };
  const run = decoded.run;
  if (
    run.binding.runId !== runId ||
    run.binding.taskId !== qualified.taskId ||
    run.binding.taskRevisionSaid !== qualified.taskRevisionSaid ||
    run.binding.ownerAid !== input.task.ownerAid ||
    run.binding.harnessLineageId !== input.task.harnessLineageId ||
    run.binding.initialHarnessRevisionSaid !== qualified.expectedActiveRevisionSaid ||
    run.binding.personalAgentAid !== qualified.personalAgentAid ||
    run.binding.taskMandateSaid !== qualified.taskMandateSaid ||
    !isDeepStrictEqual(run.binding.repository, input.task.revision.repository) ||
    run.binding.purpose.kind !== 'PreparedCompatibilityCalibration' ||
    run.binding.purpose.ordinal !== ordinal ||
    run.lifecycle.kind !== 'Ended' ||
    (run.lifecycle.outcome.kind !== 'CalibrationConfirmed' &&
      run.lifecycle.outcome.kind !== 'CalibrationExcluded')
  )
    return { kind: 'Blocked', gate: 'Timeline' };
  const first = await input.evidence.inspect(runId, { limit: 100 });
  if (first.kind !== 'Found') return { kind: 'Blocked', gate: 'Timeline' };
  const stream = first.page.stream;
  if (
    stream.runId !== runId ||
    stream.evidenceStreamId !== run.binding.evidenceStreamId ||
    stream.seal.kind !== 'Sealed' ||
    stream.cursor.kind !== 'Accepted' ||
    stream.checkpoint.kind !== 'Accepted' ||
    stream.checkpoint.checkpointSaid !== run.lifecycle.outcome.checkpointSaid
  )
    return { kind: 'Blocked', gate: 'Timeline' };
  let page = first.page;
  let sequence = 0;
  let head: string | undefined;
  let incarnationId: string | undefined;
  const observations: EvidenceEvent[] = [];
  const failures: EvidenceEvent[] = [];
  const cursors = new Set<string>();
  for (let pages = 0; pages < 64; pages += 1) {
    if (
      input.signal.aborted ||
      !sameStream(stream, page.stream) ||
      (page.events.length === 0 && page.nextCursor !== null)
    )
      return { kind: 'Blocked', gate: 'Timeline' };
    for (const { event } of page.events) {
      if (
        decodeEvidenceEvent(event).kind !== 'Accepted' ||
        event.sequence !== sequence ||
        event.runId !== runId ||
        event.taskId !== qualified.taskId ||
        event.taskRevisionSaid !== qualified.taskRevisionSaid ||
        event.harnessRevisionSaid !== qualified.expectedActiveRevisionSaid ||
        event.personalAgentAid !== qualified.personalAgentAid ||
        event.taskMandateSaid !== qualified.taskMandateSaid ||
        (incarnationId !== undefined && event.incarnationId !== incarnationId) ||
        (head === undefined
          ? event.predecessor.kind !== 'Genesis'
          : event.predecessor.kind !== 'Previous' || event.predecessor.eventSaid !== head)
      )
        return { kind: 'Blocked', gate: 'Timeline' };
      sequence += 1;
      head = event.d;
      incarnationId = event.incarnationId;
      if (event.event.kind === 'Observation' && event.event.source === 'Verifier')
        observations.push(event);
      if (
        event.event.kind === 'FailureObserved' &&
        event.event.failure === 'HarnessCompatibilityFailure'
      )
        failures.push(event);
    }
    if (page.nextCursor === null) break;
    if (cursors.has(page.nextCursor)) return { kind: 'Blocked', gate: 'Timeline' };
    cursors.add(page.nextCursor);
    const next = await input.evidence.inspect(runId, { limit: 100, cursor: page.nextCursor });
    if (next.kind !== 'Found') return { kind: 'Blocked', gate: 'Timeline' };
    page = next.page;
  }
  if (
    sequence !== stream.cursor.eventCount ||
    sequence !== stream.seal.eventCount ||
    head !== stream.cursor.chainHeadSaid ||
    head !== stream.seal.chainHeadSaid ||
    sequence === 0
  )
    return { kind: 'Blocked', gate: 'Timeline' };
  if (run.lifecycle.outcome.kind === 'CalibrationExcluded')
    return { kind: 'Excluded', campaignId: run.binding.purpose.campaignId };
  const category = run.lifecycle.outcome.category;
  if (
    category.taskId !== qualified.taskId ||
    category.taskRevisionSaid !== qualified.taskRevisionSaid ||
    category.harnessRevisionSaid !== qualified.expectedActiveRevisionSaid
  )
    return { kind: 'Blocked', gate: 'Timeline' };
  if (
    failures.length !== 1 ||
    observations.length === 0 ||
    input.evidence.readVerifierReceipt === undefined ||
    input.evidence.readArtifact === undefined
  )
    return { kind: 'Blocked', gate: 'Timeline' };
  const failure = failures[0];
  if (failure?.event.kind !== 'FailureObserved') return { kind: 'Blocked', gate: 'Timeline' };
  const receiptRead = await input.evidence.readVerifierReceipt(
    runId,
    failure.event.receiptSaid,
    input.signal,
  );
  if (
    receiptRead.kind !== 'Read' ||
    receiptRead.checkpointSaid !== stream.checkpoint.checkpointSaid ||
    receiptRead.receipt.d !== failure.event.receiptSaid ||
    decodePublicVerifierReceipt(receiptRead.receipt).kind !== 'Accepted' ||
    receiptRead.receipt.commandSaid !== category.legacyCommandSaid ||
    receiptRead.receipt.outcome.kind !== 'Rejected' ||
    receiptRead.receipt.outcome.reason.kind !== 'UnexpectedExitCode' ||
    receiptRead.receipt.outcome.reason.expected !== 0 ||
    receiptRead.receipt.outcome.reason.observed !== category.legacyObservedExitCode
  )
    return { kind: 'Blocked', gate: 'Receipt' };
  const outputSaids = new Set(receiptRead.receipt.outcome.outputArtifactSaids);
  const matching = observations.filter(
    (event) =>
      event.sequence < failure.sequence &&
      event.event.kind === 'Observation' &&
      outputSaids.has(event.event.artifactSaid),
  );
  if (matching.length === 0) return { kind: 'Blocked', gate: 'Receipt' };
  for (const event of matching) {
    if (event.event.kind !== 'Observation') continue;
    const rawEvidenceSaid = event.event.artifactSaid;
    const raw = await input.evidence.readArtifact(runId, rawEvidenceSaid, input.signal);
    if (
      raw.kind !== 'Read' ||
      raw.artifact.d !== rawEvidenceSaid ||
      raw.artifact.mediaType !== 'text/plain; charset=utf-8' ||
      decodeEvidenceArtifact(raw.artifact, raw.bytes).kind !== 'Accepted' ||
      raw.bytes.byteLength > 32 * 1024
    )
      return { kind: 'Blocked', gate: 'RawSource' };
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(raw.bytes);
    } catch {
      return { kind: 'Blocked', gate: 'RawSource' };
    }
    if (text.length === 0 || text.length > 32 * 1024) continue;
    return {
      kind: 'Found',
      campaignId: run.binding.purpose.campaignId,
      source: {
        runId,
        observationEventSaid: event.d,
        rawEvidenceSaid,
        failureEventSaid: failure.d,
        verifierReceiptSaid: receiptRead.receipt.d,
      },
    };
  }
  return { kind: 'Blocked', gate: 'RawSource' };
}

/** E3 Q: verify all five sealed calibrations; expose only their four or five confirmed public sources. */
export async function prepareQualifiedSourceInventory(
  input: QualificationInput,
  ports: {
    readonly qualification: RunQualification;
    readonly history: CalibrationCampaignHistory;
    readonly mandate: CurrentExperienceMandate;
  },
): Promise<QualifiedSourceInventoryPreparation> {
  if (input.signal.aborted) return { kind: 'Blocked', gate: 'Qualification' };
  let qualified: Awaited<ReturnType<RunQualification['inspect']>>;
  try {
    qualified = await ports.qualification.inspect(input);
  } catch {
    return { kind: 'Blocked', gate: 'Qualification' };
  }
  const task = input.task;
  if (
    qualified.kind !== 'Qualified' ||
    task.revision.version !== 2 ||
    qualified.taskId !== task.taskId ||
    qualified.taskRevisionSaid !== task.revisionSaid ||
    qualified.originRunId !== input.originRunId ||
    qualified.expectedActiveRevisionSaid !== input.expectedActiveRevisionSaid ||
    qualified.executionProfileSaid !== input.executionProfileSaid
  )
    return { kind: 'Blocked', gate: 'Qualification' };
  let mandate: Awaited<ReturnType<CurrentExperienceMandate['inspect']>>;
  try {
    mandate = await ports.mandate.inspect({
      taskId: task.taskId,
      taskRevisionSaid: task.revisionSaid,
      ownerAid: task.ownerAid,
    });
  } catch {
    return { kind: 'Blocked', gate: 'Mandate' };
  }
  if (
    mandate.kind !== 'Current' ||
    mandate.mandateSaid !== qualified.taskMandateSaid ||
    mandate.ownerAid !== task.ownerAid ||
    mandate.taskId !== task.taskId ||
    mandate.taskRevisionSaid !== task.revisionSaid ||
    mandate.repositoryResourceSaid !==
      task.revision.constraints.experience.repositoryResourceSaid ||
    mandate.corpusSaid !== task.revision.constraints.experience.corpusSaid ||
    mandate.disclosure !== 'AuthorizedAnalogy'
  )
    return { kind: 'Blocked', gate: 'Mandate' };
  let history: Awaited<ReturnType<CalibrationCampaignHistory['read']>>;
  try {
    history = await ports.history.read({
      taskId: task.taskId,
      harnessRevisionSaid: qualified.expectedActiveRevisionSaid,
    });
  } catch {
    return { kind: 'Blocked', gate: 'History' };
  }
  if (
    history.kind !== 'Found' ||
    history.runIds.length !== 5 ||
    new Set([...history.runIds, input.originRunId]).size !== 6
  )
    return { kind: 'Blocked', gate: 'History' };
  const sources: QualifiedInventorySource[] = [];
  let campaignId: string | undefined;
  for (const [index, runId] of history.runIds.entries()) {
    let read: SourceReading;
    try {
      read = await readCalibration(runId, index + 1, input, qualified);
    } catch {
      return { kind: 'Blocked', gate: 'Timeline' };
    }
    if (read.kind === 'Blocked') return read;
    if (campaignId !== undefined && campaignId !== read.campaignId)
      return { kind: 'Blocked', gate: 'Timeline' };
    campaignId = read.campaignId;
    if (read.kind === 'Found') sources.push(read.source);
  }
  if (sources.length < 4) return { kind: 'Blocked', gate: 'Timeline' };
  const prepared = prepareEvaluationSourceInventory({
    taskId: task.taskId,
    taskRevisionSaid: task.revisionSaid,
    ownerAid: task.ownerAid,
    repositoryResourceSaid: mandate.repositoryResourceSaid,
    corpusSaid: mandate.corpusSaid,
    experienceMandateSaid: mandate.mandateSaid,
    sources: sources.map((source) => ({
      episodeSaid: source.observationEventSaid,
      rawEvidenceSaid: source.rawEvidenceSaid,
      ownerAid: task.ownerAid,
      repositoryResourceSaid: mandate.repositoryResourceSaid,
      corpusSaid: mandate.corpusSaid,
      disclosure: 'AuthorizedAnalogy' as const,
    })),
  });
  return prepared.kind === 'Prepared'
    ? { kind: 'Prepared', qualified, inventory: prepared.inventory, sources }
    : { kind: 'Blocked', gate: 'Inventory' };
}
