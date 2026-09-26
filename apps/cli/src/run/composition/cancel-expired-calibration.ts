import { join } from 'node:path';
import type { IssuerAid } from '@devrandom/identity';
import type { TaskProjection } from '@devrandom/protocol';
import type { HostedWorkAuthorityAcquisition } from '../../task/application/user-tasks.js';
import type { SignifyLocalMandateAuthority } from '../../mandate/infrastructure/signify-local-mandate-authority.js';
import { TaskAuthorizationFile } from '../../mandate/infrastructure/task-authorization-file.js';
import { BaselineHarnessAdmissionFile } from '../../harness/infrastructure/baseline-harness-admission-file.js';
import { TerminalCalibrationComposition } from './terminal-calibration.js';
import type { TerminalCalibrationReconciliation } from '../application/terminal-calibration-reconciliation.js';

/** Explicit owner cancellation: reads historical custody, never renews execution authority. */
export async function cancelExpiredCalibrationRun(input: {
  readonly stateRoot: string;
  readonly issuerAid: IssuerAid;
  readonly hosted: Extract<HostedWorkAuthorityAcquisition, { kind: 'Authorized' }>;
  readonly local: SignifyLocalMandateAuthority;
  readonly task: TaskProjection;
  readonly runId: string;
  readonly signal: AbortSignal;
}): Promise<
  TerminalCalibrationReconciliation | { readonly kind: 'Blocked'; readonly gate: string }
> {
  try {
    input.signal.throwIfAborted();
    if (
      input.task.ownerAid !== input.hosted.user.principal.aid ||
      Date.parse(input.task.revision.expiresAt) > Date.now()
    )
      return { kind: 'Blocked', gate: 'ExpiredOwnerTask' };
    const hosted = await input.hosted.runs.inspect(input.runId);
    if (
      hosted.kind !== 'Found' ||
      hosted.run.taskId !== input.task.taskId ||
      hosted.run.taskRevisionSaid !== input.task.revisionSaid
    )
      return { kind: 'Blocked', gate: 'Run' };
    const authorization = await new TaskAuthorizationFile(
      join(input.stateRoot, 'task-authorizations'),
    ).read(input.task.taskId);
    if (
      authorization?.stage.kind !== 'Ready' ||
      authorization.binding.ownerAid !== input.task.ownerAid ||
      authorization.binding.taskRevisionSaid !== input.task.revisionSaid ||
      authorization.binding.harnessLineageId !== input.task.harnessLineageId ||
      authorization.binding.issuerAid !== input.issuerAid
    )
      return { kind: 'Blocked', gate: 'HistoricalAuthorization' };
    const harness = await new BaselineHarnessAdmissionFile(
      join(input.stateRoot, 'harness-admissions'),
    ).readAccepted({
      taskId: input.task.taskId,
      taskRevisionSaid: input.task.revisionSaid,
      harnessSaid: hosted.run.harnessRevisionSaid,
    });
    if (harness.kind !== 'Read') return { kind: 'Blocked', gate: 'Harness' };
    const custody = await input.local.historicalEvidenceSeal(input.hosted.user);
    if (
      custody.kind !== 'Connected' ||
      custody.profile.personalAgentAid !== authorization.binding.personalAgentAid ||
      custody.profile.governorAid !== authorization.binding.governorAid ||
      custody.profile.mandateRegistryId !== authorization.binding.mandateRegistryId
    )
      return { kind: 'Blocked', gate: 'OriginalSigner' };
    return await new TerminalCalibrationComposition({
      stateRoot: input.stateRoot,
      issuerAid: input.issuerAid,
      now: () => new Date().toISOString(),
      wait: (milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
    }).reconcile(
      {
        intent: 'CancelExpiredRun',
        user: input.hosted.user,
        task: input.task,
        harness: harness.projection.revision,
        runId: input.runId,
        runs: input.hosted.runs,
        evidence: input.hosted.evidence,
        protectedCredentials: input.hosted.protectedCredentials,
        signer: {
          personalAgentAid: custody.profile.personalAgentAid,
          governorAid: custody.profile.governorAid,
          taskMandateSaid: authorization.stage.taskMandate.credential.credentialSaid,
          promotionMandateSaid: authorization.stage.promotionMandate.credential.credentialSaid,
          evidenceSealExchange: custody.exchange,
        },
      },
      input.signal,
    );
  } catch {
    return { kind: 'Unavailable' };
  }
}
