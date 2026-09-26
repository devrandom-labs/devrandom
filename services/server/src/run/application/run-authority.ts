import type { TaskBudgets } from '@devrandom/domain';
import type { TaskProjection } from '@devrandom/protocol';

export interface CurrentRunMandateInput {
  readonly ownerAid: string;
  readonly taskId: string;
  readonly taskRevisionSaid: string;
  readonly harnessLineageId: string;
  readonly personalAgentAid: string;
  readonly taskMandateSaid: string;
  readonly governorAid: string;
  readonly promotionMandateSaid: string;
  readonly observedAt: string;
}

export type CurrentRunMandateAuthorization =
  | {
      readonly kind: 'CurrentRunMandatesAuthorized';
      readonly task: TaskProjection;
      readonly personalAgentAid: string;
      readonly taskMandateSaid: string;
      readonly taskMandateBudget: TaskBudgets;
      readonly governorAid: string;
      readonly promotionMandateSaid: string;
    }
  | { readonly kind: 'TaskNotFound' }
  | { readonly kind: 'TaskBindingRejected' }
  | { readonly kind: 'TaskMandateNotAdmitted' }
  | { readonly kind: 'TaskMandatePending' }
  | { readonly kind: 'TaskMandateNotYetValid' }
  | { readonly kind: 'TaskMandateExpired' }
  | { readonly kind: 'TaskMandateRevoked' }
  | { readonly kind: 'TaskMandateBindingRejected' }
  | { readonly kind: 'PromotionMandateNotAdmitted' }
  | { readonly kind: 'PromotionMandatePending' }
  | { readonly kind: 'PromotionMandateNotYetValid' }
  | { readonly kind: 'PromotionMandateExpired' }
  | { readonly kind: 'PromotionMandateRevoked' }
  | { readonly kind: 'PromotionMandateBindingRejected' }
  | {
      readonly kind: 'DependencyUnavailable';
      readonly dependency: 'HostedMongoDB' | 'Keria' | 'Witness';
    };

export interface CurrentRunMandates {
  authorize(input: CurrentRunMandateInput): Promise<CurrentRunMandateAuthorization>;
}
