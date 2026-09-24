export interface UserPrincipal {
  readonly aid: string;
}

export interface CurrentUserCustodyEvidence {
  readonly user: UserPrincipal;
  readonly controllerAid: string;
  readonly keriaAgentAid: string;
  readonly kelSequence: number;
  readonly witnessAids: readonly string[];
  readonly witnessThreshold: number;
  readonly witnessReceiptIndexes: readonly number[];
  readonly verifiedAt: string;
}

const currentUserCustody = Symbol('CurrentUserCustody');

export interface CurrentUserCustody extends CurrentUserCustodyEvidence {
  readonly [currentUserCustody]: typeof currentUserCustody;
}

export type UserCustodyRecoveryReason =
  | { readonly kind: 'CustodyUnavailable' }
  | { readonly kind: 'ProfileUnavailable' }
  | { readonly kind: 'IdentityConflict' }
  | { readonly kind: 'ReplacementRequired' }
  | { readonly kind: 'InvalidKelSequence'; readonly actual: number }
  | {
      readonly kind: 'InvalidWitnessPolicy';
      readonly threshold: number;
      readonly witnessCount: number;
    }
  | { readonly kind: 'InvalidWitnessReceiptIndex'; readonly index: number }
  | {
      readonly kind: 'WitnessThresholdNotMet';
      readonly required: number;
      readonly received: number;
    };

export type UserCustodyConfirmation =
  | { readonly kind: 'Current'; readonly custody: CurrentUserCustody }
  | { readonly kind: 'RecoveryRequired'; readonly reason: UserCustodyRecoveryReason };

export function confirmCurrentUserCustody(
  evidence: CurrentUserCustodyEvidence,
): UserCustodyConfirmation {
  if (!Number.isInteger(evidence.kelSequence) || evidence.kelSequence < 0) {
    return {
      kind: 'RecoveryRequired',
      reason: { kind: 'InvalidKelSequence', actual: evidence.kelSequence },
    };
  }

  const witnesses = new Set(evidence.witnessAids);
  if (
    !Number.isInteger(evidence.witnessThreshold) ||
    evidence.witnessThreshold < 1 ||
    evidence.witnessThreshold > evidence.witnessAids.length ||
    witnesses.size !== evidence.witnessAids.length
  ) {
    return {
      kind: 'RecoveryRequired',
      reason: {
        kind: 'InvalidWitnessPolicy',
        threshold: evidence.witnessThreshold,
        witnessCount: witnesses.size,
      },
    };
  }

  const receiptIndexes = new Set<number>();
  for (const index of evidence.witnessReceiptIndexes) {
    if (!Number.isInteger(index) || index < 0 || index >= evidence.witnessAids.length) {
      return {
        kind: 'RecoveryRequired',
        reason: { kind: 'InvalidWitnessReceiptIndex', index },
      };
    }
    receiptIndexes.add(index);
  }

  if (receiptIndexes.size < evidence.witnessThreshold) {
    return {
      kind: 'RecoveryRequired',
      reason: {
        kind: 'WitnessThresholdNotMet',
        required: evidence.witnessThreshold,
        received: receiptIndexes.size,
      },
    };
  }

  const custody: CurrentUserCustody = {
    ...evidence,
    witnessAids: Object.freeze([...evidence.witnessAids]),
    witnessReceiptIndexes: Object.freeze([...receiptIndexes]),
    [currentUserCustody]: currentUserCustody,
  };

  return { kind: 'Current', custody: Object.freeze(custody) };
}
