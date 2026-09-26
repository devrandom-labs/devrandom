import {
  decodeEvaluationSourceInventory,
  decodeEvidenceEvent,
  prepareEvolutionHypothesis,
  type EvaluationSourceInventory,
} from '@devrandom/protocol';
import {
  type EvidenceReading,
  type ExperienceRetrieval,
  type AuthorizedAnalogy,
} from '@devrandom/runtime';

import type { RunQualification } from '../../harness/application/harness-evaluation.js';
import type { CalibrationCampaignHistory } from '../../harness/application/verified-failure-campaign.js';

import {
  constructQualifiedEvolutionHypothesis,
  inspectQualifiedFailure,
  type QualifiedHypothesisConstruction,
} from './construct-qualified-hypothesis.js';
import {
  PublicAnalogyChoiceReplay,
  ReviewedPublicAnalogyProjection,
  type ReviewedPublicAnalogy,
} from './review-public-analogy.js';

const said = /^[A-Z][A-Za-z0-9_-]{43}$/u;

export type QualifiedDiagnosisOutcome =
  | {
      readonly kind: 'Proposed';
      readonly construction: QualifiedHypothesisConstruction;
      readonly selectedReviewArtifactSaid: string;
    }
  | {
      readonly kind: 'Blocked';
      readonly gate:
        | 'Qualification'
        | 'Timeline'
        | 'Receipt'
        | 'Window'
        | 'Inventory'
        | 'Query'
        | 'Retrieval'
        | 'RawSource'
        | 'SourceProvenance'
        | 'ReviewCustody'
        | 'Projection'
        | 'Choice'
        | 'Hypothesis'
        | 'Influence';
    };

type QualificationInput = Parameters<RunQualification['inspect']>[0];

export interface PublicAnalogyReviewCustody {
  read(artifactSaid: string): Promise<
    | {
        readonly kind: 'Read';
        readonly artifact: { readonly d: string };
        readonly review: ReviewedPublicAnalogy;
      }
    | { readonly kind: 'NotFound' | 'Unavailable' }
  >;
}

/** Current sealed Q timeline must still contain this exact public Verifier Observation. */
async function verifierObservation(
  qualification: QualificationInput,
  review: ReviewedPublicAnalogy,
  expectedActiveRevisionSaid: string,
): Promise<boolean> {
  let query: { readonly limit: number; readonly cursor?: string } = { limit: 100 };
  const cursors = new Set<string>();
  let observation = false;
  let confirmedFailure = false;
  for (let pageIndex = 0; pageIndex < 64; pageIndex += 1) {
    const found = await qualification.evidence.inspect(review.runId, query);
    if (
      found.kind !== 'Found' ||
      found.page.stream.runId !== review.runId ||
      found.page.stream.seal.kind !== 'Sealed'
    )
      return false;
    for (const { event } of found.page.events) {
      if (event.d !== review.episodeSaid && event.event.kind !== 'FailureObserved') continue;
      if (
        decodeEvidenceEvent(event).kind !== 'Accepted' ||
        event.runId !== review.runId ||
        event.taskId !== qualification.task.taskId ||
        event.taskRevisionSaid !== qualification.task.revisionSaid ||
        event.harnessRevisionSaid !== expectedActiveRevisionSaid
      )
        return false;
      if (event.d === review.episodeSaid) {
        if (
          event.event.kind !== 'Observation' ||
          event.event.source !== 'Verifier' ||
          event.event.artifactSaid !== review.rawEvidenceSaid
        )
          return false;
        observation = true;
      }
      if (
        event.event.kind === 'FailureObserved' &&
        event.event.failure === 'HarnessCompatibilityFailure'
      )
        confirmedFailure = true;
    }
    if (found.page.nextCursor === null) return observation && confirmedFailure;
    if (cursors.has(found.page.nextCursor)) return false;
    cursors.add(found.page.nextCursor);
    query = { limit: 100, cursor: found.page.nextCursor };
  }
  return false;
}

