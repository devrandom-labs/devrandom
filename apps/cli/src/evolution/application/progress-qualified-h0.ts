import { isDeepStrictEqual } from 'node:util';

import {
  decodeEvidenceArtifact,
  decodeEvaluationExecutionProfile,
  decodeEvaluationPolicy,
  decodeEvolutionHypothesis,
  decodeQualifiedFailureWindow,
  prepareEvidenceArtifact,
  type EvaluationExecutionProfile,
  type EvaluationPolicy,
  type EvaluationSourceInventory,
  type EvidenceArtifact,
} from '@devrandom/protocol';
import type { EvidenceReading, ExperienceRetrieval } from '@devrandom/runtime';

import type { RunQualification } from '../../harness/application/harness-evaluation.js';
import {
  prepareQualifiedSourceInventory,
  type CurrentExperienceMandate,
  type QualifiedInventorySource,
} from '../../harness/application/prepare-qualified-source-inventory.js';
import type { CalibrationCampaignHistory } from '../../harness/application/verified-failure-campaign.js';
import {
  proposeQualifiedDiagnosis,
  type PublicAnalogyReviewCustody,
} from './propose-qualified-diagnosis.js';
import { decodeReviewedPublicAnalogy } from './review-public-analogy.js';

type QualificationInput = Parameters<RunQualification['inspect']>[0];
type Qualified = Extract<Awaited<ReturnType<RunQualification['inspect']>>, { kind: 'Qualified' }>;

function interrupted(signal: AbortSignal): boolean {
  return signal.aborted;
}
type AdmissionCommand = {
  readonly version: 1;
  readonly commandId: string;
  readonly fingerprint: string;
  readonly taskId: string;
  readonly taskRevisionSaid: string;
  readonly originRunId: string;
  readonly retainedCheckpointSaid: string;
  readonly retainedSealSaid: string;
  readonly expectedActiveRevisionSaid: string;
  readonly personalAgentAid: string;
  readonly taskMandateSaid: string;
  readonly policySaid: string;
  readonly executionProfileSaid: string;
  readonly sourceInventorySaid: string;
  readonly allocation: EvaluationPolicy['allocation'];
};

export interface ReviewedComparisonPlan {
  review(input: {
    readonly qualified: Qualified;
    readonly inventory: EvaluationSourceInventory;
  }): Promise<
    | {
        readonly kind: 'Reviewed';
        readonly policy: EvaluationPolicy;
        readonly profile: EvaluationExecutionProfile;
      }
    | { readonly kind: 'Missing' | 'Unavailable' }
  >;
}

/** The existing durable EvaluationCommandFile implements this conversation. */
export interface QualifiedEvaluationCommands {
  acquire(input: {
    readonly taskId: string;
    readonly originRunId: string;
    readonly policySaid: string;
  }): Promise<
    | {
        readonly kind: 'Recorded';
        readonly commandId: string;
        readonly fingerprint: string;
        readonly admittedEvaluationId?: string;
      }
    | { readonly kind: 'Conflict' | 'Unavailable' }
  >;
  recordAdmission(
    input: { readonly taskId: string; readonly originRunId: string; readonly policySaid: string },
    commandId: string,
    evaluationId: string,
  ): Promise<{ readonly kind: 'Recorded' | 'Conflict' | 'Unavailable' }>;
}

