import type {
  MandatePresentationProblem,
  MandatePresentationProjection,
  PresentMandateBody,
} from '@devrandom/protocol';

type PendingMandatePresentation = Extract<
  MandatePresentationProjection,
  { readonly kind: 'AwaitingGrant' | 'Admitting' }
>;

type AdmittedMandatePresentation = Extract<
  MandatePresentationProjection,
  { readonly kind: 'Admitted' }
>;

export type HostedMandatePresentation =
  | { readonly kind: 'Pending'; readonly presentation: PendingMandatePresentation }
  | { readonly kind: 'Admitted'; readonly presentation: AdmittedMandatePresentation }
  | { readonly kind: 'InputInvalid' }
  | { readonly kind: 'ServerUnavailable' }
  | { readonly kind: 'ResponseInvalid' }
  | {
      readonly kind: 'RequestRejected';
      readonly problem: MandatePresentationProblem;
    };

export interface HostedMandatePresentations {
  present(credentialSaid: string, command: PresentMandateBody): Promise<HostedMandatePresentation>;
}
