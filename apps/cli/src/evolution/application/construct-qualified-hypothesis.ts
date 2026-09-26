import { isDeepStrictEqual } from 'node:util';

import {
  decodeEvidenceEvent,
  decodeEvolutionHypothesis,
  decodePublicVerifierReceipt,
  decodeRunProjection,
  prepareQualifiedFailureWindow,
  type EvaluationSourceInventory,
  type EvidenceTimelinePage,
  type EvolutionHypothesis,
  type QualifiedFailureWindowPreparation,
} from '@devrandom/protocol';
import {
  reviewEvolutionHypothesisInfluence,
  type EvidenceReading,
  type ExperienceRetrieval,
  type HypothesisInfluenceReview,
  type ReviewedAnalogyProjection,
  type ReviewedChoiceRecalculation,
} from '@devrandom/runtime';

import type { RunQualification } from '../../harness/application/harness-evaluation.js';

type QualificationInput = Parameters<RunQualification['inspect']>[0];
type Qualified = Extract<Awaited<ReturnType<RunQualification['inspect']>>, { kind: 'Qualified' }>;

function interrupted(signal: AbortSignal): boolean {
  return signal.aborted;
}

export interface QualifiedHypothesisConstruction {
  readonly kind: 'Constructed';
  readonly hypothesis: EvolutionHypothesis;
  readonly window: Extract<QualifiedFailureWindowPreparation, { kind: 'Prepared' }>;
  readonly influence: Extract<HypothesisInfluenceReview, { kind: 'Influenced' }>;
}

export type QualifiedHypothesisOutcome =
  | QualifiedHypothesisConstruction
  | {
      readonly kind: 'Blocked';
      readonly gate:
        'Qualification' | 'Timeline' | 'Receipt' | 'Window' | 'Hypothesis' | 'Influence';
    };

export interface QualifiedHypothesisConversations {
  readonly qualification: RunQualification;
  readonly retrieval: ExperienceRetrieval;
  readonly reading: EvidenceReading;
  readonly projection: ReviewedAnalogyProjection;
  readonly choice: ReviewedChoiceRecalculation;
}

type FailurePrefix = {
  readonly eventSaid: string;
  readonly receiptSaid: string;
  readonly precedingEventSaids: readonly string[];
};

function sameStream(
  first: EvidenceTimelinePage['stream'],
  next: EvidenceTimelinePage['stream'],
): boolean {
  return isDeepStrictEqual(first, next);
}

/** Re-reads the sealed retained stream after Q, including the complete predecessor chain. */
async function readFailurePrefix(
  qualification: QualificationInput,
  qualified: Qualified,
): Promise<FailurePrefix | undefined> {
  const runId = qualified.originRunId;
  const runReading = await qualification.runs.inspect(runId);
  if (runReading.kind !== 'Found') return undefined;
  const decodedRun = decodeRunProjection(runReading.run);
  if (
    decodedRun.kind !== 'Accepted' ||
    decodedRun.run.binding.runId !== runId ||
    decodedRun.run.binding.taskId !== qualified.taskId ||
    decodedRun.run.binding.taskRevisionSaid !== qualified.taskRevisionSaid ||
    decodedRun.run.binding.ownerAid !== qualification.task.ownerAid ||
    decodedRun.run.binding.personalAgentAid !== qualified.personalAgentAid ||
    decodedRun.run.binding.taskMandateSaid !== qualified.taskMandateSaid ||
    decodedRun.run.binding.initialHarnessRevisionSaid !== qualified.expectedActiveRevisionSaid
  )
    return undefined;
  const first = await qualification.evidence.inspect(runId, { limit: 100 });
  if (first.kind !== 'Found') return undefined;
  const stream = first.page.stream;
  if (
    stream.runId !== runId ||
    stream.evidenceStreamId !== decodedRun.run.binding.evidenceStreamId ||
    stream.seal.kind !== 'Sealed' ||
    stream.seal.sealExchangeSaid !== qualified.retainedSealSaid ||
    stream.checkpoint.kind !== 'Accepted' ||
    stream.checkpoint.checkpointSaid !== qualified.retainedCheckpointSaid ||
    stream.cursor.kind !== 'Accepted'
  )
    return undefined;
  let page = first.page;
  let sequence = 0;
  let head: string | undefined;
  let incarnationId: string | undefined;
  let failure: FailurePrefix | undefined;
  const preceding: string[] = [];
  const cursors = new Set<string>();
  for (let pages = 0; pages < 64; pages += 1) {
    if (!sameStream(stream, page.stream) || (page.events.length === 0 && page.nextCursor !== null))
      return undefined;
    for (const received of page.events) {
      const event = received.event;
      if (
        decodeEvidenceEvent(event).kind !== 'Accepted' ||
        event.sequence !== sequence ||
        event.runId !== runId ||
        event.taskId !== qualified.taskId ||
        event.taskRevisionSaid !== qualified.taskRevisionSaid ||
        event.personalAgentAid !== qualified.personalAgentAid ||
        event.taskMandateSaid !== qualified.taskMandateSaid ||
        event.harnessRevisionSaid !== qualified.expectedActiveRevisionSaid ||
        (incarnationId !== undefined && event.incarnationId !== incarnationId) ||
        (head === undefined
          ? event.predecessor.kind !== 'Genesis'
          : event.predecessor.kind !== 'Previous' || event.predecessor.eventSaid !== head)
      )
        return undefined;
      if (event.event.kind === 'FailureObserved') {
        if (failure !== undefined || event.event.failure !== 'HarnessCompatibilityFailure')
          return undefined;
        failure = {
          eventSaid: event.d,
          receiptSaid: event.event.receiptSaid,
          precedingEventSaids: [...preceding],
        };
      } else if (failure === undefined) {
        preceding.push(event.d);
      }
      sequence += 1;
      head = event.d;
      incarnationId = event.incarnationId;
    }
    if (page.nextCursor === null) {
      return sequence === stream.cursor.eventCount &&
        stream.cursor.acceptedThroughSequence === sequence - 1 &&
        sequence === stream.seal.eventCount &&
        stream.seal.finalSequence === sequence - 1 &&
        head === stream.cursor.chainHeadSaid &&
        head === stream.seal.chainHeadSaid
        ? failure
        : undefined;
    }
    if (cursors.has(page.nextCursor)) return undefined;
    cursors.add(page.nextCursor);
    const continuation = await qualification.evidence.inspect(runId, {
      limit: 100,
      cursor: page.nextCursor,
    });
    if (continuation.kind !== 'Found') return undefined;
    page = continuation.page;
  }
  return undefined;
}