export interface HostedQualifiedEvaluation {
  prepare(
    command: {
      readonly version: 1;
      readonly commandId: string;
      readonly fingerprint: string;
      readonly taskId: string;
      readonly taskRevisionSaid: string;
      readonly sourceInventory: EvaluationSourceInventory;
      readonly executionProfile: EvaluationExecutionProfile;
    },
    signal: AbortSignal,
  ): Promise<
    | { readonly kind: 'Prepared' | 'AlreadyPrepared' }
    | { readonly kind: 'Rejected' | 'Conflict' | 'Unavailable' | 'ResponseInvalid' }
  >;
  admit(
    command: AdmissionCommand,
    signal: AbortSignal,
  ): Promise<
    | {
        readonly kind: 'Admitted';
        readonly evaluationId: string;
        readonly version: number;
        readonly lease: {
          readonly evaluationId: string;
          readonly leaseId: string;
          readonly version: number;
          readonly serverTime: string;
          readonly expiresAt: string;
        };
        readonly evidenceStreamId: string;
        readonly reservationSaid: string;
      }
    | {
        readonly kind: 'Blocked';
        readonly gate: 'Profile' | 'Source' | 'Authority' | 'Budget' | 'Qualification' | 'Evidence';
      }
    | { readonly kind: 'Rejected' | 'Conflict' | 'Unavailable' | 'ResponseInvalid' }
  >;
}

/** Opens only the typed hosted Atlas and exact Evidence conversations for the prepared inventory. */
export interface ScopedAnalogyConversations {
  open(inventory: EvaluationSourceInventory): {
    readonly retrieval: ExperienceRetrieval;
    readonly reading: EvidenceReading;
  };
}

export interface QualifiedH0Records {
  inspectEvaluation(
    evaluationId: string,
  ): Promise<
    | { readonly kind: 'Read'; readonly artifact: EvidenceArtifact; readonly bytes: Uint8Array }
    | { readonly kind: 'NotFound' | 'Unavailable' }
  >;
  commit(input: {
    readonly evaluationId: string;
    readonly artifact: EvidenceArtifact;
    readonly bytes: Uint8Array;
  }): Promise<
    | { readonly kind: 'Committed' | 'AlreadyCommitted'; readonly artifactSaid: string }
    | { readonly kind: 'Conflict' | 'Unavailable' }
  >;
}

export interface QualifiedH0Progress {
  readonly kind: 'Progressed';
  readonly evaluationId: string;
  readonly sourceInventorySaid: string;
  readonly policySaid: string;
  readonly hypothesisSaid: string;
  readonly queryReceiptSaid: string;
  readonly recordArtifactSaid: string;
}

export type QualifiedH0ProgressOutcome =
  | QualifiedH0Progress
  | {
      readonly kind: 'Blocked';
      readonly gate:
        | 'Qualification'
        | 'Mandate'
        | 'History'
        | 'Timeline'
        | 'Receipt'
        | 'RawSource'
        | 'Inventory'
        | 'Policy'
        | 'ReviewCustody'
        | 'Command'
        | 'Preparation'
        | 'Admission'
        | 'Budget'
        | 'Hypothesis'
        | 'Record';
      readonly evaluationId?: string;
    };

function proposalArtifact(
  input: unknown,
):
  | { readonly kind: 'Prepared'; readonly artifact: EvidenceArtifact; readonly bytes: Uint8Array }
  | { readonly kind: 'Rejected' } {
  const bytes = new TextEncoder().encode(JSON.stringify(input));
  if (bytes.byteLength > 64 * 1024) return { kind: 'Rejected' };
  const prepared = prepareEvidenceArtifact(bytes, 'application/json');
  return prepared.kind === 'Prepared'
    ? { kind: 'Prepared', artifact: prepared.artifact, bytes }
    : { kind: 'Rejected' };
}

