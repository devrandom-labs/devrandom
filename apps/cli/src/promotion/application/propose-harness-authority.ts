import {
  authorizeHarnessProposal,
  type HarnessProposalCapability,
  type TaskToolCapability,
} from '@devrandom/domain';
import {
  decodeHarnessAuthorityProposal,
  prepareEvidenceArtifact,
  type HarnessAuthorityProposal,
  type EvidenceArtifact,
} from '@devrandom/protocol';
export interface HarnessProposalAuthority {
  inspect(): Promise<
    | {
        readonly kind: 'Current';
        readonly ownerAid: string;
        readonly personalAgentAid: string;
        readonly taskMandateSaid: string;
        readonly taskRevisionSaid: string;
        readonly activeRevisionSaid: string;
        readonly pointerVersion: number;
        readonly taskCapabilities: readonly TaskToolCapability[];
        readonly unavailableCapabilities: readonly TaskToolCapability[];
        readonly mandateCapabilities: readonly TaskToolCapability[];
      }
    | { readonly kind: 'Rejected' }
  >;
}
export interface HarnessProposalRecords {
  record(input: {
    readonly proposal: { readonly artifact: EvidenceArtifact; readonly bytes: Uint8Array };
    readonly receipt: { readonly artifact: EvidenceArtifact; readonly bytes: Uint8Array };
  }): Promise<{ readonly kind: 'Recorded' | 'Unavailable' }>;
}
export type HarnessAuthorityProposalRecording =
  | {
      readonly kind: 'Denied';
      readonly proposalArtifactSaid: string;
      readonly receiptArtifactSaid: string;
      readonly reason: 'CapabilityNotGranted';
      readonly capabilities: readonly HarnessProposalCapability[];
      readonly activeRevisionSaid: string;
      readonly attribution: 'OperatorInjected';
      readonly personalAgentAid: string;
    }
  | {
      readonly kind: 'Recorded';
      readonly proposalArtifactSaid: string;
      readonly receiptArtifactSaid: string;
      readonly activeRevisionSaid: string;
      readonly attribution: 'OperatorInjected';
      readonly personalAgentAid: string;
    }
  | { readonly kind: 'Blocked'; readonly gate: string };
/** Record a scoped proposal disposition. There is deliberately no activation, deployment, or evidence-mutation capability. */
export async function proposeHarnessAuthority(
  proposal: HarnessAuthorityProposal,
  dependencies: {
    readonly authority: HarnessProposalAuthority;
    readonly records: HarnessProposalRecords;
    now(): string;
  },
): Promise<HarnessAuthorityProposalRecording> {
  if (decodeHarnessAuthorityProposal(proposal).kind !== 'Accepted')
    return { kind: 'Blocked', gate: 'Proposal' };
  const current = await dependencies.authority.inspect();
  if (current.kind !== 'Current') return { kind: 'Blocked', gate: 'Authority' };
  if (
    proposal.taskRevisionSaid !== current.taskRevisionSaid ||
    proposal.parentRevisionSaid !== current.activeRevisionSaid
  )
    return { kind: 'Blocked', gate: 'Binding' };
  const authorization = authorizeHarnessProposal({
    ...current,
    requestedCapabilities: proposal.requestedCapabilities,
  });
  const proposalBytes = Buffer.from(JSON.stringify(proposal));
  const prepared = prepareEvidenceArtifact(proposalBytes, 'application/json');
  if (prepared.kind !== 'Prepared') return { kind: 'Blocked', gate: 'Evidence' };
  const receiptBytes = Buffer.from(
    JSON.stringify({
      version: 1,
      kind: 'HarnessProposalAuthorization',
      proposalArtifactSaid: prepared.artifact.d,
      taskRevisionSaid: current.taskRevisionSaid,
      taskMandateSaid: current.taskMandateSaid,
      activeRevisionSaid: current.activeRevisionSaid,
      pointerVersion: current.pointerVersion,
      attribution: {
        kind: 'OperatorInjected',
        operatorAid: current.ownerAid,
        personalAgentAid: current.personalAgentAid,
      },
      observedAt: dependencies.now(),
      currentScope: {
        taskCapabilities: current.taskCapabilities,
        unavailableCapabilities: current.unavailableCapabilities,
        mandateCapabilities: current.mandateCapabilities,
      },
      authorization,
    }),
  );
  const receipt = prepareEvidenceArtifact(receiptBytes, 'application/json');
  if (receipt.kind !== 'Prepared') return { kind: 'Blocked', gate: 'Evidence' };
  if (
    (
      await dependencies.records.record({
        proposal: { artifact: prepared.artifact, bytes: proposalBytes },
        receipt: { artifact: receipt.artifact, bytes: receiptBytes },
      })
    ).kind !== 'Recorded'
  )
    return { kind: 'Blocked', gate: 'Evidence' };
  const binding = {
    proposalArtifactSaid: prepared.artifact.d,
    receiptArtifactSaid: receipt.artifact.d,
    activeRevisionSaid: current.activeRevisionSaid,
    attribution: 'OperatorInjected' as const,
    personalAgentAid: current.personalAgentAid,
  };
  return authorization.kind === 'Denied'
    ? { ...binding, ...authorization }
    : { ...binding, kind: 'Recorded' };
}
