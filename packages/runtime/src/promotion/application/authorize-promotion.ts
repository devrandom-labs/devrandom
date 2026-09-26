import { isDeepStrictEqual } from 'node:util';

import { closeComparison, selectPromotion } from '@devrandom/domain';
import {
  decodeActivationCommitCommand,
  decodeEvaluationClosure,
  decodeEvaluationManifest,
  prepareActivationCommitCommand,
  preparePromotionSelectionRecord,
  type ActivationCommitCommand,
  type ActivationCommitCommandInput,
  type ActivationCommitReceipt,
  type GovernorPromotionDecisionPayload,
  type PromotionProposalPayload,
} from '@devrandom/protocol';

import type {
  AgentPromotionSigning,
  CommittedRevisionRouting,
  ExactPromotionAuthority,
  GovernorPromotionSigning,
  HostedActivationCommit,
  PromotionCommands,
  PromotionEvidenceReading,
  VerifiedPromotionEvidence,
} from './promotion-conversations.js';

export interface PromotionAuthorizationInput {
  readonly commandId: string;
  readonly taskId: string;
  readonly taskRevisionSaid: string;
  readonly harnessLineageId: string;
  readonly expectedIncumbentRevisionSaid: string;
  readonly expectedPointerVersion: number;
  readonly evaluationClosureSaid: string;
  readonly governorAid: string;
}

export interface PromotionAuthorizationDependencies {
  readonly evidence: PromotionEvidenceReading;
  readonly authority: ExactPromotionAuthority;
  readonly agent: AgentPromotionSigning;
  readonly governor: GovernorPromotionSigning;
  readonly commands: PromotionCommands;
  readonly hosted: HostedActivationCommit;
  readonly routing: CommittedRevisionRouting;
}

export type PromotionAuthorization =
  | {
      readonly kind: 'Blocked';
      readonly reason:
        | 'EvidenceIncomplete'
        | 'EvidenceInvalid'
        | 'SelectionBlocked'
        | 'AuthorityUnavailable'
        | 'UserConfirmationPending'
        | 'SignatureInvalid'
        | 'CommandConflict'
        | 'CommandUnavailable'
        | 'HostedRejected';
    }
  | { readonly kind: 'CommitUncertain' }
  | { readonly kind: 'Retained'; readonly receiptSaid: string }
  | { readonly kind: 'Activated'; readonly revisionSaid: string; readonly receiptSaid: string }
  | {
      readonly kind: 'CommittedRoutingPending';
      readonly revisionSaid: string;
      readonly receiptSaid: string;
    };

const said = /^[A-Z][A-Za-z0-9_-]{43}$/u;

function evidenceValid(
  input: PromotionAuthorizationInput,
  evidence: VerifiedPromotionEvidence,
): boolean {
  const manifest = decodeEvaluationManifest(evidence.manifest);
  const closure = decodeEvaluationClosure(evidence.closure);
  return (
    manifest.kind === 'Accepted' &&
    closure.kind === 'Accepted' &&
    evidence.closure.d === input.evaluationClosureSaid &&
    evidence.closure.manifestSaid === evidence.manifest.d &&
    evidence.closure.evaluationId === evidence.manifest.evaluationId &&
    evidence.closure.originRunId === evidence.manifest.originRunId &&
    evidence.manifest.taskId === input.taskId &&
    evidence.manifest.taskRevisionSaid === input.taskRevisionSaid &&
    evidence.manifest.revisions.H1 === input.expectedIncumbentRevisionSaid &&
    evidence.comparison.evidence === 'Acknowledged' &&
    evidence.hypothesisSaid === evidence.manifest.hypothesisSaid &&
    said.test(evidence.selectionRecord.d)
  );
}

function disposition(
  evidence: VerifiedPromotionEvidence,
): ActivationCommitCommandInput['disposition'] | undefined {
  const selection = selectPromotion(evidence.comparison);
  if (selection.kind === 'SelectionBlocked') return undefined;
  if (selection.kind === 'RetainIncumbent')
    return { kind: 'RetainIncumbent', selectionEvidenceSaid: evidence.selectionRecord.d };
  if (selection.revisionSaid !== evidence.manifest.revisions[selection.arm]) return undefined;
  const comparison = closeComparison(
    evidence.comparison.conditions,
    evidence.comparison.observations,
  );
  if (comparison.kind !== 'EvidenceOnly') return undefined;
  const artifacts = ([1, 2, 3] as const).map(
    (repetition) =>
      comparison.measurements.find(
        (measurement) =>
          measurement.slot.arm === selection.arm && measurement.slot.repetition === repetition,
      )?.artifactSaid,
  );
  const [first, second, third] = artifacts;
  if (first === undefined || second === undefined || third === undefined) return undefined;
  return {
    kind: 'Activate',
    selectionEvidenceSaid: evidence.selectionRecord.d,
    candidateRevisionSaid: selection.revisionSaid,
    artifactSaids: [first, second, third],
  };
}

