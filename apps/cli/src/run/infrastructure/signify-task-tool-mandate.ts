import {
  taskBudgetCeilings,
  verifyTaskMandate,
  type MandateTask,
  type TaskToolCapability,
} from '@devrandom/domain';
import {
  credentialSaid,
  type LocalMandateCustody,
  type MandateInspection,
} from '@devrandom/identity';
import {
  taskMandateSchemaSaid,
  taskMandateV2SchemaSaid,
  taskMandateV3SchemaSaid,
  type TaskProjection,
} from '@devrandom/protocol';
import type { CurrentToolMandate, CurrentToolMandateInspection } from '@devrandom/runtime';

export interface SignifyTaskToolMandateOptions {
  readonly task: TaskProjection;
  readonly personalAgentAid: string;
  readonly mandateRegistryId: string;
  readonly taskMandateSaid: string;
  readonly custody: Pick<LocalMandateCustody, 'inspectCredential'>;
  now(): string;
}

const repositoryResourcePattern = new RegExp(
  '^repository://(?!/)(?!.*//)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*(?:^|/)\\.(?:/|$))[^/]+(?:/[^/]+)*$',
  'u',
);
const commandResourcePattern = /^command:\/\/[a-z][a-z0-9-]{0,62}@[A-Z][A-Za-z0-9_-]{43}$/u;
const submissionResourcePattern = /^submission:\/\/sha256:[a-f0-9]{64}$/u;

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

function resourceMatches(capability: TaskToolCapability, resource: string): boolean {
  switch (capability) {
    case 'ReadRepository':
    case 'EditRepository':
      return repositoryResourcePattern.test(resource) && resourceCharactersAreSafe(resource);
    case 'RunFormatter':
    case 'RunStaticAnalysis':
    case 'RunTests':
      return commandResourcePattern.test(resource);
    case 'SubmitResult':
      return submissionResourcePattern.test(resource);
  }
}

function resourceCharactersAreSafe(resource: string): boolean {
  for (const character of resource) {
    const codePoint = character.codePointAt(0);
    if (
      character === '\\' ||
      codePoint === undefined ||
      codePoint <= 31 ||
      (codePoint >= 127 && codePoint <= 159)
    ) {
      return false;
    }
  }
  return true;
}

export class SignifyTaskToolMandate implements CurrentToolMandate {
  readonly #options: SignifyTaskToolMandateOptions;

  constructor(options: SignifyTaskToolMandateOptions) {
    this.#options = options;
  }

  async inspect(input: {
    readonly taskRevisionSaid: string;
    readonly taskMandateSaid: string;
    readonly tool: Parameters<CurrentToolMandate['inspect']>[0]['tool'];
    readonly requiredCapability: TaskToolCapability;
    readonly resource: string;
  }): Promise<CurrentToolMandateInspection> {
    try {
      const inspected: MandateInspection = await this.#options.custody.inspectCredential({
        credentialSaid: credentialSaid(this.#options.taskMandateSaid),
      });
      if (inspected.kind !== 'TaskMandate') {
        return { kind: 'Unavailable' };
      }
      const verification = verifyTaskMandate(
        {
          credential: {
            issuerAid: this.#options.task.ownerAid,
            issueeAid: this.#options.personalAgentAid,
            registryId: this.#options.mandateRegistryId,
            schemaSaid:
              this.#options.task.revision.version === 2
                ? this.#options.task.revision.budgets.runsPerAdmittedUser >
                  taskBudgetCeilings.runsPerAdmittedUser
                  ? taskMandateV3SchemaSaid
                  : taskMandateV2SchemaSaid
                : taskMandateSchemaSaid,
            credentialSaid: this.#options.taskMandateSaid,
          },
          task: mandateTask(this.#options.task),
          observedAt: new Date(this.#options.now()).toISOString(),
        },
        inspected.value,
      );
      if (verification.kind === 'Invalid') {
        if (verification.invalidity.kind === 'Expired') {
          return { kind: 'Expired' };
        }
        return verification.invalidity.kind === 'CredentialRevoked'
          ? { kind: 'Revoked' }
          : { kind: 'Unavailable' };
      }
      const exactRequest =
        input.taskRevisionSaid === this.#options.task.revisionSaid &&
        input.taskMandateSaid === this.#options.taskMandateSaid &&
        resourceMatches(input.requiredCapability, input.resource) &&
        verification.mandate.allowedCapabilities.includes(input.requiredCapability);
      return {
        kind: 'Current',
        mandateSaid: verification.mandate.credential.credentialSaid,
        allowedCapabilities: exactRequest
          ? verification.mandate.allowedCapabilities.flatMap((capability): TaskToolCapability[] =>
              capability === 'ReadTaskMemory' ? [] : [capability],
            )
          : [],
      };
    } catch {
      return { kind: 'Unavailable' };
    }
  }
}
