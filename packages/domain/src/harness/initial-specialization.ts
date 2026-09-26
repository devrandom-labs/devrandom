import type { RunPurpose } from '../run/run.js';

export interface AwaitingRunAdmission {
  readonly kind: 'AwaitingRunAdmission';
  readonly harnessLineageId: string;
  readonly harnessRevisionSaid: string;
}

export interface InitialSpecializationAccepted {
  readonly kind: 'InitialSpecializationAccepted';
  readonly harnessLineageId: string;
  readonly harnessRevisionSaid: string;
  readonly runId: string;
  readonly acceptedAt: string;
}

export type InitialSpecializationActivation = AwaitingRunAdmission | InitialSpecializationAccepted;

export interface InitialSpecializationAcceptanceInput {
  readonly harnessLineageId: string;
  readonly harnessRevisionSaid: string;
  readonly runId: string;
  readonly acceptedAt: string;
  readonly purpose: RunPurpose;
}

export type InitialSpecializationAcceptance =
  | { readonly kind: 'Accepted'; readonly activation: InitialSpecializationAccepted }
  | { readonly kind: 'Equivalent'; readonly activation: InitialSpecializationAccepted }
  | { readonly kind: 'IncumbentConfirmed'; readonly activation: InitialSpecializationAccepted }
  | { readonly kind: 'InitialCalibrationRequired' }
  | { readonly kind: 'HarnessBindingConflict' }
  | {
      readonly kind: 'IncumbentConflict';
      readonly incumbent: InitialSpecializationAccepted;
    };

function sameAcceptance(
  activation: InitialSpecializationAccepted,
  input: InitialSpecializationAcceptanceInput,
): boolean {
  return (
    activation.harnessLineageId === input.harnessLineageId &&
    activation.harnessRevisionSaid === input.harnessRevisionSaid &&
    activation.runId === input.runId &&
    activation.acceptedAt === input.acceptedAt
  );
}

export function acceptInitialSpecialization(
  current: InitialSpecializationActivation,
  input: InitialSpecializationAcceptanceInput,
): InitialSpecializationAcceptance {
  if (current.kind === 'InitialSpecializationAccepted') {
    if (
      current.harnessLineageId !== input.harnessLineageId ||
      current.harnessRevisionSaid !== input.harnessRevisionSaid
    ) {
      return { kind: 'IncumbentConflict', incumbent: current };
    }
    if (input.purpose.kind === 'PreparedCompatibilityCalibration' && input.purpose.ordinal === 1) {
      return sameAcceptance(current, input)
        ? { kind: 'Equivalent', activation: current }
        : { kind: 'IncumbentConflict', incumbent: current };
    }
    return { kind: 'IncumbentConfirmed', activation: current };
  }
  if (
    current.harnessLineageId !== input.harnessLineageId ||
    current.harnessRevisionSaid !== input.harnessRevisionSaid
  ) {
    return { kind: 'HarnessBindingConflict' };
  }
  if (input.purpose.kind !== 'PreparedCompatibilityCalibration' || input.purpose.ordinal !== 1) {
    return { kind: 'InitialCalibrationRequired' };
  }
  return {
    kind: 'Accepted',
    activation: {
      kind: 'InitialSpecializationAccepted',
      harnessLineageId: input.harnessLineageId,
      harnessRevisionSaid: input.harnessRevisionSaid,
      runId: input.runId,
      acceptedAt: input.acceptedAt,
    },
  };
}