function baseBinding(
  input: PromotionAuthorizationInput,
  evidence: VerifiedPromotionEvidence,
  selected: ActivationCommitCommandInput['disposition'],
) {
  return {
    taskId: input.taskId,
    taskRevisionSaid: input.taskRevisionSaid,
    harnessLineageId: input.harnessLineageId,
    expectedIncumbentRevisionSaid: input.expectedIncumbentRevisionSaid,
    expectedPointerVersion: input.expectedPointerVersion,
    evaluationManifestSaid: evidence.manifest.d,
    evaluationClosureSaid: evidence.closure.d,
    disposition: selected,
  } as const;
}

function matchesStaged(
  command: ActivationCommitCommand,
  input: PromotionAuthorizationInput,
  evidence: VerifiedPromotionEvidence,
  selected: ActivationCommitCommandInput['disposition'],
  exactPromotionMandateSaid: string,
): boolean {
  return (
    decodeActivationCommitCommand(command).kind === 'Accepted' &&
    command.commandId === input.commandId &&
    command.exactPromotionMandateSaid === exactPromotionMandateSaid &&
    isDeepStrictEqual(
      {
        taskId: command.taskId,
        taskRevisionSaid: command.taskRevisionSaid,
        harnessLineageId: command.harnessLineageId,
        expectedIncumbentRevisionSaid: command.expectedIncumbentRevisionSaid,
        expectedPointerVersion: command.expectedPointerVersion,
        evaluationManifestSaid: command.evaluationManifestSaid,
        evaluationClosureSaid: command.evaluationClosureSaid,
        disposition: command.disposition,
        selectionRecord: command.selectionRecord,
      },
      { ...baseBinding(input, evidence, selected), selectionRecord: evidence.selectionRecord },
    )
  );
}

async function commitAndRoute(
  input: PromotionAuthorizationInput,
  command: ActivationCommitCommand,
  dependencies: PromotionAuthorizationDependencies,
): Promise<PromotionAuthorization> {
  let receipt: ActivationCommitReceipt;
  try {
    receipt = await dependencies.hosted.commit(command);
  } catch {
    return { kind: 'CommitUncertain' };
  }
  if (receipt.kind === 'Unavailable') return { kind: 'CommitUncertain' };
  if (receipt.kind === 'Conflict') return { kind: 'Blocked', reason: 'CommandConflict' };
  if (receipt.kind === 'Rejected') return { kind: 'Blocked', reason: 'HostedRejected' };
  const expectedRevision =
    command.disposition.kind === 'Activate'
      ? command.disposition.candidateRevisionSaid
      : command.expectedIncumbentRevisionSaid;
  const expectedVersion = input.expectedPointerVersion + 1;
  if (
    !Number.isSafeInteger(expectedVersion) ||
    receipt.activeRevisionSaid !== expectedRevision ||
    receipt.pointerVersion !== expectedVersion ||
    receipt.disposition !== (command.disposition.kind === 'Activate' ? 'Activated' : 'Retained') ||
    !said.test(receipt.decisionReceiptSaid)
  )
    return { kind: 'CommitUncertain' };
  if (command.disposition.kind === 'RetainIncumbent')
    return { kind: 'Retained', receiptSaid: receipt.decisionReceiptSaid };
  let routed: 'Routed' | 'Pending';
  try {
    routed = await dependencies.routing.activate({
      taskId: input.taskId,
      revisionSaid: expectedRevision,
      pointerVersion: expectedVersion,
      decisionReceiptSaid: receipt.decisionReceiptSaid,
    });
  } catch {
    routed = 'Pending';
  }
  return routed === 'Routed'
    ? {
        kind: 'Activated',
        revisionSaid: expectedRevision,
        receiptSaid: receipt.decisionReceiptSaid,
      }
    : {
        kind: 'CommittedRoutingPending',
        revisionSaid: expectedRevision,
        receiptSaid: receipt.decisionReceiptSaid,
      };
}

