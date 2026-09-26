import { resumeLocalCalibration } from './local-calibration-resumption.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { IssuerAid } from '@devrandom/identity';
import {
  decodeEvaluationSourceInventory,
  decodeEvolutionHypothesis,
  decodeQualifiedFailureWindow,
  type TaskProjection,
} from '@devrandom/protocol';
import {
  CommittedSuccessorRunBehavior,
  ExecutableCustody,
  materializeSuccessor,
  ReviewedCurrentRunHistory,
} from '@devrandom/runtime';
import type { HostedWorkAuthorityAcquisition } from '../../task/application/user-tasks.js';
import type { SignifyLocalMandateAuthority } from '../../mandate/infrastructure/signify-local-mandate-authority.js';
import { AuthorizedLocalTaskMandates } from '../../mandate/application/local-task-mandates.js';
import { TaskAuthorizationFile } from '../../mandate/infrastructure/task-authorization-file.js';
import { devrandomUserAlias } from '../../identity/domain/user-configuration.js';
import { BaselineHarnessAdmissionFile } from '../../harness/infrastructure/baseline-harness-admission-file.js';
import { EvaluationManifestCommandFile } from '../../harness/infrastructure/evaluation-manifest-command-file.js';
import { PromotionCommandFile } from '../../promotion/infrastructure/promotion-command-file.js';
import { PromotionEvidenceFile } from '../../promotion/infrastructure/promotion-evidence-file.js';
import { FileSuccessorTreatmentCustody } from '../../evolution/infrastructure/file-successor-treatment-custody.js';
import { FileSuccessorReplayCustody } from '../../evolution/infrastructure/file-successor-replay-custody.js';
import { FileQualifiedH0Records } from '../../evolution/infrastructure/file-qualified-h0-records.js';
import { FilePublicAnalogyReviews } from '../../evolution/infrastructure/file-public-analogy-reviews.js';
import {
  ReviewedPublicAnalogyProjection,
  PublicAnalogyChoiceReplay,
} from '../../evolution/application/review-public-analogy.js';
import { ParentSuccessorTreatmentReview } from '../../evolution/infrastructure/parent-successor-treatment-review.js';
import { ParentSuccessorPublicReplay } from '../../evolution/infrastructure/parent-successor-public-replay.js';
import { GitCesrPublicHistory } from '../../evolution/infrastructure/git-cesr-public-history.js';
import { QualifiedRunRecovery } from '../application/reviewed-run-recovery.js';
import { EnvironmentPiCredential } from '../infrastructure/pi-credential-environment.js';
import { SignifyTaskToolMandate } from '../infrastructure/signify-task-tool-mandate.js';
import { TaskResumptionComposition, type SupervisedTaskResumption } from './task-resumption.js';
import { TerminalRunSettlementComposition } from './terminal-run-settlement.js';
import type { LinuxRunBinding } from './linux-run-supervisor.js';

export interface LocalTaskResumptionInput {
  readonly stateRoot: string;
  readonly issuerAid: IssuerAid;
  readonly hosted: Extract<HostedWorkAuthorityAcquisition, { kind: 'Authorized' }>;
  readonly local: SignifyLocalMandateAuthority;
  readonly task: TaskProjection;
  readonly runId: string;
  readonly linux: LinuxRunBinding;
  readonly pauseAfterCheckpoint?: boolean;
  readonly signal: AbortSignal;
}
export type LocalTaskResumption =
  SupervisedTaskResumption | { readonly kind: 'Blocked'; readonly gate: string };
