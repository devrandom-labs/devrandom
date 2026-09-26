import { validateExecutionBinding, type EvaluationExecutionBinding } from '@devrandom/domain';
import { decodeEvaluationManifest, type EvaluationManifest } from '@devrandom/protocol';

import {
  toolBinding,
  type ActiveToolBinding,
  type CurrentToolMandate,
  type ToolEffects,
  type ToolGatewayOutcome,
  type ToolGatewayProposal,
  type ToolResourceScope,
} from '../../tool-gateway/tool-gateway.js';
import type { CurrentEvaluationProposalCapacity } from './current-evaluation-proposal-capacity.js';
import type { EvaluationLease, EvaluationToolGateway } from './evaluation-conversations.js';

function interrupted(signal: AbortSignal): boolean {
  return signal.aborted;
}

export interface AuthorizedEvaluationToolsDependencies {
  readonly manifest: EvaluationManifest;
  readonly activeTools: readonly ActiveToolBinding[];
  readonly resources: ToolResourceScope;
  readonly mandate: CurrentToolMandate;
  readonly lease: EvaluationLease;
  readonly capacity: CurrentEvaluationProposalCapacity;
  readonly effects: ToolEffects;
  now(): number;
}

/** Evaluation authorization stays in the trusted parent. The trial relay records the
 * proposal before this check and records the exact authorization and effect afterward. */
export class AuthorizedEvaluationTools implements EvaluationToolGateway {
  readonly #used = new Set<string>();
  readonly #dependencies: AuthorizedEvaluationToolsDependencies;
  constructor(dependencies: AuthorizedEvaluationToolsDependencies) {
    this.#dependencies = dependencies;
  }

  async propose(
    binding: EvaluationExecutionBinding,
    proposal: ToolGatewayProposal,
    signal: AbortSignal,
  ): Promise<ToolGatewayOutcome> {
    const { manifest } = this.#dependencies;
    const phase = binding.phase;
    if (
      validateExecutionBinding(binding).kind !== 'Accepted' ||
      decodeEvaluationManifest(manifest).kind !== 'Accepted' ||
      phase.kind !== 'Trial' ||
      phase.manifestSaid !== manifest.d ||
      binding.evaluationId !== manifest.evaluationId ||
      binding.originRunId !== manifest.originRunId ||
      binding.taskId !== manifest.taskId ||
      binding.taskRevisionSaid !== manifest.taskRevisionSaid ||
      binding.personalAgentAid !== manifest.personalAgentAid ||
      binding.taskMandateSaid !== manifest.taskMandateSaid ||
      binding.harnessRevisionSaid !==
        manifest.revisions[phase.arm === 'H1TaskSearch' ? 'H1' : phase.arm] ||
      !manifest.slots.some(
        (slot) =>
          slot.arm === phase.arm &&
          slot.repetition === phase.repetition &&
          slot.attempt === phase.attempt,
      )
    )
      return { kind: 'EvidenceIntegrityFailure' };
    if (
      !Number.isSafeInteger(proposal.proposalIndex) ||
      proposal.proposalIndex < 0 ||
      proposal.piSessionId.length === 0 ||
      proposal.modelTurnId.length === 0 ||
      proposal.toolCallId.length === 0
    )
      return { kind: 'Rejected', reason: 'ArgumentsInvalid' };
    const identity = JSON.stringify([
      binding.evaluationId,
      phase,
      proposal.piSessionId,
      proposal.modelTurnId,
      proposal.toolCallId,
      proposal.proposalIndex,
    ]);
    if (this.#used.has(identity)) return { kind: 'EvidenceIntegrityFailure' };
    this.#used.add(identity);
    if (interrupted(signal)) return { kind: 'DependencyUnavailable' };
    try {
      const tool = toolBinding(proposal.input);
      const matches = this.#dependencies.activeTools.filter((active) => active.name === tool.name);
      if (matches.length !== 1 || matches[0]?.requiredCapability !== tool.requiredCapability)
        return { kind: 'Rejected', reason: 'CapabilityNotGranted' };
      const resource = this.#dependencies.resources.resolve(proposal);
      if (resource.kind !== 'Resolved')
        return {
          kind: 'Rejected',
          reason: resource.reason === 'PathEscape' ? 'ResourceDenied' : 'ArgumentsInvalid',
        };
      const mandate = await this.#dependencies.mandate.inspect({
        taskRevisionSaid: binding.taskRevisionSaid,
        taskMandateSaid: binding.taskMandateSaid,
        tool: tool.name,
        requiredCapability: tool.requiredCapability,
        resource: resource.resource,
      });
      switch (mandate.kind) {
        case 'Expired':
          return { kind: 'Rejected', reason: 'MandateExpired' };
        case 'Revoked':
          return { kind: 'Rejected', reason: 'MandateRevoked' };
        case 'ApprovalRequired':
          return { kind: 'ApprovalRequired' };
        case 'Unavailable':
          return { kind: 'DependencyUnavailable' };
        case 'Current':
          break;
      }
      if (
        mandate.mandateSaid !== binding.taskMandateSaid ||
        !mandate.allowedCapabilities.includes(tool.requiredCapability)
      )
        return { kind: 'Rejected', reason: 'CapabilityNotGranted' };
      const capacity = await this.#dependencies.capacity.inspect(binding);
      if (capacity.kind !== 'Available')
        return capacity.kind === 'Exhausted'
          ? { kind: 'Rejected', reason: 'BudgetExhausted' }
          : { kind: 'DependencyUnavailable' };
      const lease = await this.#dependencies.lease.inspect(binding);
      if (lease.kind === 'Unavailable') return { kind: 'DependencyUnavailable' };
      if (
        lease.kind !== 'Held' ||
        !Number.isFinite(Date.parse(lease.expiresAt)) ||
        Date.parse(lease.expiresAt) <= this.#dependencies.now()
      )
        return { kind: 'Rejected', reason: 'LeaseLost' };
      if (interrupted(signal)) return { kind: 'DependencyUnavailable' };
      const outcome = await this.#dependencies.effects.enact(
        {
          proposal,
          tool: tool.name,
          requiredCapability: tool.requiredCapability,
          resource: resource.resource,
        },
        signal,
      );
      return outcome.kind === 'BudgetExhausted'
        ? { kind: 'Rejected', reason: 'BudgetExhausted' }
        : outcome;
    } catch {
      return { kind: 'DependencyUnavailable' };
    }
  }
}
