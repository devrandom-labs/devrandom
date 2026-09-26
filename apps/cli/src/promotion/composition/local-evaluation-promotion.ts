import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { EvaluationExecutionBinding } from '@devrandom/domain';
import type { IssuerAid } from '@devrandom/identity';
import type { TaskProjection, TrialObservationEvidence } from '@devrandom/protocol';
import {
  authorizePromotion,
  AcceptedConcentrateProviderUsage,
  AcceptedParentTrialUsage,
  type PromotionAuthorizationDependencies,
  type EvaluationAcceptedPrefix,
  type EvaluationMeasurementReceipts,
} from '@devrandom/runtime';
import type { HostedWorkAuthorityAcquisition } from '../../task/application/user-tasks.js';
import type { SignifyLocalMandateAuthority } from '../../mandate/infrastructure/signify-local-mandate-authority.js';
import { TaskAuthorizationFile } from '../../mandate/infrastructure/task-authorization-file.js';
import { authorizeExactPromotionMandate } from '../../mandate/application/exact-promotion-authorization.js';
import { devrandomUserAlias } from '../../identity/domain/user-configuration.js';
import { EvaluationManifestCommandFile } from '../../harness/infrastructure/evaluation-manifest-command-file.js';
import { BaselineHarnessAdmissionFile } from '../../harness/infrastructure/baseline-harness-admission-file.js';
import { SqliteEvaluationEvidenceOutbox } from '../../harness/infrastructure/sqlite-evaluation-evidence-outbox.js';
import { SqliteProtectedCaseKeyCustody } from '../../harness/infrastructure/sqlite-protected-case-key-custody.js';
import { PromotionEvidenceFile } from '../infrastructure/promotion-evidence-file.js';
import { PromotionCommandFile } from '../infrastructure/promotion-command-file.js';
import { ServerPromotionEvidence } from '../infrastructure/server-promotion-evidence.js';
import { SignifyExactPromotionAuthority } from '../infrastructure/signify-exact-promotion-authority.js';
import { signifyLocalPromotionSigning } from '../infrastructure/signify-local-promotion-signing.js';
import { regradeProtectedCesrObservation } from '../application/regrade-protected-cesr-observation.js';
import { assembleReviewedPromotionEvidence } from '../application/assemble-reviewed-promotion-evidence.js';
import {
  activateReviewedSuccessor,
  type ReviewedSuccessorActivation,
} from '../application/activate-reviewed-successor.js';

export interface LocalEvaluationPromotionInput {
  readonly stateRoot: string;
  readonly issuerAid: IssuerAid;
  readonly hosted: Extract<HostedWorkAuthorityAcquisition, { kind: 'Authorized' }>;
  readonly local: SignifyLocalMandateAuthority;
  readonly task: TaskProjection;
  readonly evaluationId: string;
  readonly closureSaid: string;
  readonly commandId: string;
  readonly confirmation?: { readonly manifestSaid: string; readonly closureSaid: string };
  readonly signal: AbortSignal;
}
export type LocalEvaluationPromotion =
  | ReviewedSuccessorActivation
  | {
      readonly kind: 'Blocked';
      readonly gate: 'Custody' | 'Authority' | 'UserConfirmation' | 'Evidence' | 'Interrupted';
    };

