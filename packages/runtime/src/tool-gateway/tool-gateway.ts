import type { TaskToolCapability } from '@devrandom/domain';
import type { EvidenceEventDetail } from '@devrandom/protocol';

import type { EvidenceObservation, EvidenceRecording } from '../evidence/evidence-recorder.js';

export type ToolName =
  | 'read_file'
  | 'list_files'
  | 'search_repository'
  | 'write_file'
  | 'replace_text'
  | 'run_formatter'
  | 'run_static_analysis'
  | 'run_tests'
  | 'submit_result';

export type ToolInput =
  | { readonly kind: 'ReadFile'; readonly path: string }
  | { readonly kind: 'ListFiles'; readonly path: string }
  | {
      readonly kind: 'SearchRepository';
      readonly path: string;
      readonly query: string;
    }
  | { readonly kind: 'WriteFile'; readonly path: string; readonly content: string }
  | {
      readonly kind: 'ReplaceText';
      readonly path: string;
      readonly oldText: string;
      readonly newText: string;
      readonly expectedOccurrences: number;
    }
  | { readonly kind: 'RunFormatter'; readonly commandId: string }
  | { readonly kind: 'RunStaticAnalysis'; readonly commandId: string }
  | { readonly kind: 'RunTests'; readonly commandId: string }
  | { readonly kind: 'SubmitResult'; readonly artifactSaids: readonly string[] };

export interface ToolGatewayProposal {
  readonly piSessionId: string;
  readonly modelTurnId: string;
  readonly toolCallId: string;
  readonly proposalIndex: number;
  readonly input: ToolInput;
}

export interface ToolGatewayBinding {
  readonly taskRevisionSaid: string;
  readonly runId: string;
  readonly incarnationId: string;
  readonly harnessRevisionSaid: string;
  readonly taskMandateSaid: string;
}

export interface ActiveToolBinding {
  readonly name: ToolName;
  readonly requiredCapability: TaskToolCapability;
}

export type ToolResourceResolution =
  | { readonly kind: 'Resolved'; readonly resource: string }
  | { readonly kind: 'Denied'; readonly reason: 'ArgumentsInvalid' | 'PathEscape' };

export interface ToolResourceScope {
  resolve(proposal: ToolGatewayProposal): ToolResourceResolution;
}

export type CurrentToolMandateInspection =
  | {
      readonly kind: 'Current';
      readonly mandateSaid: string;
      readonly allowedCapabilities: readonly TaskToolCapability[];
    }
  | { readonly kind: 'Expired' }
  | { readonly kind: 'Revoked' }
  | { readonly kind: 'ApprovalRequired' }
  | { readonly kind: 'Unavailable' };

export interface CurrentToolMandate {
  inspect(input: {
    readonly taskRevisionSaid: string;
    readonly taskMandateSaid: string;
    readonly tool: ToolName;
    readonly requiredCapability: TaskToolCapability;
    readonly resource: string;
  }): Promise<CurrentToolMandateInspection>;
}

export type ToolLeaseInspection =
  { readonly kind: 'Held' } | { readonly kind: 'Lost' } | { readonly kind: 'Unavailable' };

export interface HeldToolLease {
  inspect(input: {
    readonly runId: string;
    readonly incarnationId: string;
  }): Promise<ToolLeaseInspection>;
}

export type ToolBudgetReservation =
  | { readonly kind: 'Reserved' }
  | { readonly kind: 'Exhausted' }
  | { readonly kind: 'OutboxBackpressure' }
  | { readonly kind: 'SecretDetected' }
  | { readonly kind: 'EvidenceIntegrityFailure' }
  | { readonly kind: 'Unavailable' };

export interface ToolProposalBudget {
  reserve(input: {
    readonly runId: string;
    readonly tool: ToolName;
    readonly requiredCapability: TaskToolCapability;
  }): Promise<ToolBudgetReservation>;
}

