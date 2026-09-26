import type { Run } from '@devrandom/domain';

export interface RunAdmissionReservationInput {
  readonly ownerAid: string;
  readonly commandId: string;
  readonly commandFingerprint: string;
  readonly admissionExchangeSaid: string;
  readonly reservedAt: string;
}

export type RunAdmissionReservation =
  | { readonly kind: 'RunAdmissionReserved' }
  | { readonly kind: 'AcceptedRunAdmission'; readonly run: Run }
  | { readonly kind: 'RunCommandConflict' }
  | { readonly kind: 'DependencyUnavailable'; readonly dependency: 'HostedMongoDB' };

export interface RunAdmissionReservations {
  reserve(input: RunAdmissionReservationInput): Promise<RunAdmissionReservation>;
}
