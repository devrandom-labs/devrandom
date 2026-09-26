import { verifyTaskMandate, type AdmittedUser, type MandateTask } from '@devrandom/domain';
import { credentialSaid } from '@devrandom/identity';
import { taskMandateV2SchemaSaid, type TaskProjection } from '@devrandom/protocol';

import type { CurrentExperienceMandate } from '../../harness/application/prepare-qualified-source-inventory.js';
import type { CurrentLocalMandates } from '../../mandate/application/local-task-mandates.js';
import type { TaskAuthorizationFile } from '../../mandate/infrastructure/task-authorization-file.js';

function mandateTask(task: TaskProjection): MandateTask {
  return {
    taskId: task.taskId,
    ownerAid: task.ownerAid,
    revisionSaid: task.revisionSaid,
    harnessLineageId: task.harnessLineageId,
    repository: task.revision.repository,
    requestedCapabilities: task.revision.requestedCapabilities,
    unavailableCapabilities: task.revision.unavailableCapabilities,
    budgets: task.revision.budgets,
    evolutionClasses: task.revision.evolutionClasses,
    expiresAt: task.revision.expiresAt,
    ...(task.revision.version === 2 ? { experience: task.revision.constraints.experience } : {}),
  };
}

/** Rechecks current KERIA credential/TEL and local admission against the hosted Task. */
export class SignifyCurrentExperienceMandate implements CurrentExperienceMandate {
  readonly #task: TaskProjection;
  readonly #user: AdmittedUser;
  readonly #records: Pick<TaskAuthorizationFile, 'read'>;
  readonly #local: CurrentLocalMandates;
  readonly #now: () => string;

  constructor(input: {
    readonly task: TaskProjection;
    readonly user: AdmittedUser;
    readonly records: Pick<TaskAuthorizationFile, 'read'>;
    readonly local: CurrentLocalMandates;
    readonly now: () => string;
  }) {
    this.#task = input.task;
    this.#user = input.user;
    this.#records = input.records;
    this.#local = input.local;
    this.#now = input.now;
  }

  async inspect(
    input: Parameters<CurrentExperienceMandate['inspect']>[0],
  ): ReturnType<CurrentExperienceMandate['inspect']> {
    const task = this.#task;
    if (
      task.revision.version !== 2 ||
      input.taskId !== task.taskId ||
      input.taskRevisionSaid !== task.revisionSaid ||
      input.ownerAid !== task.ownerAid ||
      this.#user.principal.aid !== task.ownerAid
    )
      return { kind: 'Denied' };
    try {
      const record = await this.#records.read(task.taskId);
      if (
        record?.stage.kind !== 'Ready' ||
        record.binding.ownerAid !== task.ownerAid ||
        record.binding.taskId !== task.taskId ||
        record.binding.taskRevisionSaid !== task.revisionSaid ||
        record.binding.harnessLineageId !== task.harnessLineageId
      )
        return { kind: 'Denied' };
      const local = await this.#local.establish(this.#user);
      if (
        local.kind !== 'Ready' ||
        local.governance.userAid !== task.ownerAid ||
        local.governance.personalAgentAid !== record.binding.personalAgentAid ||
        local.governance.mandateRegistryId !== record.binding.mandateRegistryId
      )
        return { kind: 'Unavailable' };
      const taskMandateSaid = record.stage.taskMandate.credential.credentialSaid;
      const inspected = await local.custody.inspectCredential({
        credentialSaid: credentialSaid(taskMandateSaid),
      });
      if (inspected.kind !== 'TaskMandate') return { kind: 'Denied' };
      const verified = verifyTaskMandate(
        {
          credential: {
            issuerAid: task.ownerAid,
            issueeAid: record.binding.personalAgentAid,
            registryId: record.binding.mandateRegistryId,
            schemaSaid: taskMandateV2SchemaSaid,
            credentialSaid: taskMandateSaid,
          },
          task: mandateTask(task),
          observedAt: this.#now(),
        },
        inspected.value,
      );
      if (
        verified.kind !== 'Current' ||
        verified.mandate.experience === undefined ||
        !verified.mandate.allowedCapabilities.includes('ReadTaskMemory')
      )
        return { kind: 'Denied' };
      return {
        kind: 'Current',
        mandateSaid: verified.mandate.credential.credentialSaid,
        ownerAid: task.ownerAid,
        taskId: task.taskId,
        taskRevisionSaid: task.revisionSaid,
        repositoryResourceSaid: verified.mandate.experience.repositoryResourceSaid,
        corpusSaid: verified.mandate.experience.corpusSaid,
        disclosure: verified.mandate.experience.disclosure,
      };
    } catch {
      return { kind: 'Unavailable' };
    }
  }
}
