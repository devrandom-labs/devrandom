import { isDeepStrictEqual } from 'node:util';

import { validateExecutionBinding, type EvaluationExecutionBinding } from '@devrandom/domain';
import {
  decodeEvaluationEvidenceEvent,
  decodeEvaluationManifest,
  type EvaluationEvidenceEvent,
  type EvaluationManifest,
} from '@devrandom/protocol';

import type { CurrentEvaluationProposalCapacity } from '../application/current-evaluation-proposal-capacity.js';
import type { EvaluationAcceptedPrefix } from '../application/prepare-evaluation-budget-coverage.js';

export interface AcceptedProposalCapacityDependencies {
  readonly manifest: EvaluationManifest;
  readonly accepted: EvaluationAcceptedPrefix;
}

function sameTrial(event: EvaluationEvidenceEvent, binding: EvaluationExecutionBinding): boolean {
  return isDeepStrictEqual(event.phase, binding.phase);
}

/** Checks the acknowledged Evaluation stream immediately after the parent has recorded
 * ToolProposed. It neither reserves the retained Run budget nor writes a second debit. */
export class AcceptedProposalCapacity implements CurrentEvaluationProposalCapacity {
  readonly #dependencies: AcceptedProposalCapacityDependencies;

  constructor(dependencies: AcceptedProposalCapacityDependencies) {
    this.#dependencies = dependencies;
  }

  async inspect(
    binding: EvaluationExecutionBinding,
  ): ReturnType<CurrentEvaluationProposalCapacity['inspect']> {
    const manifest = this.#dependencies.manifest;
    const phase = binding.phase;
    if (
      validateExecutionBinding(binding).kind !== 'Accepted' ||
      decodeEvaluationManifest(manifest).kind !== 'Accepted' ||
      phase.kind !== 'Trial' ||
      phase.arm !== 'C2' ||
      phase.manifestSaid !== manifest.d ||
      binding.evaluationId !== manifest.evaluationId ||
      binding.taskId !== manifest.taskId ||
      binding.taskRevisionSaid !== manifest.taskRevisionSaid ||
      binding.originRunId !== manifest.originRunId ||
      binding.personalAgentAid !== manifest.personalAgentAid ||
      binding.taskMandateSaid !== manifest.taskMandateSaid ||
      binding.harnessRevisionSaid !== manifest.revisions.C2
    )
      return { kind: 'Unavailable' };
    let accepted: Awaited<ReturnType<EvaluationAcceptedPrefix['open']>>;
    try {
      accepted = await this.#dependencies.accepted.open(binding);
    } catch {
      return { kind: 'Unavailable' };
    }
    if (
      accepted.kind !== 'Acknowledged' ||
      accepted.events.length === 0 ||
      accepted.events.length !== accepted.throughSequence + 1 ||
      accepted.events[accepted.events.length - 1]?.d !== accepted.headSaid
    )
      return { kind: 'Unavailable' };
    const proposed = new Map<string, EvaluationEvidenceEvent>();
    const debited = new Set<string>();
    let cumulative = 0;
    let slotDebits = 0;
    let previous: string | undefined;
    for (const [index, event] of accepted.events.entries()) {
      if (
        decodeEvaluationEvidenceEvent(event).kind !== 'Accepted' ||
        event.sequence !== index ||
        event.evaluationId !== binding.evaluationId ||
        event.streamId !== binding.evidenceStreamId ||
        event.originRunId !== binding.originRunId ||
        event.taskId !== binding.taskId ||
        event.taskRevisionSaid !== binding.taskRevisionSaid ||
        event.personalAgentAid !== binding.personalAgentAid ||
        event.taskMandateSaid !== binding.taskMandateSaid ||
        (event.phase.kind === 'Trial' &&
          (event.phase.manifestSaid !== manifest.d ||
            event.harnessRevisionSaid !==
              (event.phase.arm === 'H1TaskSearch'
                ? manifest.revisions.H1
                : manifest.revisions[event.phase.arm]))) ||
        (previous === undefined
          ? event.previous.kind !== 'Genesis'
          : event.previous.kind !== 'Previous' || event.previous.eventSaid !== previous)
      )
        return { kind: 'Unavailable' };
      previous = event.d;
      if (event.detail.kind === 'ToolProposed') proposed.set(event.d, event);
      if (
        event.detail.kind !== 'EvaluationBudgetDebited' ||
        event.detail.budget !== 'toolProposals'
      )
        continue;
      const source = event.detail.sourceEventSaid;
      const proposal = source === undefined ? undefined : proposed.get(source);
      if (
        proposal === undefined ||
        debited.has(proposal.d) ||
        !isDeepStrictEqual(event.phase, proposal.phase) ||
        event.detail.amount !== 1 ||
        event.detail.consumed !== cumulative + 1
      )
        return { kind: 'Unavailable' };
      debited.add(proposal.d);
      cumulative += 1;
      if (sameTrial(event, binding)) slotDebits += 1;
    }
    const pending = accepted.events[accepted.events.length - 1];
    if (
      pending?.detail.kind !== 'ToolProposed' ||
      !sameTrial(pending, binding) ||
      debited.has(pending.d) ||
      proposed.size !== debited.size + 1 ||
      [...proposed.keys()].some((said) => said !== pending.d && !debited.has(said))
    )
      return { kind: 'Unavailable' };
    const total =
      manifest.allocation.diagnosis.toolProposals +
      15 * manifest.allocation.perEntry.toolProposals +
      manifest.allocation.finalization.toolProposals;
    if (!Number.isSafeInteger(total) || total < 0) return { kind: 'Unavailable' };
    return cumulative >= total || slotDebits >= manifest.allocation.perEntry.toolProposals
      ? { kind: 'Exhausted' }
      : { kind: 'Available' };
  }
}
