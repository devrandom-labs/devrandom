import {
  evaluationConsumables,
  type EvaluationAllowance,
  type EvaluationConsumable,
} from './allocation.js';

export type EvaluationDebit =
  | {
      readonly sourceId: string;
      readonly kind: 'Settled';
      readonly consumed: EvaluationAllowance;
    }
  | { readonly sourceId: string; readonly kind: 'Unresolved' };

export interface EvaluationReservation {
  readonly sourceId: string;
  readonly reserved: EvaluationAllowance;
}

export type ResidualEvaluationAllowance =
  | { readonly kind: 'Available'; readonly remaining: EvaluationAllowance }
  | {
      readonly kind: 'Unavailable';
      readonly reason: 'UnresolvedSpend' | 'DuplicateSource' | 'InvalidAmount' | 'CeilingExceeded';
      readonly budget?: EvaluationConsumable;
    };

function valid(amounts: EvaluationAllowance): boolean {
  return evaluationConsumables.every(
    (budget) => Number.isSafeInteger(amounts[budget]) && amounts[budget] >= 0,
  );
}

/** Reconciles known Task debits and held reservations; unknown provider usage never becomes free allowance. */
export function assessResidualEvaluationAllowance(input: {
  readonly taskCeiling: EvaluationAllowance;
  readonly mandateCeiling: EvaluationAllowance;
  readonly debits: readonly EvaluationDebit[];
  readonly reservations: readonly EvaluationReservation[];
}): ResidualEvaluationAllowance {
  if (!valid(input.taskCeiling) || !valid(input.mandateCeiling))
    return { kind: 'Unavailable', reason: 'InvalidAmount' };
  if (input.debits.some((debit) => debit.kind === 'Unresolved'))
    return { kind: 'Unavailable', reason: 'UnresolvedSpend' };
  const sourceIds = [
    ...input.debits.map((debit) => debit.sourceId),
    ...input.reservations.map((reservation) => reservation.sourceId),
  ];
  if (
    sourceIds.some((sourceId) => sourceId.length === 0) ||
    new Set(sourceIds).size !== sourceIds.length
  )
    return { kind: 'Unavailable', reason: 'DuplicateSource' };
  const consumed = input.debits.flatMap((debit) =>
    debit.kind === 'Settled' ? [debit.consumed] : [],
  );
  const held = input.reservations.map((reservation) => reservation.reserved);
  if ([...consumed, ...held].some((amounts) => !valid(amounts)))
    return { kind: 'Unavailable', reason: 'InvalidAmount' };
  const remaining = { ...input.taskCeiling };
  for (const budget of evaluationConsumables) {
    const ceiling = Math.min(input.taskCeiling[budget], input.mandateCeiling[budget]);
    let used = 0;
    for (const amounts of [...consumed, ...held]) {
      used += amounts[budget];
      if (!Number.isSafeInteger(used)) return { kind: 'Unavailable', reason: 'InvalidAmount' };
    }
    if (used > ceiling) return { kind: 'Unavailable', reason: 'CeilingExceeded', budget };
    remaining[budget] = ceiling - used;
  }
  return { kind: 'Available', remaining };
}
