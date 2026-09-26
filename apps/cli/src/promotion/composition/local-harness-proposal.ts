import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { TaskToolCapability } from '@devrandom/domain';
import type { IssuerAid } from '@devrandom/identity';
import type { TaskProjection } from '@devrandom/protocol';
import type { HostedWorkAuthorityAcquisition } from '../../task/application/user-tasks.js';
import type { SignifyLocalMandateAuthority } from '../../mandate/infrastructure/signify-local-mandate-authority.js';
import { AuthorizedLocalTaskMandates } from '../../mandate/application/local-task-mandates.js';
import { TaskAuthorizationFile } from '../../mandate/infrastructure/task-authorization-file.js';
import { devrandomUserAlias } from '../../identity/domain/user-configuration.js';
import { SignifyTaskToolMandate } from '../../run/infrastructure/signify-task-tool-mandate.js';
import {
  proposeHarnessAuthority,
  type HarnessAuthorityProposalRecording,
} from '../application/propose-harness-authority.js';
import { FileHarnessProposalRecords } from '../infrastructure/file-harness-proposal-records.js';
import { JsonHarnessProposalFile } from '../infrastructure/json-harness-proposal-file.js';
export interface LocalHarnessProposalInput {
  readonly stateRoot: string;
  readonly issuerAid: IssuerAid;
  readonly hosted: Extract<HostedWorkAuthorityAcquisition, { kind: 'Authorized' }>;
  readonly local: SignifyLocalMandateAuthority;
  readonly task: TaskProjection;
  readonly path: string;
  readonly signal: AbortSignal;
}
/** Operator-injected attempt, attributed honestly and checked against fresh admitted personal-agent custody and TEL. */
export async function proposeLocalHarness(
  input: LocalHarnessProposalInput,
): Promise<HarnessAuthorityProposalRecording> {
  try {
    input.signal.throwIfAborted();
    if (
      input.task.ownerAid !== input.hosted.user.principal.aid ||
      Date.parse(input.hosted.grantExpiresAt) <= Date.now()
    )
      return { kind: 'Blocked', gate: 'Authority' };
    const decoded = await new JsonHarnessProposalFile().read(input.path);
    if (decoded.kind !== 'Accepted') return { kind: 'Blocked', gate: 'Proposal' };
    const pointer = await input.hosted.activationPointer().inspect(input.task.taskId);
    if (pointer.kind !== 'Observed' || pointer.pointer.taskRevisionSaid !== input.task.revisionSaid)
      return { kind: 'Blocked', gate: 'Activation' };
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
    if (mandates.kind !== 'Prepared') return { kind: 'Blocked', gate: 'Authority' };
    const now = () => new Date().toISOString();
    const mandate = new SignifyTaskToolMandate({
      task: input.task,
      personalAgentAid: mandates.executionAuthority.personalAgentAid,
      mandateRegistryId: mandates.summary.mandateRegistryId,
      taskMandateSaid: mandates.summary.taskMandate.credentialSaid,
      custody: mandates.executionAuthority.taskMandateCustody,
      now,
    });
    const outcome = await proposeHarnessAuthority(decoded.proposal, {
      authority: {
        inspect: async () => {
          input.signal.throwIfAborted();
          const fresh = await mandate.inspect({
            taskRevisionSaid: input.task.revisionSaid,
            taskMandateSaid: mandates.summary.taskMandate.credentialSaid,
            tool: 'read_file',
            requiredCapability: 'ReadRepository',
            resource: 'repository://src/lib.rs',
          });
          if (fresh.kind !== 'Current') return { kind: 'Rejected' };
          return {
            kind: 'Current',
            ownerAid: input.task.ownerAid,
            personalAgentAid: mandates.executionAuthority.personalAgentAid,
            taskMandateSaid: fresh.mandateSaid,
            taskRevisionSaid: input.task.revisionSaid,
            activeRevisionSaid: pointer.pointer.activeRevisionSaid,
            pointerVersion: pointer.pointer.pointerVersion,
            taskCapabilities: input.task.revision.requestedCapabilities.flatMap(
              (capability): TaskToolCapability[] =>
                capability === 'ReadTaskMemory' ? [] : [capability],
            ),
            unavailableCapabilities: input.task.revision.unavailableCapabilities.flatMap(
              (capability): TaskToolCapability[] =>
                capability === 'ReadTaskMemory' ? [] : [capability],
            ),
            mandateCapabilities: fresh.allowedCapabilities,
          };
        },
      },
      records: new FileHarnessProposalRecords(join(input.stateRoot, 'harness-proposals')),
      now,
    });
    const after = await input.hosted.activationPointer().inspect(input.task.taskId);
    if (after.kind !== 'Observed' || !isDeepStrictEqual(after.pointer, pointer.pointer))
      return { kind: 'Blocked', gate: 'ActivePointerChanged' };
    return outcome;
  } catch {
    return { kind: 'Blocked', gate: input.signal.aborted ? 'Interrupted' : 'Custody' };
  }
}