/** A lost reply replays the exact prior H0 artifact, never another paid Atlas query. */
function recordedProgress(
  read: Extract<Awaited<ReturnType<QualifiedH0Records['inspectEvaluation']>>, { kind: 'Read' }>,
  expected: {
    readonly evaluationId: string;
    readonly reservationSaid: string;
    readonly qualified: Qualified;
    readonly inventory: EvaluationSourceInventory;
    readonly policy: EvaluationPolicy;
    readonly profile: EvaluationExecutionProfile;
    readonly sources: readonly QualifiedInventorySource[];
    readonly reviewArtifactSaids: readonly string[];
    readonly configurationSaid: string;
    readonly nonTreatmentInputsSaid: string;
  },
): QualifiedH0Progress | undefined {
  if (decodeEvidenceArtifact(read.artifact, read.bytes).kind !== 'Accepted') return undefined;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(read.bytes)) as unknown;
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as {
    version?: unknown;
    kind?: unknown;
    evaluationId?: unknown;
    admission?: { reservationSaid?: unknown };
    qualified?: unknown;
    inventory?: EvaluationSourceInventory;
    policy?: EvaluationPolicy;
    profile?: EvaluationExecutionProfile;
    sources?: unknown;
    reviewArtifactSaids?: unknown;
    selectedReviewArtifactSaid?: string;
    hypothesis?: unknown;
    window?: { artifact?: unknown; bytesBase64Url?: unknown };
    queryReceiptSaid?: unknown;
    sourceReadReceiptSaid?: unknown;
  };
  if (
    record.version !== 1 ||
    record.kind !== 'QualifiedH0Progress' ||
    record.evaluationId !== expected.evaluationId ||
    record.admission?.reservationSaid !== expected.reservationSaid ||
    !isDeepStrictEqual(record.qualified, expected.qualified) ||
    !isDeepStrictEqual(record.inventory, expected.inventory) ||
    !isDeepStrictEqual(record.policy, expected.policy) ||
    !isDeepStrictEqual(record.profile, expected.profile) ||
    !isDeepStrictEqual(record.sources, expected.sources) ||
    !isDeepStrictEqual(record.reviewArtifactSaids, expected.reviewArtifactSaids) ||
    typeof record.window?.bytesBase64Url !== 'string' ||
    typeof record.queryReceiptSaid !== 'string' ||
    typeof record.sourceReadReceiptSaid !== 'string' ||
    !expected.reviewArtifactSaids.includes(record.selectedReviewArtifactSaid ?? '')
  )
    return undefined;
  const decodedHypothesis = decodeEvolutionHypothesis(record.hypothesis);
  const bytes = Buffer.from(record.window.bytesBase64Url, 'base64url');
  if (bytes.toString('base64url') !== record.window.bytesBase64Url) return undefined;
  const decodedWindow = decodeQualifiedFailureWindow(record.window.artifact, bytes);
  if (
    decodedHypothesis.kind !== 'Accepted' ||
    decodedWindow.kind !== 'Accepted' ||
    decodedHypothesis.hypothesis.taskId !== expected.qualified.taskId ||
    decodedHypothesis.hypothesis.taskRevisionSaid !== expected.qualified.taskRevisionSaid ||
    decodedHypothesis.hypothesis.originRunId !== expected.qualified.originRunId ||
    decodedHypothesis.hypothesis.sourceInventorySaid !== expected.inventory.d ||
    decodedHypothesis.hypothesis.retrievalReceiptSaid !== record.queryReceiptSaid ||
    decodedHypothesis.hypothesis.publicReplay.failureWindowSaid !== decodedWindow.artifact.d ||
    decodedHypothesis.hypothesis.publicReplay.configurationSaid !== expected.configurationSaid ||
    decodedHypothesis.hypothesis.publicReplay.nonTreatmentInputsSaid !==
      expected.nonTreatmentInputsSaid
  )
    return undefined;
  return {
    kind: 'Progressed',
    evaluationId: expected.evaluationId,
    sourceInventorySaid: expected.inventory.d,
    policySaid: expected.policy.d,
    hypothesisSaid: decodedHypothesis.hypothesis.d,
    queryReceiptSaid: record.queryReceiptSaid,
    recordArtifactSaid: read.artifact.d,
  };
}

