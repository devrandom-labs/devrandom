import { promotionEvidenceClasses } from '@devrandom/domain';
import type {
  StablePromotionMandateIssuance,
  StableTaskMandateIssuance,
} from '@devrandom/identity';
import type { TaskProjection } from '@devrandom/protocol';

import type { LocalGovernanceProfile } from '../domain/local-governance.js';

interface MandateIssuancePlanInput {
  readonly userAlias: string;
  readonly governance: LocalGovernanceProfile;
  readonly task: TaskProjection;
  readonly issuedAt: number;
}

export type MandateIssuancePlan<Issuance> =
  | { readonly kind: 'Prepared'; readonly issuance: Issuance }
  | {
      readonly kind: 'Rejected';
      readonly reason: 'OwnerMismatch' | 'IssuanceTimeInvalid' | 'TaskDeadlineElapsed';
    };

interface MandateResourceClaims {
  readonly taskId: string;
  readonly taskRevisionSaid: string;
  readonly harnessLineageId: string;
  readonly allowedCapabilities: TaskProjection['revision']['requestedCapabilities'];
  readonly notBefore: string;
  readonly expiresAt: string;
}

function mandateResourceClaims(
  input: MandateIssuancePlanInput,
):
  | { readonly kind: 'Prepared'; readonly claims: MandateResourceClaims }
  | Exclude<MandateIssuancePlan<never>, { readonly kind: 'Prepared' }> {
  if (input.task.ownerAid !== input.governance.userAid) {
    return { kind: 'Rejected', reason: 'OwnerMismatch' };
  }
  if (!Number.isSafeInteger(input.issuedAt) || input.issuedAt < 0) {
    return { kind: 'Rejected', reason: 'IssuanceTimeInvalid' };
  }
  const taskDeadline = Date.parse(input.task.revision.expiresAt);
  if (!Number.isFinite(taskDeadline) || input.issuedAt >= taskDeadline) {
    return { kind: 'Rejected', reason: 'TaskDeadlineElapsed' };
  }
  const unavailable = new Set(input.task.revision.unavailableCapabilities);
  return {
    kind: 'Prepared',
    claims: {
      taskId: input.task.taskId,
      taskRevisionSaid: input.task.revisionSaid,
      harnessLineageId: input.task.harnessLineageId,
      allowedCapabilities: input.task.revision.requestedCapabilities.filter(
        (capability) => !unavailable.has(capability),
      ),
      notBefore: new Date(input.issuedAt).toISOString(),
      expiresAt: new Date(
        Math.min(input.issuedAt + 4 * 60 * 60 * 1_000, taskDeadline),
      ).toISOString(),
    },
  };
}

export function prepareTaskMandateIssuance(
  input: MandateIssuancePlanInput,
): MandateIssuancePlan<StableTaskMandateIssuance> {
  const resource = mandateResourceClaims(input);
  if (resource.kind === 'Rejected') {
    return resource;
  }
  return {
    kind: 'Prepared',
    issuance: {
      kind: 'TaskMandate',
      userAlias: input.userAlias,
      userAid: input.governance.userAid,
      holderAid: input.governance.personalAgentAid,
      registryId: input.governance.mandateRegistryId,
      issuedAt: input.issuedAt,
      claims: {
        authority: 'ExecutePrivateTask',
        taskId: resource.claims.taskId,
        taskRevisionSaid: resource.claims.taskRevisionSaid,
        harnessLineageId: resource.claims.harnessLineageId,
        repository: input.task.revision.repository,
        allowedCapabilities: resource.claims.allowedCapabilities,
        budgets: input.task.revision.budgets,
        allowedEvolutionClasses: input.task.revision.evolutionClasses,
        notBefore: resource.claims.notBefore,
        expiresAt: resource.claims.expiresAt,
      },
    },
  };
}

export function preparePromotionMandateIssuance(
  input: MandateIssuancePlanInput,
): MandateIssuancePlan<StablePromotionMandateIssuance> {
  const resource = mandateResourceClaims(input);
  if (resource.kind === 'Rejected') {
    return resource;
  }
  return {
    kind: 'Prepared',
    issuance: {
      kind: 'PromotionMandate',
      userAlias: input.userAlias,
      userAid: input.governance.userAid,
      holderAid: input.governance.governorAid,
      registryId: input.governance.mandateRegistryId,
      issuedAt: input.issuedAt,
      claims: {
        authority: 'ActivateEvaluatedSuccessor',
        taskId: resource.claims.taskId,
        taskRevisionSaid: resource.claims.taskRevisionSaid,
        harnessLineageId: resource.claims.harnessLineageId,
        capabilityCeiling: resource.claims.allowedCapabilities,
        budgetCeiling: input.task.revision.budgets,
        evolutionClassCeiling: input.task.revision.evolutionClasses,
        requiredEvidenceClasses: promotionEvidenceClasses,
        notBefore: resource.claims.notBefore,
        expiresAt: resource.claims.expiresAt,
      },
    },
  };
}