/** E3 H0: Q, exact public failure evidence and causal source replay precede any mutation. */
export async function constructQualifiedEvolutionHypothesis(
  input: {
    readonly qualification: QualificationInput;
    readonly hypothesis: EvolutionHypothesis;
    readonly inventory: EvaluationSourceInventory;
  },
  ports: QualifiedHypothesisConversations,
): Promise<QualifiedHypothesisOutcome> {
  if (interrupted(input.qualification.signal)) return { kind: 'Blocked', gate: 'Qualification' };
  let qualified: Awaited<ReturnType<RunQualification['inspect']>>;
  try {
    qualified = await ports.qualification.inspect(input.qualification);
  } catch {
    return { kind: 'Blocked', gate: 'Qualification' };
  }
  if (
    qualified.kind !== 'Qualified' ||
    interrupted(input.qualification.signal) ||
    qualified.taskId !== input.qualification.task.taskId ||
    qualified.taskRevisionSaid !== input.qualification.task.revisionSaid ||
    qualified.originRunId !== input.qualification.originRunId ||
    qualified.expectedActiveRevisionSaid !== input.qualification.expectedActiveRevisionSaid
  )
    return { kind: 'Blocked', gate: 'Qualification' };
  const decodedHypothesis = decodeEvolutionHypothesis(input.hypothesis);
  if (decodedHypothesis.kind !== 'Accepted') return { kind: 'Blocked', gate: 'Hypothesis' };
  let failure: FailurePrefix | undefined;
  try {
    failure = await readFailurePrefix(input.qualification, qualified);
  } catch {
    return { kind: 'Blocked', gate: 'Timeline' };
  }
  if (failure === undefined || interrupted(input.qualification.signal))
    return { kind: 'Blocked', gate: 'Timeline' };
  const evidence = input.qualification.evidence;
  if (evidence.readVerifierReceipt === undefined) return { kind: 'Blocked', gate: 'Receipt' };
  let receipt: Awaited<ReturnType<NonNullable<typeof evidence.readVerifierReceipt>>>;
  try {
    receipt = await evidence.readVerifierReceipt(
      qualified.originRunId,
      failure.receiptSaid,
      input.qualification.signal,
    );
  } catch {
    return { kind: 'Blocked', gate: 'Receipt' };
  }
  if (
    receipt.kind !== 'Read' ||
    receipt.checkpointSaid !== qualified.retainedCheckpointSaid ||
    receipt.receipt.d !== failure.receiptSaid ||
    decodePublicVerifierReceipt(receipt.receipt).kind !== 'Accepted' ||
    interrupted(input.qualification.signal)
  )
    return { kind: 'Blocked', gate: 'Receipt' };
  const window = prepareQualifiedFailureWindow({
    version: 1,
    kind: 'QualifiedFailureWindow',
    taskId: qualified.taskId,
    taskRevisionSaid: qualified.taskRevisionSaid,
    originRunId: qualified.originRunId,
    retainedCheckpointSaid: qualified.retainedCheckpointSaid,
    retainedSealSaid: qualified.retainedSealSaid,
    failureEventSaid: failure.eventSaid,
    verifierReceiptSaid: receipt.receipt.d,
    precedingEventSaids: failure.precedingEventSaids,
  });
  if (
    window.kind !== 'Prepared' ||
    input.hypothesis.publicReplay.failureWindowSaid !== window.artifact.d
  )
    return { kind: 'Blocked', gate: 'Window' };
  const influence = await reviewEvolutionHypothesisInfluence(
    {
      hypothesis: input.hypothesis,
      inventory: input.inventory,
      retained: {
        taskId: qualified.taskId,
        taskRevisionSaid: qualified.taskRevisionSaid,
        originRunId: qualified.originRunId,
        retainedCheckpointSaid: qualified.retainedCheckpointSaid,
        retainedSealSaid: qualified.retainedSealSaid,
        parentRevisionSaid: qualified.expectedActiveRevisionSaid,
        personalAgentAid: qualified.personalAgentAid,
        failureEventSaid: failure.eventSaid,
        failureRawEvidenceSaid: receipt.receipt.d,
      },
    },
    ports,
  );
  if (
    influence.kind !== 'Influenced' ||
    influence.review.queryReceiptSaid !== input.hypothesis.retrievalReceiptSaid ||
    interrupted(input.qualification.signal)
  )
    return { kind: 'Blocked', gate: 'Influence' };
  return { kind: 'Constructed', hypothesis: input.hypothesis, window, influence };
}