const record = (value: unknown): value is { readonly [key: string]: unknown } =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Local continuation composition, rooted in the authenticated committed pointer and original M. */
export async function resumeLocalTask(
  input: LocalTaskResumptionInput,
): Promise<LocalTaskResumption> {
  try {
    input.signal.throwIfAborted();
    if (input.task.ownerAid !== input.hosted.user.principal.aid)
      return { kind: 'Blocked', gate: 'Authority' };
    const existing = await input.hosted.runs.inspect(input.runId);
    if (
      existing.kind === 'Found' &&
      existing.run.purpose.kind === 'PreparedCompatibilityCalibration'
    )
      return await resumeLocalCalibration(input);
    const observed = await input.hosted.activationPointer().inspect(input.task.taskId);
    if (
      observed.kind !== 'Observed' ||
      observed.pointer.kind !== 'Committed' ||
      observed.pointer.disposition !== 'Activated' ||
      observed.pointer.taskRevisionSaid !== input.task.revisionSaid ||
      observed.pointer.harnessLineageId !== input.task.harnessLineageId
    )
      return { kind: 'Blocked', gate: 'Activation' };
    const pointer = observed.pointer;
    const staged = await new PromotionCommandFile(
      join(input.stateRoot, 'promotion-commands'),
    ).inspect(pointer.commandId);
    if (
      staged.kind !== 'Staged' ||
      staged.command.taskId !== input.task.taskId ||
      staged.command.taskRevisionSaid !== input.task.revisionSaid ||
      staged.command.expectedPointerVersion + 1 !== pointer.pointerVersion ||
      staged.command.disposition.kind !== 'Activate' ||
      staged.command.disposition.candidateRevisionSaid !== pointer.activeRevisionSaid
    )
      return { kind: 'Blocked', gate: 'Activation' };
    const closure = await new PromotionEvidenceFile(
      join(input.stateRoot, 'promotion-evidence'),
    ).inspect(staged.command.evaluationClosureSaid);
    if (closure.kind !== 'Staged') return { kind: 'Blocked', gate: 'Manifest' };
    const evaluationId = closure.closureCommand.closure.evaluationId;
    const locked = await new EvaluationManifestCommandFile(
      join(input.stateRoot, 'evaluation-manifests'),
      randomUUID,
    ).inspect(evaluationId);
    if (locked.kind !== 'Staged') return { kind: 'Blocked', gate: 'Manifest' };
    const { manifest, verifierBundle: verifier } = locked.command;
    if (
      manifest.d !== staged.command.evaluationManifestSaid ||
      manifest.d !== closure.closureCommand.closure.manifestSaid ||
      manifest.originRunId !== input.runId ||
      manifest.ownerAid !== input.task.ownerAid ||
      manifest.taskId !== input.task.taskId ||
      manifest.taskRevisionSaid !== input.task.revisionSaid ||
      manifest.executionProfileSaid !== input.linux.profile.d
    )
      return { kind: 'Blocked', gate: 'Manifest' };
    const baseline = await new BaselineHarnessAdmissionFile(
      join(input.stateRoot, 'harness-admissions'),
    ).readAccepted({
      taskId: input.task.taskId,
      taskRevisionSaid: input.task.revisionSaid,
      harnessSaid: manifest.revisions.H1,
    });
    const winner = await new FileSuccessorTreatmentCustody(input.stateRoot).read(
      evaluationId,
      pointer.activeRevisionSaid,
    );
    if (baseline.kind !== 'Read' || winner.kind !== 'Read')
      return { kind: 'Blocked', gate: 'Treatment' };
    const candidate = winner.candidate;
    if (
      manifest.revisions[candidate.revision.arm] !== candidate.revision.d ||
      candidate.revision.parentRevisionSaid !== baseline.projection.revision.d ||
      candidate.revision.h0Said !== manifest.hypothesisSaid ||
      candidate.revision.sourceInventorySaid !== manifest.sourceInventorySaid
    )
      return { kind: 'Blocked', gate: 'Treatment' };
    const saved = await new FileQualifiedH0Records(
      join(input.stateRoot, 'qualified-h0-records'),
    ).inspectEvaluation(evaluationId);
    if (saved.kind !== 'Read') return { kind: 'Blocked', gate: 'Hypothesis' };
    const document: unknown = JSON.parse(Buffer.from(saved.bytes).toString('utf8'));
    if (
      !record(document) ||
      document.kind !== 'QualifiedH0Progress' ||
      document.evaluationId !== evaluationId ||
      !record(document.window) ||
      typeof document.window.bytesBase64Url !== 'string' ||
      typeof document.selectedReviewArtifactSaid !== 'string'
    )
      return { kind: 'Blocked', gate: 'Hypothesis' };
    const hypothesis = decodeEvolutionHypothesis(document.hypothesis);
    const inventory = decodeEvaluationSourceInventory(document.inventory);
    const bytes = Buffer.from(document.window.bytesBase64Url, 'base64url');
    const window = decodeQualifiedFailureWindow(document.window.artifact, bytes);
    if (
      hypothesis.kind !== 'Accepted' ||
      inventory.kind !== 'Accepted' ||
      window.kind !== 'Accepted' ||
      bytes.toString('base64url') !== document.window.bytesBase64Url ||
      hypothesis.hypothesis.d !== candidate.revision.h0Said ||
      inventory.inventory.d !== manifest.sourceInventorySaid ||
      window.artifact.d !== hypothesis.hypothesis.publicReplay.failureWindowSaid
    )
      return { kind: 'Blocked', gate: 'Hypothesis' };
    const h0 = hypothesis.hypothesis;
    const constructed = {
      hypothesis: h0,
      window: {
        kind: 'Prepared' as const,
        artifact: window.artifact,
        bytes: window.bytes,
        window: window.window,
      },
    };
    const replayRoot = join(input.stateRoot, 'evaluations', evaluationId);
    const publicReplay =
      candidate.replay === undefined
        ? undefined
        : (JSON.parse(Buffer.from(candidate.replay.bytes).toString('utf8')) as unknown);
    if (
      candidate.revision.arm !== 'C1' &&
      (!record(publicReplay) || typeof publicReplay.capturedSourceSaid !== 'string')
    )
      return { kind: 'Blocked', gate: 'Replay' };
    const materialized = await materializeSuccessor(
      {
        expected: {
          parentRevisionSaid: manifest.revisions.H1,
          arm: candidate.revision.arm,
          h0Said: h0.d,
          taskRevisionSaid: input.task.revisionSaid,
          sourceInventorySaid: manifest.sourceInventorySaid,
          executionProfileSaid: manifest.executionProfileSaid,
        },
        h1Bytes: Buffer.from(JSON.stringify(baseline.projection.revision)),
        successorBytes: Buffer.from(JSON.stringify(candidate.revision)),
        configuration: candidate.configuration,
        implementation: candidate.implementation,
        replay: candidate.replay,
      },
      {
        treatmentReview: new ParentSuccessorTreatmentReview(),
        publicReplay: new ParentSuccessorPublicReplay({
          custody: new FileSuccessorReplayCustody(join(replayRoot, 'public-replays')),
          executables: new ExecutableCustody(join(replayRoot, 'executables')),
          conditions: verifier.publicConditions,
          h1Commit: baseline.projection.revision.repository.commit,
          h1Tree: baseline.projection.revision.repository.tree,
          capturedSourceSaid:
            record(publicReplay) && typeof publicReplay.capturedSourceSaid === 'string'
              ? publicReplay.capturedSourceSaid
              : '',
          reviewedRecipeSaid: verifier.reviewedRecipeSaid,
          toolchainSaid: verifier.toolchainSaid,
          containerProfileSaid: manifest.executionProfileSaid,
        }),
      },
    );
    if (materialized.kind !== 'Materialized')
      return { kind: 'Blocked', gate: `Materialization:${materialized.reason}` };
    const mandates = await new AuthorizedLocalTaskMandates({
      local: input.local,
      records: new TaskAuthorizationFile(join(input.stateRoot, 'task-authorizations')),
      issuerAid: input.issuerAid,
      userAlias: devrandomUserAlias,
      now: () => Date.now(),
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      maximumObservations: 300,
    }).prepare({
      user: input.hosted.user,
      task: input.task,
      presentations: input.hosted.presentations,
      grantExpiresAt: input.hosted.grantExpiresAt,
    });
    if (
      mandates.kind !== 'Prepared' ||
      mandates.executionAuthority.personalAgentAid !== manifest.personalAgentAid ||
      mandates.summary.taskMandate.credentialSaid !== manifest.taskMandateSaid
    )
      return { kind: 'Blocked', gate: 'Authority' };
    const review = await new FilePublicAnalogyReviews(
      join(input.stateRoot, 'public-analogy-reviews'),
    ).read(document.selectedReviewArtifactSaid);
    if (
      review.kind !== 'Read' ||
      review.review.episodeSaid !== h0.source.episodeSaid ||
      !input.hosted.contextReady()
    )
      return { kind: 'Blocked', gate: 'Context' };
    const context = input.hosted.context(inventory.inventory);
    const recovery = new QualifiedRunRecovery({
      constructed,
      inventory: inventory.inventory,
      ...context,
      projection: new ReviewedPublicAnalogyProjection([review.review]),
      choice: new PublicAnalogyChoiceReplay(h0.source.episodeSaid),
    });
    const history = new GitCesrPublicHistory(constructed);
    const now = () => new Date().toISOString();
    const currentMandate = new SignifyTaskToolMandate({
      task: input.task,
      personalAgentAid: manifest.personalAgentAid,
      mandateRegistryId: mandates.summary.mandateRegistryId,
      taskMandateSaid: manifest.taskMandateSaid,
      custody: mandates.executionAuthority.taskMandateCustody,
      now,
    });
    return await new TaskResumptionComposition({
      stateRoot: input.stateRoot,
      repositoryDirectory: process.cwd(),
      issuerAid: input.issuerAid,
      modelCredential: new EnvironmentPiCredential({
        CONCENTRATE_API_KEY: process.env.CONCENTRATE_API_KEY,
      }),
      childEnvironment: { path: process.env.PATH ?? '', language: 'C' },
      now,
      sessionId: randomUUID,
      modelTurnId: randomUUID,
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      linux: input.linux,
      ...(input.pauseAfterCheckpoint === undefined
        ? {}
        : { pauseAfterCheckpoint: input.pauseAfterCheckpoint }),
      successorSettlement: new TerminalRunSettlementComposition({
        stateRoot: input.stateRoot,
        evaluationId,
        expectedManifestSaid: manifest.d,
        linux: input.linux,
        now,
      }),
    }).resume(
      {
        ownerAid: input.task.ownerAid,
        runId: input.runId,
        activation: pointer,
        preparation: {
          task: input.task,
          mandates: mandates.summary,
          harness: {
            kind: 'HarnessAdmitted',
            admission: 'Reconciled',
            projection: baseline.projection,
          },
          protectedCredentials: input.hosted.protectedCredentials,
          workAccessRenewal: input.hosted.workAccessRenewal,
          executionAuthority: mandates.executionAuthority,
        },
        runs: input.hosted.runs,
        evidence: input.hosted.evidence,
        authority: {
          verify: async (run) => {
            const fresh = await input.hosted.activationPointer().inspect(input.task.taskId);
            if (
              fresh.kind !== 'Observed' ||
              !isDeepStrictEqual(fresh.pointer, pointer) ||
              run.binding.personalAgentAid !== mandates.executionAuthority.personalAgentAid ||
              Date.parse(input.hosted.grantExpiresAt) <= Date.now()
            )
              return { kind: 'Rejected' };
            const current = await currentMandate.inspect({
              taskRevisionSaid: input.task.revisionSaid,
              taskMandateSaid: manifest.taskMandateSaid,
              tool: 'read_file',
              requiredCapability: 'ReadRepository',
              resource: 'repository://src/lib.rs',
            });
            return { kind: current.kind === 'Current' ? 'Current' : 'Rejected' };
          },
        },
        successorBehavior: (continuation) =>
          new CommittedSuccessorRunBehavior({
            descriptor: materialized.descriptor,
            revision: candidate.revision,
            configuration: candidate.configuration,
            ...(candidate.implementation === undefined
              ? {}
              : { implementation: candidate.implementation }),
            context: continuation,
            recovery,
            history: new ReviewedCurrentRunHistory(
              {
                read: async (request) => {
                  if (request.signal.aborted || request.run.binding.runId !== input.runId)
                    return { kind: 'Rejected' };
                  const read = await history.read({
                    taskId: input.task.taskId,
                    taskRevisionSaid: input.task.revisionSaid,
                    sourceInventorySaid: request.sourceInventorySaid,
                    sourceDirectory: process.cwd(),
                    h1Commit: baseline.projection.revision.repository.commit,
                    h1Tree: baseline.projection.revision.repository.tree,
                    formatMarker: request.formatMarker,
                  });
                  return read.kind === 'Read'
                    ? { kind: 'Read', sources: read.sources }
                    : { kind: 'Rejected' };
                },
              },
              history,
            ),
            now,
          }),
      },
      input.signal,
    );
  } catch {
    return { kind: 'Blocked', gate: input.signal.aborted ? 'Interrupted' : 'Custody' };
  }
}