/** Q → lawful source admission → exact Atlas/raw H0, with command and final artifact custody. */
export async function progressQualifiedH0(
  input: {
    readonly qualification: QualificationInput;
    readonly reviewArtifactSaids: readonly string[];
    readonly configurationSaid: string;
    readonly nonTreatmentInputsSaid: string;
  },
  ports: {
    readonly qualification: RunQualification;
    readonly history: CalibrationCampaignHistory;
    readonly mandate: CurrentExperienceMandate;
    readonly policy: ReviewedComparisonPlan;
    readonly reviews: PublicAnalogyReviewCustody;
    readonly commands: QualifiedEvaluationCommands;
    readonly hosted: HostedQualifiedEvaluation;
    readonly context: ScopedAnalogyConversations;
    readonly records: QualifiedH0Records;
  },
): Promise<QualifiedH0ProgressOutcome> {
  const signal = input.qualification.signal;
  if (interrupted(signal)) return { kind: 'Blocked', gate: 'Qualification' };
  const prepared = await prepareQualifiedSourceInventory(input.qualification, ports);
  if (prepared.kind !== 'Prepared') return prepared;
  const { qualified, inventory, sources } = prepared;
  if (
    input.reviewArtifactSaids.length < 1 ||
    input.reviewArtifactSaids.length > 5 ||
    new Set(input.reviewArtifactSaids).size !== input.reviewArtifactSaids.length
  )
    return { kind: 'Blocked', gate: 'ReviewCustody' };
  for (const reviewSaid of input.reviewArtifactSaids) {
    let read: Awaited<ReturnType<PublicAnalogyReviewCustody['read']>>;
    try {
      read = await ports.reviews.read(reviewSaid);
    } catch {
      return { kind: 'Blocked', gate: 'ReviewCustody' };
    }
    if (
      read.kind !== 'Read' ||
      read.artifact.d !== reviewSaid ||
      !sources.some(
        (source: QualifiedInventorySource) =>
          source.runId === read.review.runId &&
          source.observationEventSaid === read.review.episodeSaid &&
          source.rawEvidenceSaid === read.review.rawEvidenceSaid,
      ) ||
      decodeReviewedPublicAnalogy(new TextEncoder().encode(JSON.stringify(read.review))).kind !==
        'Accepted'
    )
      return { kind: 'Blocked', gate: 'ReviewCustody' };
  }
  let reviewed: Awaited<ReturnType<ReviewedComparisonPlan['review']>>;
  try {
    reviewed = await ports.policy.review({ qualified, inventory });
  } catch {
    return { kind: 'Blocked', gate: 'Policy' };
  }
  if (reviewed.kind !== 'Reviewed') return { kind: 'Blocked', gate: 'Policy' };
  const { policy, profile } = reviewed;
  if (
    decodeEvaluationPolicy(policy).kind !== 'Accepted' ||
    decodeEvaluationExecutionProfile(profile).kind !== 'Accepted' ||
    policy.taskId !== qualified.taskId ||
    policy.taskRevisionSaid !== qualified.taskRevisionSaid ||
    policy.originRunId !== qualified.originRunId ||
    policy.expectedActiveRevisionSaid !== qualified.expectedActiveRevisionSaid ||
    policy.executionProfileSaid !== qualified.executionProfileSaid ||
    policy.sourceInventorySaid !== inventory.d ||
    profile.d !== qualified.executionProfileSaid ||
    profile.sourceGitCommit !== input.qualification.task.revision.repository.commit ||
    profile.sourceGitTree !== input.qualification.task.revision.repository.tree
  )
    return { kind: 'Blocked', gate: 'Policy' };
  const commandInput = {
    taskId: qualified.taskId,
    originRunId: qualified.originRunId,
    policySaid: policy.d,
  };
  let command: Awaited<ReturnType<QualifiedEvaluationCommands['acquire']>>;
  try {
    command = await ports.commands.acquire(commandInput);
  } catch {
    return { kind: 'Blocked', gate: 'Command' };
  }
  if (command.kind !== 'Recorded') return { kind: 'Blocked', gate: 'Command' };
  if (interrupted(signal)) return { kind: 'Blocked', gate: 'Command' };
  if (command.admittedEvaluationId === undefined) {
    let preparation: Awaited<ReturnType<HostedQualifiedEvaluation['prepare']>>;
    try {
      preparation = await ports.hosted.prepare(
        {
          version: 1,
          commandId: command.commandId,
          fingerprint: command.fingerprint,
          taskId: qualified.taskId,
          taskRevisionSaid: qualified.taskRevisionSaid,
          sourceInventory: inventory,
          executionProfile: profile,
        },
        signal,
      );
    } catch {
      return { kind: 'Blocked', gate: 'Preparation' };
    }
    if (preparation.kind !== 'Prepared' && preparation.kind !== 'AlreadyPrepared')
      return { kind: 'Blocked', gate: 'Preparation' };
  }
  if (interrupted(signal)) return { kind: 'Blocked', gate: 'Admission' };
  let admitted: Awaited<ReturnType<HostedQualifiedEvaluation['admit']>>;
  try {
    admitted = await ports.hosted.admit(
      {
        version: 1,
        commandId: command.commandId,
        fingerprint: command.fingerprint,
        taskId: qualified.taskId,
        taskRevisionSaid: qualified.taskRevisionSaid,
        originRunId: qualified.originRunId,
        retainedCheckpointSaid: qualified.retainedCheckpointSaid,
        retainedSealSaid: qualified.retainedSealSaid,
        expectedActiveRevisionSaid: qualified.expectedActiveRevisionSaid,
        personalAgentAid: qualified.personalAgentAid,
        taskMandateSaid: qualified.taskMandateSaid,
        policySaid: policy.d,
        executionProfileSaid: profile.d,
        sourceInventorySaid: inventory.d,
        allocation: policy.allocation,
      },
      signal,
    );
  } catch {
    return { kind: 'Blocked', gate: 'Admission' };
  }
  if (admitted.kind === 'Blocked')
    return { kind: 'Blocked', gate: admitted.gate === 'Budget' ? 'Budget' : 'Admission' };
  if (
    admitted.kind !== 'Admitted' ||
    (command.admittedEvaluationId !== undefined &&
      command.admittedEvaluationId !== admitted.evaluationId) ||
    admitted.lease.evaluationId !== admitted.evaluationId ||
    admitted.lease.version !== admitted.version
  )
    return { kind: 'Blocked', gate: 'Admission' };
  let recorded: Awaited<ReturnType<QualifiedEvaluationCommands['recordAdmission']>>;
  try {
    recorded = await ports.commands.recordAdmission(
      commandInput,
      command.commandId,
      admitted.evaluationId,
    );
  } catch {
    return { kind: 'Blocked', gate: 'Command', evaluationId: admitted.evaluationId };
  }
  if (recorded.kind !== 'Recorded')
    return { kind: 'Blocked', gate: 'Command', evaluationId: admitted.evaluationId };
  let previous: Awaited<ReturnType<QualifiedH0Records['inspectEvaluation']>>;
  try {
    previous = await ports.records.inspectEvaluation(admitted.evaluationId);
  } catch {
    return { kind: 'Blocked', gate: 'Record', evaluationId: admitted.evaluationId };
  }
  if (previous.kind === 'Read') {
    const replay = recordedProgress(previous, {
      evaluationId: admitted.evaluationId,
      reservationSaid: admitted.reservationSaid,
      qualified,
      inventory,
      policy,
      profile,
      sources,
      reviewArtifactSaids: input.reviewArtifactSaids,
      configurationSaid: input.configurationSaid,
      nonTreatmentInputsSaid: input.nonTreatmentInputsSaid,
    });
    return replay ?? { kind: 'Blocked', gate: 'Record', evaluationId: admitted.evaluationId };
  }
  if (previous.kind !== 'NotFound')
    return { kind: 'Blocked', gate: 'Record', evaluationId: admitted.evaluationId };
  if (interrupted(signal))
    return { kind: 'Blocked', gate: 'Hypothesis', evaluationId: admitted.evaluationId };
  let context: ReturnType<ScopedAnalogyConversations['open']>;
  try {
    context = ports.context.open(inventory);
  } catch {
    return { kind: 'Blocked', gate: 'Hypothesis', evaluationId: admitted.evaluationId };
  }
  let proposed: Awaited<ReturnType<typeof proposeQualifiedDiagnosis>>;
  try {
    proposed = await proposeQualifiedDiagnosis(
      {
        qualification: input.qualification,
        inventory,
        reviewArtifactSaids: input.reviewArtifactSaids,
        configurationSaid: input.configurationSaid,
        nonTreatmentInputsSaid: input.nonTreatmentInputsSaid,
      },
      {
        qualification: ports.qualification,
        history: ports.history,
        reviews: ports.reviews,
        retrieval: context.retrieval,
        reading: context.reading,
      },
    );
  } catch {
    return { kind: 'Blocked', gate: 'Hypothesis', evaluationId: admitted.evaluationId };
  }
  if (proposed.kind !== 'Proposed')
    return { kind: 'Blocked', gate: 'Hypothesis', evaluationId: admitted.evaluationId };
  const { construction } = proposed;
  const hypothesis = construction.hypothesis;
  const influence = construction.influence.review;
  if (
    decodeEvolutionHypothesis(hypothesis).kind !== 'Accepted' ||
    decodeQualifiedFailureWindow(construction.window.artifact, construction.window.bytes).kind !==
      'Accepted' ||
    hypothesis.taskId !== qualified.taskId ||
    hypothesis.taskRevisionSaid !== qualified.taskRevisionSaid ||
    hypothesis.originRunId !== qualified.originRunId ||
    hypothesis.sourceInventorySaid !== inventory.d ||
    hypothesis.retrievalReceiptSaid !== influence.queryReceiptSaid ||
    hypothesis.publicReplay.failureWindowSaid !== construction.window.artifact.d ||
    hypothesis.publicReplay.configurationSaid !== input.configurationSaid ||
    hypothesis.publicReplay.nonTreatmentInputsSaid !== input.nonTreatmentInputsSaid ||
    !input.reviewArtifactSaids.includes(proposed.selectedReviewArtifactSaid)
  )
    return { kind: 'Blocked', gate: 'Hypothesis', evaluationId: admitted.evaluationId };
  const record = {
    version: 1 as const,
    kind: 'QualifiedH0Progress' as const,
    evaluationId: admitted.evaluationId,
    admission: admitted,
    qualified,
    sources,
    inventory,
    policy,
    profile,
    reviewArtifactSaids: [...input.reviewArtifactSaids],
    selectedReviewArtifactSaid: proposed.selectedReviewArtifactSaid,
    hypothesis,
    window: {
      artifact: construction.window.artifact,
      bytesBase64Url: Buffer.from(construction.window.bytes).toString('base64url'),
    },
    queryReceiptSaid: influence.queryReceiptSaid,
    sourceReadReceiptSaid: influence.source.readReceiptSaid,
  };
  const artifact = proposalArtifact(record);
  if (artifact.kind !== 'Prepared')
    return { kind: 'Blocked', gate: 'Record', evaluationId: admitted.evaluationId };
  let committed: Awaited<ReturnType<QualifiedH0Records['commit']>>;
  try {
    committed = await ports.records.commit({ evaluationId: admitted.evaluationId, ...artifact });
  } catch {
    return { kind: 'Blocked', gate: 'Record', evaluationId: admitted.evaluationId };
  }
  if (
    (committed.kind !== 'Committed' && committed.kind !== 'AlreadyCommitted') ||
    committed.artifactSaid !== artifact.artifact.d
  )
    return { kind: 'Blocked', gate: 'Record', evaluationId: admitted.evaluationId };
  return {
    kind: 'Progressed',
    evaluationId: admitted.evaluationId,
    sourceInventorySaid: inventory.d,
    policySaid: policy.d,
    hypothesisSaid: hypothesis.d,
    queryReceiptSaid: influence.queryReceiptSaid,
    recordArtifactSaid: artifact.artifact.d,
  };
}