export interface AuthorizedToolEffect {
  readonly proposal: ToolGatewayProposal;
  readonly tool: ToolName;
  readonly requiredCapability: TaskToolCapability;
  readonly resource: string;
}

export type ToolEffectFailure = Extract<
  EvidenceEventDetail,
  { readonly kind: 'EffectFailed' }
>['failure'];

export type ToolEffectOutcome =
  | {
      readonly kind: 'SubmissionVerified';
      readonly disposition: 'Accepted' | 'Rejected' | 'CompatibilityFailure';
      readonly summary: string;
      readonly outputArtifactSaids: readonly string[];
    }
  | {
      readonly kind: 'Completed';
      readonly summary: string;
      readonly outputArtifactSaids: readonly string[];
    }
  | {
      readonly kind: 'Failed';
      readonly failure: ToolEffectFailure;
      readonly summary: string;
      readonly outputArtifactSaids: readonly string[];
    }
  | { readonly kind: 'OutboxBackpressure' }
  | { readonly kind: 'BudgetExhausted' }
  | { readonly kind: 'DependencyUnavailable' }
  | { readonly kind: 'SecretDetected' }
  | { readonly kind: 'EvidenceIntegrityFailure' };

export interface ToolEffects {
  enact(effect: AuthorizedToolEffect, signal: AbortSignal): Promise<ToolEffectOutcome>;
}

export interface ToolEvidence {
  record(observation: EvidenceObservation): EvidenceRecording;
}

export type ToolGatewayOutcome =
  | Extract<ToolEffectOutcome, { readonly kind: 'Completed' | 'Failed' | 'SubmissionVerified' }>
  | {
      readonly kind: 'Rejected';
      readonly reason:
        | 'CapabilityNotGranted'
        | 'ResourceDenied'
        | 'BudgetExhausted'
        | 'MandateExpired'
        | 'MandateRevoked'
        | 'LeaseLost'
        | 'ArgumentsInvalid';
    }
  | { readonly kind: 'ApprovalRequired' }
  | { readonly kind: 'OutboxBackpressure' }
  | { readonly kind: 'DependencyUnavailable' }
  | { readonly kind: 'SecretDetected' }
  | { readonly kind: 'EvidenceIntegrityFailure' };

export interface ToolGatewayDependencies {
  readonly binding: ToolGatewayBinding;
  readonly activeTools: readonly ActiveToolBinding[];
  readonly resources: ToolResourceScope;
  readonly mandate: CurrentToolMandate;
  readonly lease: HeldToolLease;
  readonly budget: ToolProposalBudget;
  readonly evidence: ToolEvidence;
  readonly effects: ToolEffects;
  now(): string;
}

const catalogue: ReadonlyMap<ToolInput['kind'], ActiveToolBinding> = new Map([
  ['ReadFile', { name: 'read_file', requiredCapability: 'ReadRepository' }],
  ['ListFiles', { name: 'list_files', requiredCapability: 'ReadRepository' }],
  ['SearchRepository', { name: 'search_repository', requiredCapability: 'ReadRepository' }],
  ['WriteFile', { name: 'write_file', requiredCapability: 'EditRepository' }],
  ['ReplaceText', { name: 'replace_text', requiredCapability: 'EditRepository' }],
  ['RunFormatter', { name: 'run_formatter', requiredCapability: 'RunFormatter' }],
  ['RunStaticAnalysis', { name: 'run_static_analysis', requiredCapability: 'RunStaticAnalysis' }],
  ['RunTests', { name: 'run_tests', requiredCapability: 'RunTests' }],
  ['SubmitResult', { name: 'submit_result', requiredCapability: 'SubmitResult' }],
]);

export function toolBinding(input: ToolInput): ActiveToolBinding {
  const found = catalogue.get(input.kind);
  if (found === undefined) {
    throw new Error(`The Tool Gateway catalogue does not own ${input.kind}`);
  }
  return found;
}