/** Concrete local control plane: protected replay, exact user authority, separate EXNs and hosted CAS. */
export async function promoteLocalEvaluation(
  input: LocalEvaluationPromotionInput,
): Promise<LocalEvaluationPromotion> {
  let outbox: SqliteEvaluationEvidenceOutbox | undefined;
  let keys: SqliteProtectedCaseKeyCustody | undefined;
  try {
    input.signal.throwIfAborted();
    if (input.task.ownerAid !== input.hosted.user.principal.aid)
      return { kind: 'Blocked', gate: 'Authority' };
    const manifests = new EvaluationManifestCommandFile(
      join(input.stateRoot, 'evaluation-manifests'),
      randomUUID,
    );
    const locked = await manifests.inspect(input.evaluationId);
    if (locked.kind !== 'Staged') return { kind: 'Blocked', gate: 'Custody' };
    const { manifest, verifierBundle: verifier } = locked.command;
    if (
      manifest.taskId !== input.task.taskId ||
      manifest.taskRevisionSaid !== input.task.revisionSaid ||
      manifest.ownerAid !== input.task.ownerAid
    )
      return { kind: 'Blocked', gate: 'Custody' };
    if (
      input.confirmation?.manifestSaid !== manifest.d ||
      input.confirmation.closureSaid !== input.closureSaid
    )
      return { kind: 'Blocked', gate: 'UserConfirmation' };
    const staging = new PromotionEvidenceFile(join(input.stateRoot, 'promotion-evidence'));
    const closure = await staging.inspect(input.closureSaid);
    if (
      closure.kind !== 'Staged' ||
      closure.closureCommand.closure.evaluationId !== manifest.evaluationId ||
      closure.closureCommand.closure.manifestSaid !== manifest.d
    )
      return { kind: 'Blocked', gate: 'Custody' };
    const local = await input.local.establish(input.hosted.user);
    if (
      local.kind !== 'Ready' ||
      local.governance.userAid !== manifest.ownerAid ||
      local.governance.personalAgentAid !== manifest.personalAgentAid
    )
      return { kind: 'Blocked', gate: 'Authority' };
    const initial = await new TaskAuthorizationFile(
      join(input.stateRoot, 'task-authorizations'),
    ).read(input.task.taskId);
    if (initial?.stage.kind !== 'Ready') return { kind: 'Blocked', gate: 'Authority' };
    const granted = await authorizeExactPromotionMandate(
      {
        task: input.task,
        manifest,
        initialReadyAuthorization: { ...initial, stage: initial.stage },
        governance: local.governance,
        issuerAid: input.issuerAid,
        userAlias: devrandomUserAlias,
        workAccessExpiresAt: input.hosted.grantExpiresAt,
      },
      {
        recordsForManifest: (said, ready) =>
          new TaskAuthorizationFile(join(input.stateRoot, 'exact-promotion', said), ready),
        custody: local.custody,
        presentations: input.hosted.presentations,
        now: () => Date.now(),
        wait: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
        maximumObservations: 300,
      },
    );
    if (granted.kind !== 'Ready') return { kind: 'Blocked', gate: 'Authority' };
    input.signal.throwIfAborted();
    const authority = new SignifyExactPromotionAuthority({
      task: input.task,
      authorization: granted.authorization,
      custody: local.custody,
      confirmation: input.confirmation,
      now: () => new Date().toISOString(),
    });
    const current = await authority.verify({
      taskId: input.task.taskId,
      taskRevisionSaid: input.task.revisionSaid,
      harnessLineageId: input.task.harnessLineageId,
      ownerAid: input.task.ownerAid,
      governorAid: local.governance.governorAid,
      evaluationManifestSaid: manifest.d,
      evaluationClosureSaid: input.closureSaid,
    });
    if (current.kind !== 'Current') return { kind: 'Blocked', gate: 'Authority' };
    const pointer = input.hosted.activationPointer();
    const observed = await pointer.inspect(input.task.taskId);
    if (observed.kind !== 'Observed') return { kind: 'Blocked', gate: 'Authority' };
    const commands = new PromotionCommandFile(join(input.stateRoot, 'promotion-commands'));
    const stagedCommand = await commands.inspect(input.commandId);
    const retry =
      observed.pointer.kind === 'Committed' &&
      observed.pointer.commandId === input.commandId &&
      stagedCommand.kind === 'Staged'
        ? stagedCommand.command
        : undefined;
    if (
      retry !== undefined &&
      (retry.taskId !== input.task.taskId ||
        retry.taskRevisionSaid !== input.task.revisionSaid ||
        retry.harnessLineageId !== input.task.harnessLineageId ||
        retry.evaluationClosureSaid !== input.closureSaid ||
        retry.evaluationManifestSaid !== manifest.d)
    )
      return { kind: 'Blocked', gate: 'Evidence' };
    const expectation =
      retry === undefined
        ? observed.pointer
        : {
            taskId: retry.taskId,
            taskRevisionSaid: retry.taskRevisionSaid,
            harnessLineageId: retry.harnessLineageId,
            activeRevisionSaid: retry.expectedIncumbentRevisionSaid,
            pointerVersion: retry.expectedPointerVersion,
          };

    const binding: EvaluationExecutionBinding = {
      kind: 'Evaluation',
      evaluationId: manifest.evaluationId,
      evaluationLeaseId: closure.index.lease.leaseId,
      evidenceStreamId: closure.closureCommand.closure.evidenceStreamId,
      originRunId: manifest.originRunId,
      taskId: manifest.taskId,
      taskRevisionSaid: manifest.taskRevisionSaid,
      personalAgentAid: manifest.personalAgentAid,
      taskMandateSaid: manifest.taskMandateSaid,
      harnessRevisionSaid: manifest.revisions.H1,
      phase: {
        kind: 'Trial',
        manifestSaid: manifest.d,
        arm: 'H1TaskSearch',
        repetition: 3,
        attempt: 2,
      },
    };
    await lstat(join(input.stateRoot, 'evaluations', manifest.evaluationId, 'outbox.sqlite'));
    const opened = SqliteEvaluationEvidenceOutbox.open(input.stateRoot, {
      ownerAid: manifest.ownerAid,
      evaluationId: manifest.evaluationId,
      streamId: binding.evidenceStreamId,
      originRunId: manifest.originRunId,
      taskId: manifest.taskId,
      taskRevisionSaid: manifest.taskRevisionSaid,
      personalAgentAid: manifest.personalAgentAid,
      taskMandateSaid: manifest.taskMandateSaid,
    });
    if (opened.kind !== 'Opened') return { kind: 'Blocked', gate: 'Custody' };
    outbox = opened.outbox;
    const key = SqliteProtectedCaseKeyCustody.reopen(input.stateRoot, {
      ownerAid: manifest.ownerAid,
      evaluationId: manifest.evaluationId,
      personalAgentAid: manifest.personalAgentAid,
      taskId: manifest.taskId,
      taskMandateSaid: manifest.taskMandateSaid,
    });
    if (key.kind !== 'Opened') return { kind: 'Blocked', gate: 'Custody' };
    keys = key.custody;
    const baseline = await new BaselineHarnessAdmissionFile(
      join(input.stateRoot, 'harness-admissions'),
    ).readAccepted({
      taskId: manifest.taskId,
      taskRevisionSaid: manifest.taskRevisionSaid,
      harnessSaid: manifest.revisions.H1,
    });
    if (baseline.kind !== 'Read') return { kind: 'Blocked', gate: 'Custody' };
    const reading = new ServerPromotionEvidence(input.hosted.evaluations);
    const prefix = await reading.openPrefix({
      binding,
      throughSequence: closure.closureCommand.closure.acceptedEventCount - 1,
      headSaid: closure.closureCommand.closure.acceptedHeadSaid,
    });
    if (prefix.kind !== 'Acknowledged') return { kind: 'Blocked', gate: 'Evidence' };
    const events = prefix.events;
    const head = events.at(-1);
    if (head === undefined) return { kind: 'Blocked', gate: 'Evidence' };
    const accepted: EvaluationAcceptedPrefix = {
      open: () =>
        Promise.resolve({
          kind: 'Acknowledged',
          events,
          throughSequence: head.sequence,
          headSaid: head.d,
        }),
    };
    const receipts: EvaluationMeasurementReceipts = {
      openPublic: (request) => reading.openPublic(request),
      verifyProviderUsage: (request) => {
        const source = events.find((event) => event.d === request.usageEventSaid);
        if (source === undefined) return Promise.resolve({ kind: 'Missing' });
        return new AcceptedConcentrateProviderUsage({
          binding: {
            ...binding,
            phase: source.phase,
            harnessRevisionSaid: source.harnessRevisionSaid,
          },
          accepted,
          openPublic: (request) => reading.openPublic(request),
        }).verifyProviderUsage(request);
      },
    };
    const usage = new AcceptedParentTrialUsage({
      commands: [
        ...baseline.projection.revision.completionCommands,
        ...(baseline.projection.revision.toolCommands ?? []),
      ],
      accepted: {
        openPrefix: async (request) => {
          const read = await reading.openPrefix(request);
          return read.kind === 'Acknowledged'
            ? { ...read, throughSequence: request.throughSequence, headSaid: request.headSaid }
            : read;
        },
      },
      receipts,
    });
    const regrading = {
      regrade: ({ trial }: { trial: TrialObservationEvidence }) =>
        regradeProtectedCesrObservation(
          { manifest, verifier, trial },
          { custody: key.custody, ciphertext: opened.outbox },
        ),
    };
    const remeasure = async (trial: TrialObservationEvidence) => {
      const captured = events.find(
        (event) =>
          event.detail.kind === 'ArtifactCaptured' &&
          event.detail.artifactSaid === trial.protectedObservationSaid &&
          event.detail.custody === 'ProtectedCiphertext',
      );
      if (captured === undefined) return { kind: 'Incomplete' as const };
      const measured = await usage.measure({
        binding: {
          ...binding,
          harnessRevisionSaid: trial.harnessRevisionSaid,
          phase: { kind: 'Trial', manifestSaid: manifest.d, ...trial.observation.slot },
        },
        trialEvidenceHeadSaid: trial.trialEvidenceHeadSaid,
        providerUsageEventSaids: trial.providerUsageEventSaids,
        protectedObservationSaid: trial.protectedObservationSaid,
        custodyEvidenceHeadSaid: captured.d,
        custodyEvidenceSequence: captured.sequence,
      });
      return measured.kind === 'Verified'
        ? { kind: 'Verified' as const, usage: measured.usage }
        : { kind: 'Incomplete' as const };
    };
    const evidence = await assembleReviewedPromotionEvidence(
      {
        task: input.task,
        manifest,
        verifier,
        closureSaid: input.closureSaid,
        binding,
        pointer: expectation,
        mandate: current.mandate,
      },
      {
        staging,
        hosted: input.hosted.evaluations,
        reading,
        audit: { reading, regrading, usage: { remeasure } },
        receipts,
      },
    );
    if (evidence.kind !== 'Verified') return { kind: 'Blocked', gate: 'Evidence' };
    input.signal.throwIfAborted();
    const signing = signifyLocalPromotionSigning({
      exchanges: local.promotionExchanges,
      agentAid: local.governance.personalAgentAid,
      governorAid: local.governance.governorAid,
      ownerAid: local.governance.userAid,
      issuerAid: input.issuerAid,
      authority,
      confirm: ({ decision }) =>
        Promise.resolve(
          decision.evaluationManifestSaid === input.confirmation?.manifestSaid &&
            decision.evaluationClosureSaid === input.confirmation.closureSaid
            ? 'Confirmed'
            : 'Pending',
        ),
      now: () => Date.now(),
    });
    const authorization: PromotionAuthorizationDependencies = {
      evidence: {
        inspect: (said) =>
          Promise.resolve(said === input.closureSaid ? evidence : { kind: 'Incomplete' }),
      },
      authority,
      ...signing,
      commands,
      hosted: input.hosted.activation(
        local.activationReceipts,
        input.issuerAid,
        local.governance.personalAgentAid,
      ),
      routing: {
        activate: async (committed) => {
          const fresh = await pointer.inspect(committed.taskId);
          return fresh.kind === 'Observed' &&
            fresh.pointer.kind === 'Committed' &&
            fresh.pointer.disposition === 'Activated' &&
            fresh.pointer.activeRevisionSaid === committed.revisionSaid &&
            fresh.pointer.pointerVersion === committed.pointerVersion &&
            fresh.pointer.decisionReceiptSaid === committed.decisionReceiptSaid
            ? 'Routed'
            : 'Pending';
        },
      },
    };
    // A lost reply reuses the durable original CAS expectation, never the newly advanced pointer.
    if (retry !== undefined)
      return await authorizePromotion(
        {
          commandId: input.commandId,
          taskId: retry.taskId,
          taskRevisionSaid: retry.taskRevisionSaid,
          harnessLineageId: retry.harnessLineageId,
          expectedIncumbentRevisionSaid: retry.expectedIncumbentRevisionSaid,
          expectedPointerVersion: retry.expectedPointerVersion,
          evaluationClosureSaid: retry.evaluationClosureSaid,
          governorAid: local.governance.governorAid,
        },
        authorization,
      );
    return await activateReviewedSuccessor(
      {
        task: input.task,
        commandId: input.commandId,
        closureSaid: input.closureSaid,
        governorAid: local.governance.governorAid,
      },
      { pointer, authorization },
    );
  } catch {
    return { kind: 'Blocked', gate: input.signal.aborted ? 'Interrupted' : 'Custody' };
  } finally {
    outbox?.close();
    keys?.close();
  }
}