/** One Atlas lookup and current exact raw reads propose H0 only after genuine Q. */
export async function proposeQualifiedDiagnosis(
  input: {
    readonly qualification: QualificationInput;
    readonly inventory: EvaluationSourceInventory;
    readonly reviewArtifactSaids: readonly string[];
    readonly configurationSaid: string;
    readonly nonTreatmentInputsSaid: string;
  },
  ports: {
    readonly qualification: RunQualification;
    readonly history: CalibrationCampaignHistory;
    readonly reviews: PublicAnalogyReviewCustody;
    readonly retrieval: ExperienceRetrieval;
    readonly reading: EvidenceReading;
  },
): Promise<QualifiedDiagnosisOutcome> {
  const inspected = await inspectQualifiedFailure(input.qualification, ports.qualification);
  if (inspected.kind === 'Blocked') return inspected;
  const inventory = decodeEvaluationSourceInventory(input.inventory);
  const task = input.qualification.task;
  if (
    inventory.kind !== 'Accepted' ||
    task.revision.version !== 2 ||
    inventory.inventory.taskId !== inspected.qualified.taskId ||
    inventory.inventory.taskRevisionSaid !== inspected.qualified.taskRevisionSaid ||
    inventory.inventory.ownerAid !== task.ownerAid ||
    inventory.inventory.repositoryResourceSaid !==
      task.revision.constraints.experience.repositoryResourceSaid ||
    inventory.inventory.corpusSaid !== task.revision.constraints.experience.corpusSaid ||
    !said.test(input.configurationSaid) ||
    !said.test(input.nonTreatmentInputsSaid) ||
    input.qualification.signal.aborted
  )
    return { kind: 'Blocked', gate: 'Inventory' };
  if (
    input.reviewArtifactSaids.length < 1 ||
    input.reviewArtifactSaids.length > 5 ||
    new Set(input.reviewArtifactSaids).size !== input.reviewArtifactSaids.length ||
    input.reviewArtifactSaids.some((candidate) => !said.test(candidate))
  )
    return { kind: 'Blocked', gate: 'ReviewCustody' };
  const reviews: ReviewedPublicAnalogy[] = [];
  const reviewSaidsByEpisode = new Map<string, string>();
  for (const reviewSaid of input.reviewArtifactSaids) {
    let reading: Awaited<ReturnType<PublicAnalogyReviewCustody['read']>>;
    try {
      reading = await ports.reviews.read(reviewSaid);
    } catch {
      return { kind: 'Blocked', gate: 'ReviewCustody' };
    }
    if (reading.kind !== 'Read' || reading.artifact.d !== reviewSaid)
      return { kind: 'Blocked', gate: 'ReviewCustody' };
    reviews.push(reading.review);
    reviewSaidsByEpisode.set(reading.review.episodeSaid, reviewSaid);
  }
  const receipt = inspected.receipt;
  if (receipt.outcome.kind !== 'Rejected' || receipt.outcome.reason.kind !== 'UnexpectedExitCode')
    return { kind: 'Blocked', gate: 'Query' };
  const failureQuery = `${receipt.completionConditionId} receipt rejected expected exit ${String(receipt.outcome.reason.expected)} observed exit ${String(receipt.outcome.reason.observed)}`;
  if (failureQuery.length > 1024) return { kind: 'Blocked', gate: 'Query' };
  let retrieved: Awaited<ReturnType<ExperienceRetrieval['retrieve']>>;
  try {
    retrieved = await ports.retrieval.retrieve({
      taskId: inventory.inventory.taskId,
      taskRevisionSaid: inventory.inventory.taskRevisionSaid,
      sourceInventorySaid: inventory.inventory.d,
      corpusSaid: inventory.inventory.corpusSaid,
      failureQuery,
      maximumResults: 3,
    });
  } catch {
    return { kind: 'Blocked', gate: 'Retrieval' };
  }
  if (
    retrieved.kind !== 'Retrieved' ||
    !said.test(retrieved.queryReceiptSaid) ||
    retrieved.sources.length === 0 ||
    retrieved.sources.length > 3 ||
    !Number.isSafeInteger(retrieved.chargedMicroUsd) ||
    retrieved.chargedMicroUsd < 0
  )
    return { kind: 'Blocked', gate: 'Retrieval' };
  let campaign: Awaited<ReturnType<CalibrationCampaignHistory['read']>>;
  try {
    campaign = await ports.history.read({
      taskId: inspected.qualified.taskId,
      harnessRevisionSaid: inspected.qualified.expectedActiveRevisionSaid,
    });
  } catch {
    return { kind: 'Blocked', gate: 'SourceProvenance' };
  }
  if (
    campaign.kind !== 'Found' ||
    campaign.runIds.length !== 5 ||
    new Set(campaign.runIds).size !== 5 ||
    campaign.runIds.includes(inspected.qualified.originRunId)
  )
    return { kind: 'Blocked', gate: 'SourceProvenance' };
  let projection: ReviewedPublicAnalogyProjection;
  try {
    projection = new ReviewedPublicAnalogyProjection(reviews);
  } catch {
    return { kind: 'Blocked', gate: 'Projection' };
  }
  const sources: AuthorizedAnalogy[] = [];
  const records = new Map(reviews.map((review) => [review.episodeSaid, review]));
  const seen = new Set<string>();
  for (const source of retrieved.sources) {
    if (
      seen.has(source.episodeSaid) ||
      !inventory.inventory.sources.some(
        (allowed) =>
          allowed.episodeSaid === source.episodeSaid &&
          allowed.rawEvidenceSaid === source.rawEvidenceSaid,
      )
    )
      return { kind: 'Blocked', gate: 'Retrieval' };
    seen.add(source.episodeSaid);
    const reviewed = reviews.find((candidate) => candidate.episodeSaid === source.episodeSaid);
    if (reviewed === undefined || !campaign.runIds.includes(reviewed.runId))
      return { kind: 'Blocked', gate: 'SourceProvenance' };
    try {
      if (
        !(await verifierObservation(
          input.qualification,
          reviewed,
          inspected.qualified.expectedActiveRevisionSaid,
        ))
      )
        return { kind: 'Blocked', gate: 'SourceProvenance' };
    } catch {
      return { kind: 'Blocked', gate: 'SourceProvenance' };
    }
    let read: Awaited<ReturnType<EvidenceReading['read']>>;
    try {
      read = await ports.reading.read({
        taskId: inventory.inventory.taskId,
        sourceInventorySaid: inventory.inventory.d,
        evidenceSaid: source.rawEvidenceSaid,
        offset: 0,
        maximumBytes: 32_768,
      });
    } catch {
      return { kind: 'Blocked', gate: 'RawSource' };
    }
    if (
      read.kind !== 'Read' ||
      read.sourceSaid !== source.episodeSaid ||
      read.totalBytes !== read.bytes.byteLength ||
      !said.test(read.readReceiptSaid)
    )
      return { kind: 'Blocked', gate: 'RawSource' };
    const projected = await projection.project({
      episodeSaid: source.episodeSaid,
      rawEvidenceSaid: source.rawEvidenceSaid,
      readReceiptSaid: read.readReceiptSaid,
      bytes: read.bytes,
    });
    if (projected.kind !== 'Projected') return { kind: 'Blocked', gate: 'Projection' };
    sources.push(projected);
  }
  const firstSource = sources[0];
  if (firstSource === undefined) return { kind: 'Blocked', gate: 'Choice' };
  const provisional = new PublicAnalogyChoiceReplay(firstSource.episodeSaid);
  const fixed = {
    taskId: inventory.inventory.taskId,
    taskRevisionSaid: inventory.inventory.taskRevisionSaid,
    sourceInventorySaid: inventory.inventory.d,
    corpusSaid: inventory.inventory.corpusSaid,
    publicFailureWindowSaid: inspected.window.artifact.d,
    configurationSaid: input.configurationSaid,
    nonTreatmentInputsSaid: input.nonTreatmentInputsSaid,
    failureQuery,
  };
  let selected: Awaited<ReturnType<PublicAnalogyChoiceReplay['recalculate']>>;
  try {
    selected = await provisional.recalculate({ fixed, view: { sources } });
  } catch {
    return { kind: 'Blocked', gate: 'Choice' };
  }
  if (selected.kind !== 'Chosen') return { kind: 'Blocked', gate: 'Choice' };
  const record = records.get(selected.sourceChoiceSaid);
  const source = retrieved.sources.find((hit) => hit.episodeSaid === selected.sourceChoiceSaid);
  if (record === undefined || source === undefined) return { kind: 'Blocked', gate: 'Choice' };
  const prepared = prepareEvolutionHypothesis({
    taskId: inspected.qualified.taskId,
    taskRevisionSaid: inspected.qualified.taskRevisionSaid,
    originRunId: inspected.qualified.originRunId,
    retainedCheckpointSaid: inspected.qualified.retainedCheckpointSaid,
    retainedSealSaid: inspected.qualified.retainedSealSaid,
    parentRevisionSaid: inspected.qualified.expectedActiveRevisionSaid,
    personalAgentAid: inspected.qualified.personalAgentAid,
    sourceInventorySaid: inventory.inventory.d,
    retrievalReceiptSaid: retrieved.queryReceiptSaid,
    failure: {
      eventSaid: inspected.failureEventSaid,
      rawEvidenceSaid: inspected.receipt.d,
    },
    source: { episodeSaid: source.episodeSaid, rawEvidenceSaid: source.rawEvidenceSaid },
    implicatedComponent: record.implicatedComponent,
    predictedCorrection: record.predictedCorrection,
    publicReplay: {
      failureWindowSaid: inspected.window.artifact.d,
      configurationSaid: input.configurationSaid,
      nonTreatmentInputsSaid: input.nonTreatmentInputsSaid,
      failureQuery,
      predictedAction: selected.action,
      predictedSourceChoiceSaid: selected.sourceChoiceSaid,
      assertion: 'Removing this exact public source changes or disables the recovery action.',
    },
    falsifier:
      'The same recovery action remains supported after removing this source and its derived text.',
    regressionRisks: record.regressionRisks,
    rejectedExplanations: [
      'A transient verifier result does not explain the five sealed calibrations and retained failure.',
    ],
  });
  if (prepared.kind !== 'Prepared') return { kind: 'Blocked', gate: 'Hypothesis' };
  const replay = new PublicAnalogyChoiceReplay(source.episodeSaid);
  const constructed = await constructQualifiedEvolutionHypothesis(
    {
      qualification: input.qualification,
      hypothesis: prepared.hypothesis,
      inventory: inventory.inventory,
    },
    {
      qualification: ports.qualification,
      retrieval: {
        retrieve: (query) =>
          Promise.resolve(
            query.taskId === fixed.taskId &&
              query.taskRevisionSaid === fixed.taskRevisionSaid &&
              query.sourceInventorySaid === fixed.sourceInventorySaid &&
              query.corpusSaid === fixed.corpusSaid &&
              query.failureQuery === fixed.failureQuery
              ? retrieved
              : { kind: 'Denied' as const },
          ),
      },
      reading: ports.reading,
      projection,
      choice: replay,
    },
  );
  if (constructed.kind !== 'Constructed') return { kind: 'Blocked', gate: 'Influence' };
  const selectedReviewArtifactSaid = reviewSaidsByEpisode.get(source.episodeSaid);
  if (selectedReviewArtifactSaid === undefined) return { kind: 'Blocked', gate: 'ReviewCustody' };
  return { kind: 'Proposed', construction: constructed, selectedReviewArtifactSaid };
}