function sameActiveBinding(left: ActiveToolBinding, right: ActiveToolBinding): boolean {
  return left.name === right.name && left.requiredCapability === right.requiredCapability;
}

function rejectedEvidenceReason(
  reason: Extract<ToolGatewayOutcome, { readonly kind: 'Rejected' }>['reason'],
): Extract<EvidenceEventDetail, { readonly kind: 'ToolRejected' }>['reason'] {
  switch (reason) {
    case 'CapabilityNotGranted':
    case 'BudgetExhausted':
    case 'MandateExpired':
    case 'MandateRevoked':
    case 'LeaseLost':
    case 'ArgumentsInvalid':
      return reason;
    case 'ResourceDenied':
      return 'ResourceDenied';
  }
}

function beforeEffectRecordingFailure(
  recording: EvidenceRecording,
):
  | Extract<
      ToolGatewayOutcome,
      { readonly kind: 'SecretDetected' | 'OutboxBackpressure' | 'EvidenceIntegrityFailure' }
    >
  | undefined {
  switch (recording.kind) {
    case 'SecretDetected':
      return { kind: 'SecretDetected' };
    case 'Recorded':
      return undefined;
    case 'OutboxBackpressure':
    case 'OutboxBoundReached':
      return { kind: 'OutboxBackpressure' };
    case 'Unavailable':
    case 'ObservationRejected':
    case 'LocalStateCorruption':
      return { kind: 'EvidenceIntegrityFailure' };
  }
}

export class ToolGateway {
  readonly #dependencies: ToolGatewayDependencies;
  readonly #activeTools: ReadonlyMap<ToolName, ActiveToolBinding>;
  readonly #nextProposalByTurn = new Map<string, number>();
  #sequence: Promise<void> = Promise.resolve();

  constructor(dependencies: ToolGatewayDependencies) {
    this.#dependencies = dependencies;
    const activeTools = new Map<ToolName, ActiveToolBinding>();
    for (const active of dependencies.activeTools) {
      const expected = [...catalogue.values()].find(({ name }) => name === active.name);
      if (
        expected === undefined ||
        !sameActiveBinding(expected, active) ||
        activeTools.has(active.name)
      ) {
        throw new Error(`Invalid active Tool Gateway binding for ${active.name}`);
      }
      activeTools.set(active.name, active);
    }
    this.#activeTools = activeTools;
  }

