import type { PromotionMandateInspection, TaskMandateInspection } from '@devrandom/domain';

import type { MandatePresentationRejection } from '../domain/presentation.js';

export type MandateInspection =
  | { readonly kind: 'TaskMandate'; readonly value: TaskMandateInspection }
  | { readonly kind: 'PromotionMandate'; readonly value: PromotionMandateInspection };

export interface MandateGrantInspection {
  readonly grantSenderAid: string;
  readonly grantRecipientAid: string;
  readonly inspection: MandateInspection;
}

export interface MandateAdmissionInput {
  readonly ownerAid: string;
  readonly credentialSaid: string;
  readonly grantSaid: string;
}

export type MandateAdmissionFailure =
  | { readonly kind: 'MandateAdmissionRejected'; readonly reason: MandatePresentationRejection }
  | { readonly kind: 'MandateAdmissionForbidden'; readonly reason: 'MandateRevoked' }
  | { readonly kind: 'DependencyUnavailable'; readonly dependency: 'Keria' | 'Witness' };

export type MandateAdmissionInspection =
  | { readonly kind: 'MandateGrantPending' }
  | { readonly kind: 'MandateAdmissionInspected'; readonly evidence: MandateGrantInspection }
  | MandateAdmissionFailure;

export type MandateAdmissionStart =
  | { readonly kind: 'MandateGrantPending' }
  | { readonly kind: 'MandateAdmissionStarted'; readonly operationName: string }
  | MandateAdmissionFailure;

export type MandateAdmissionObservation =
  | { readonly kind: 'MandateGrantPending' }
  | { readonly kind: 'MandateAdmissionPending' }
  | {
      readonly kind: 'MandateAdmissionVerified';
      readonly credentialSaid: string;
      readonly evidence: MandateGrantInspection;
    }
  | MandateAdmissionFailure;

export interface MandateAdmission {
  inspect(input: MandateAdmissionInput): Promise<MandateAdmissionInspection>;
  begin(
    input: MandateAdmissionInput & { readonly preparedAt: number },
  ): Promise<MandateAdmissionStart>;
  observe(
    input: MandateAdmissionInput & { readonly operationName: string },
  ): Promise<MandateAdmissionObservation>;
}
