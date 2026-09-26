import { createHash } from 'node:crypto';

import { validateExecutionBinding } from '@devrandom/domain';
import { decodeEvaluationManifest, type EvaluationManifest } from '@devrandom/protocol';

import type {
  ActiveToolBinding,
  CurrentToolMandate,
  ToolResourceScope,
} from '../../tool-gateway/tool-gateway.js';
import type { C2ProvisionalSubmissionAuthority } from '../application/c2-workflow-transition.js';
import type { CurrentEvaluationProposalCapacity } from '../application/current-evaluation-proposal-capacity.js';
import type { EvaluationLease } from '../application/evaluation-conversations.js';

export interface ProvisionalSubmissionAuthorizationDependencies {
  readonly manifest: EvaluationManifest;
  readonly activeTools: readonly ActiveToolBinding[];
  readonly resources: ToolResourceScope;
  readonly mandate: CurrentToolMandate;
  readonly lease: EvaluationLease;
  readonly capacity: CurrentEvaluationProposalCapacity;
}

const said = /^[A-Z][A-Za-z0-9_-]{43}$/u;

function submissionResource(artifactSaids: readonly string[]): string {
  const digest = createHash('sha256').update(artifactSaids.join('\u0000')).digest('hex');
  return `submission://sha256:${digest}`;
}

function interrupted(signal: AbortSignal): boolean {
  return signal.aborted;
}

/** An Evaluation-owned pre-effect check. The final ToolAuthorization event is written only
 * after the worker stops and the exact source passes the original public verifier. */
export class ProvisionalSubmissionAuthorization implements C2ProvisionalSubmissionAuthority {
  readonly #dependencies: ProvisionalSubmissionAuthorizationDependencies;
  #used = false;

  constructor(dependencies: ProvisionalSubmissionAuthorizationDependencies) {
    this.#dependencies = dependencies;
  }

  async authorize(
    input: Parameters<C2ProvisionalSubmissionAuthority['authorize']>[0],
  ): ReturnType<C2ProvisionalSubmissionAuthority['authorize']> {
    if (this.#used) return { kind: 'Denied' };
    this.#used = true;
    const { binding, proposal, signal } = input;
    const manifest = this.#dependencies.manifest;
    const phase = binding.phase;
    if (
      signal.aborted ||
      validateExecutionBinding(binding).kind !== 'Accepted' ||
      decodeEvaluationManifest(manifest).kind !== 'Accepted' ||
      phase.kind !== 'Trial' ||
      phase.arm !== 'C2' ||
      phase.manifestSaid !== manifest.d ||
      phase.attempt !== 1 ||
      !manifest.slots.some(
        (slot) =>
          slot.arm === phase.arm &&
          slot.repetition === phase.repetition &&
          slot.attempt === phase.attempt,
      ) ||
      binding.evaluationId !== manifest.evaluationId ||
      binding.taskId !== manifest.taskId ||
      binding.taskRevisionSaid !== manifest.taskRevisionSaid ||
      binding.originRunId !== manifest.originRunId ||
      binding.personalAgentAid !== manifest.personalAgentAid ||
      binding.taskMandateSaid !== manifest.taskMandateSaid ||
      binding.harnessRevisionSaid !== manifest.revisions.C2 ||
      proposal.input.kind !== 'SubmitResult' ||
      !Number.isSafeInteger(proposal.proposalIndex) ||
      proposal.proposalIndex < 0 ||
      proposal.piSessionId.length === 0 ||
      proposal.modelTurnId.length === 0 ||
      proposal.toolCallId.length === 0 ||
      proposal.input.artifactSaids.length > 32 ||
      new Set(proposal.input.artifactSaids).size !== proposal.input.artifactSaids.length ||
      proposal.input.artifactSaids.some((artifact) => !said.test(artifact)) ||
      this.#dependencies.activeTools.filter((tool) => tool.name === 'submit_result').length !== 1 ||
      !this.#dependencies.activeTools.some(
        (tool) => tool.name === 'submit_result' && tool.requiredCapability === 'SubmitResult',
      )
    )
      return { kind: 'Denied' };
    try {
      const resource = this.#dependencies.resources.resolve(proposal);
      if (
        resource.kind !== 'Resolved' ||
        resource.resource !== submissionResource(proposal.input.artifactSaids)
      )
        return { kind: 'Denied' };
      const mandate = await this.#dependencies.mandate.inspect({
        taskRevisionSaid: binding.taskRevisionSaid,
        taskMandateSaid: binding.taskMandateSaid,
        tool: 'submit_result',
        requiredCapability: 'SubmitResult',
        resource: resource.resource,
      });
      if (
        mandate.kind !== 'Current' ||
        mandate.mandateSaid !== binding.taskMandateSaid ||
        !mandate.allowedCapabilities.includes('SubmitResult')
      )
        return { kind: 'Denied' };
      const lease = await this.#dependencies.lease.inspect(binding);
      if (lease.kind !== 'Held') return { kind: 'Denied' };
      const capacity = await this.#dependencies.capacity.inspect(binding);
      return capacity.kind === 'Available' && !interrupted(signal)
        ? { kind: 'Authorized' }
        : { kind: 'Denied' };
    } catch {
      return { kind: 'Denied' };
    }
  }
}