  propose(proposal: ToolGatewayProposal, signal: AbortSignal): Promise<ToolGatewayOutcome> {
    const pending = this.#sequence.then(() => this.#mediate(proposal, signal));
    this.#sequence = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  async #mediate(proposal: ToolGatewayProposal, signal: AbortSignal): Promise<ToolGatewayOutcome> {
    const expected = this.#nextProposalByTurn.get(proposal.modelTurnId) ?? 0;
    const binding = toolBinding(proposal.input);
    const active = this.#activeTools.get(binding.name);
    const resourceResolution = this.#dependencies.resources.resolve(proposal);
    const resource =
      resourceResolution.kind === 'Resolved'
        ? resourceResolution.resource
        : `unclassified://${binding.name}`;
    const proposalFailure = beforeEffectRecordingFailure(
      this.#record({
        kind: 'ToolProposed',
        ...this.#attribution(proposal, binding, resource),
      }),
    );
    if (proposalFailure !== undefined) return proposalFailure;
    this.#nextProposalByTurn.set(proposal.modelTurnId, expected + 1);

    let budget: ToolBudgetReservation;
    try {
      budget = await this.#dependencies.budget.reserve({
        runId: this.#dependencies.binding.runId,
        tool: binding.name,
        requiredCapability: binding.requiredCapability,
      });
    } catch {
      return { kind: 'DependencyUnavailable' };
    }
    if (budget.kind === 'Unavailable') {
      return { kind: 'DependencyUnavailable' };
    }
    if (budget.kind === 'OutboxBackpressure') {
      return { kind: 'OutboxBackpressure' };
    }
    if (budget.kind === 'SecretDetected') return budget;
    if (budget.kind === 'EvidenceIntegrityFailure') {
      return { kind: 'EvidenceIntegrityFailure' };
    }
    if (budget.kind === 'Exhausted') {
      return this.#reject(proposal, binding, resource, 'BudgetExhausted');
    }

    if (proposal.proposalIndex !== expected) {
      return this.#reject(proposal, binding, resource, 'ArgumentsInvalid');
    }
    if (active === undefined || !sameActiveBinding(active, binding)) {
      return this.#reject(proposal, binding, resource, 'CapabilityNotGranted');
    }
    if (resourceResolution.kind === 'Denied') {
      const rejection = this.#reject(proposal, binding, resource, 'ResourceDenied');
      if (rejection.kind !== 'Rejected') {
        return rejection;
      }
      if (resourceResolution.reason === 'PathEscape') {
        const violationFailure = beforeEffectRecordingFailure(
          this.#record({ kind: 'SecurityViolation', violation: 'PathEscape' }),
        );
        if (violationFailure !== undefined) return violationFailure;
      }
      return rejection;
    }

    let mandate: CurrentToolMandateInspection;
    try {
      mandate = await this.#dependencies.mandate.inspect({
        taskRevisionSaid: this.#dependencies.binding.taskRevisionSaid,
        taskMandateSaid: this.#dependencies.binding.taskMandateSaid,
        tool: binding.name,
        requiredCapability: binding.requiredCapability,
        resource,
      });
    } catch {
      return { kind: 'DependencyUnavailable' };
    }
    switch (mandate.kind) {
      case 'Expired':
        return this.#reject(proposal, binding, resource, 'MandateExpired');
      case 'Revoked':
        return this.#reject(proposal, binding, resource, 'MandateRevoked');
      case 'ApprovalRequired':
        return this.#approvalRequired(proposal, binding, resource);
      case 'Unavailable':
        return { kind: 'DependencyUnavailable' };
      case 'Current':
        if (
          mandate.mandateSaid !== this.#dependencies.binding.taskMandateSaid ||
          !mandate.allowedCapabilities.includes(binding.requiredCapability)
        ) {
          return this.#reject(proposal, binding, resource, 'CapabilityNotGranted');
        }
        break;
    }

    let lease: ToolLeaseInspection;
    try {
      lease = await this.#dependencies.lease.inspect({
        runId: this.#dependencies.binding.runId,
        incarnationId: this.#dependencies.binding.incarnationId,
      });
    } catch {
      return { kind: 'DependencyUnavailable' };
    }
    if (lease.kind === 'Unavailable') {
      return { kind: 'DependencyUnavailable' };
    }
    if (lease.kind === 'Lost') {
      return this.#reject(proposal, binding, resource, 'LeaseLost');
    }

    const authorizationFailure = beforeEffectRecordingFailure(
      this.#record({
        kind: 'ToolAuthorized',
        ...this.#attribution(proposal, binding, resource),
        mandateSaid: mandate.mandateSaid,
      }),
    );
    if (authorizationFailure !== undefined) return authorizationFailure;
    if (signal.aborted) {
      return this.#effectFailed(proposal, binding, resource, {
        kind: 'Failed',
        failure: 'EffectAborted',
        summary: 'The authorized effect was aborted before it began.',
        outputArtifactSaids: [],
      });
    }

    let effect: ToolEffectOutcome;
    try {
      effect = await this.#dependencies.effects.enact(
        {
          proposal,
          tool: binding.name,
          requiredCapability: binding.requiredCapability,
          resource,
        },
        signal,
      );
    } catch {
      effect = {
        kind: 'Failed',
        failure: 'EvidenceIntegrityFailure',
        summary: 'The consequential effect did not produce a lawful receipt.',
        outputArtifactSaids: [],
      };
    }
    if (effect.kind === 'Failed') {
      return this.#effectFailed(proposal, binding, resource, effect);
    }
    if (effect.kind === 'BudgetExhausted') {
      return this.#reject(proposal, binding, resource, 'BudgetExhausted');
    }
    if (effect.kind === 'OutboxBackpressure' || effect.kind === 'DependencyUnavailable') {
      return effect;
    }
    if (effect.kind === 'SecretDetected') return effect;
    if (effect.kind === 'EvidenceIntegrityFailure') {
      return effect;
    }
    if (
      this.#record({
        kind: 'EffectCompleted',
        ...this.#attribution(proposal, binding, resource),
        outputArtifactSaids: [...effect.outputArtifactSaids],
      }).kind !== 'Recorded'
    ) {
      return { kind: 'EvidenceIntegrityFailure' };
    }
    return effect;
  }

  #approvalRequired(
    proposal: ToolGatewayProposal,
    binding: ActiveToolBinding,
    resource: string,
  ): ToolGatewayOutcome {
    const failure = beforeEffectRecordingFailure(
      this.#record({
        kind: 'ApprovalRequired',
        ...this.#attribution(proposal, binding, resource),
      }),
    );
    return failure ?? { kind: 'ApprovalRequired' };
  }

  #reject(
    proposal: ToolGatewayProposal,
    binding: ActiveToolBinding,
    resource: string,
    reason: Extract<ToolGatewayOutcome, { readonly kind: 'Rejected' }>['reason'],
  ): ToolGatewayOutcome {
    const failure = beforeEffectRecordingFailure(
      this.#record({
        kind: 'ToolRejected',
        ...this.#attribution(proposal, binding, resource),
        reason: rejectedEvidenceReason(reason),
      }),
    );
    return failure ?? { kind: 'Rejected', reason };
  }

  #effectFailed(
    proposal: ToolGatewayProposal,
    binding: ActiveToolBinding,
    resource: string,
    effect: Extract<ToolEffectOutcome, { readonly kind: 'Failed' }>,
  ): ToolGatewayOutcome {
    if (
      this.#record({
        kind: 'EffectFailed',
        ...this.#attribution(proposal, binding, resource),
        failure: effect.failure,
        outputArtifactSaids: [...effect.outputArtifactSaids],
      }).kind !== 'Recorded'
    ) {
      return { kind: 'EvidenceIntegrityFailure' };
    }
    if (
      effect.failure === 'ProcessSurvivedTermination' ||
      effect.failure === 'ProcessCleanupUnconfirmed'
    ) {
      this.#record({
        kind: 'SecurityViolation',
        violation: effect.failure,
      });
      return { kind: 'EvidenceIntegrityFailure' };
    }
    switch (effect.failure) {
      case 'BudgetExhausted':
        return { kind: 'Rejected', reason: 'BudgetExhausted' };
      case 'SecretDetected':
      case 'OutboxBackpressure':
      case 'DependencyUnavailable':
      case 'EvidenceIntegrityFailure':
        return { kind: effect.failure };
      case 'ExitCodeMismatch':
      case 'TimedOut':
      case 'OutputLimitExceeded':
      case 'FilesystemRejected':
      case 'ArtifactUnavailable':
      case 'ExecutableUnavailable':
      case 'EffectAborted':
        return effect;
    }
  }

  #record(event: EvidenceEventDetail): EvidenceRecording {
    return this.#dependencies.evidence.record({
      occurredAt: this.#dependencies.now(),
      producer: { kind: 'ToolGateway' },
      event,
    });
  }

  #attribution(proposal: ToolGatewayProposal, binding: ActiveToolBinding, resource: string) {
    return {
      piSessionId: proposal.piSessionId,
      modelTurnId: proposal.modelTurnId,
      toolCallId: proposal.toolCallId,
      proposalIndex: proposal.proposalIndex,
      tool: binding.name,
      requiredCapability: binding.requiredCapability,
      resource,
    };
  }
}