/** The local Controller signs only a complete E3 result; the server alone commits CAS. */
export async function authorizePromotion(
  input: PromotionAuthorizationInput,
  dependencies: PromotionAuthorizationDependencies,
): Promise<PromotionAuthorization> {
  if (
    !Number.isSafeInteger(input.expectedPointerVersion) ||
    input.expectedPointerVersion < 1 ||
    input.expectedPointerVersion >= Number.MAX_SAFE_INTEGER
  )
    return { kind: 'Blocked', reason: 'EvidenceInvalid' };
  const reading = await dependencies.evidence.inspect(input.evaluationClosureSaid);
  if (reading.kind !== 'Verified') return { kind: 'Blocked', reason: 'EvidenceIncomplete' };
  const evidence = reading.evidence;
  if (!evidenceValid(input, evidence)) return { kind: 'Blocked', reason: 'EvidenceInvalid' };
  const selected = disposition(evidence);
  if (selected === undefined) return { kind: 'Blocked', reason: 'SelectionBlocked' };
  const selectionRecord = preparePromotionSelectionRecord({
    taskId: input.taskId,
    taskRevisionSaid: input.taskRevisionSaid,
    harnessLineageId: input.harnessLineageId,
    expectedIncumbentRevisionSaid: input.expectedIncumbentRevisionSaid,
    expectedPointerVersion: input.expectedPointerVersion,
    evaluationManifestSaid: evidence.manifest.d,
    evaluationClosureSaid: evidence.closure.d,
    hypothesisSaid: evidence.hypothesisSaid,
    selection:
      selected.kind === 'Activate'
        ? {
            kind: 'Activate',
            candidateRevisionSaid: selected.candidateRevisionSaid,
            artifactSaids: selected.artifactSaids,
          }
        : { kind: 'RetainIncumbent' },
  });
  if (
    selectionRecord.kind !== 'Prepared' ||
    !isDeepStrictEqual(selectionRecord.record, evidence.selectionRecord)
  )
    return { kind: 'Blocked', reason: 'EvidenceInvalid' };
  const authority = await dependencies.authority.verify({
    taskId: input.taskId,
    taskRevisionSaid: input.taskRevisionSaid,
    harnessLineageId: input.harnessLineageId,
    ownerAid: evidence.manifest.ownerAid,
    governorAid: input.governorAid,
    evaluationManifestSaid: evidence.manifest.d,
    evaluationClosureSaid: evidence.closure.d,
  });
  if (authority.kind === 'PendingUserConfirmation')
    return { kind: 'Blocked', reason: 'UserConfirmationPending' };
  if (authority.kind !== 'Current') return { kind: 'Blocked', reason: 'AuthorityUnavailable' };
  const mandate = authority.mandate;
  if (
    mandate.evaluationManifestSaid !== evidence.manifest.d ||
    mandate.taskId !== input.taskId ||
    mandate.taskRevisionSaid !== input.taskRevisionSaid ||
    mandate.harnessLineageId !== input.harnessLineageId ||
    mandate.credential.issuerAid !== evidence.manifest.ownerAid ||
    mandate.credential.issueeAid !== input.governorAid ||
    input.governorAid === evidence.manifest.personalAgentAid ||
    input.governorAid === evidence.manifest.ownerAid ||
    !said.test(mandate.credential.credentialSaid)
  )
    return { kind: 'Blocked', reason: 'AuthorityUnavailable' };

  const staged = await dependencies.commands.inspect(input.commandId);
  if (staged.kind === 'Unavailable') return { kind: 'Blocked', reason: 'CommandUnavailable' };
  if (staged.kind === 'Staged')
    return matchesStaged(
      staged.command,
      input,
      evidence,
      selected,
      mandate.credential.credentialSaid,
    )
      ? commitAndRoute(input, staged.command, dependencies)
      : { kind: 'Blocked', reason: 'CommandConflict' };

  const proposal: PromotionProposalPayload = {
    version: 1,
    kind: 'PromotionProposal',
    ...baseBinding(input, evidence, selected),
    hypothesisSaid: evidence.hypothesisSaid,
  };
  const agent = await dependencies.agent.sign(proposal);
  if (
    agent.kind !== 'Verified' ||
    agent.sourceAid !== evidence.manifest.personalAgentAid ||
    !said.test(agent.exchangeSaid) ||
    !isDeepStrictEqual(agent.payload, proposal)
  )
    return { kind: 'Blocked', reason: 'SignatureInvalid' };
  const decision: GovernorPromotionDecisionPayload = {
    version: 1,
    kind: 'GovernorPromotionDecision',
    ...baseBinding(input, evidence, selected),
    exactPromotionMandateSaid: mandate.credential.credentialSaid,
    agentProposalExchangeSaid: agent.exchangeSaid,
  };
  const governor = await dependencies.governor.sign({ decision, mandate, evidence });
  if (
    governor.kind !== 'Verified' ||
    governor.sourceAid !== input.governorAid ||
    !said.test(governor.exchangeSaid) ||
    governor.exchangeSaid === agent.exchangeSaid ||
    !isDeepStrictEqual(governor.payload, decision)
  )
    return { kind: 'Blocked', reason: 'SignatureInvalid' };
  const prepared = prepareActivationCommitCommand({
    version: 1,
    commandId: input.commandId,
    ...baseBinding(input, evidence, selected),
    exactPromotionMandateSaid: mandate.credential.credentialSaid,
    agentProposalExchangeSaid: agent.exchangeSaid,
    governorDecisionExchangeSaid: governor.exchangeSaid,
    selectionRecord: evidence.selectionRecord,
  });
  if (prepared.kind !== 'Prepared') return { kind: 'Blocked', reason: 'EvidenceInvalid' };
  const recorded = await dependencies.commands.stage(prepared.command);
  if (recorded === 'Conflict') return { kind: 'Blocked', reason: 'CommandConflict' };
  if (recorded === 'Unavailable') return { kind: 'Blocked', reason: 'CommandUnavailable' };
  return commitAndRoute(input, prepared.command, dependencies);
}
