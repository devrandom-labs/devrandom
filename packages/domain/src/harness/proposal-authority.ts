import type { TaskToolCapability } from '../task/authority.js';
/** Vocabulary for requesting authority is broader than the executable Tool Gateway catalogue. */
export type HarnessProposalCapability =
  | TaskToolCapability
  | 'DeployProduction'
  | 'ExpandMandate'
  | 'ReplaceProtectedEvaluationManifest'
  | 'DeleteEvaluationEvidence'
  | 'ActivateHarnessRevision';
export type HarnessProposalAuthorization =
  | { readonly kind: 'InScope' }
  | {
      readonly kind: 'Denied';
      readonly reason: 'CapabilityNotGranted';
      readonly capabilities: readonly HarnessProposalCapability[];
    };
/** A proposal never grants authority: every requested capability must already be in both current scopes. */
export function authorizeHarnessProposal(input: {
  readonly requestedCapabilities: readonly HarnessProposalCapability[];
  readonly taskCapabilities: readonly TaskToolCapability[];
  readonly unavailableCapabilities: readonly TaskToolCapability[];
  readonly mandateCapabilities: readonly TaskToolCapability[];
}): HarnessProposalAuthorization {
  const task = new Set<string>(input.taskCapabilities),
    unavailable = new Set<string>(input.unavailableCapabilities),
    mandate = new Set<string>(input.mandateCapabilities);
  const denied = [
    ...new Set(
      input.requestedCapabilities.filter(
        (capability) =>
          !task.has(capability) || unavailable.has(capability) || !mandate.has(capability),
      ),
    ),
  ];
  return denied.length === 0
    ? { kind: 'InScope' }
    : { kind: 'Denied', reason: 'CapabilityNotGranted', capabilities: denied };
}
