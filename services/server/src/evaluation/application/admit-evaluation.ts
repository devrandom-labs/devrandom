import { assessComparisonAllocation, type EvaluationAllowance } from '@devrandom/domain';
import { evaluationAdmissionCommandSchema } from '@devrandom/protocol';
import type { evaluationAdmissionReceiptSchema } from '@devrandom/protocol';
import type Type from 'typebox';
import Value from 'typebox/value';

export type EvaluationAdmissionCommand = Type.Static<typeof evaluationAdmissionCommandSchema>;
// TypeBox's dynamic literal mapping currently narrows the Blocked gate to never.
export type EvaluationAdmissionReceipt =
  | Extract<
      Type.Static<typeof evaluationAdmissionReceiptSchema>,
      { kind: 'Admitted' | 'Conflict' | 'Unavailable' }
    >
  | {
      readonly kind: 'Blocked';
      readonly gate: 'Profile' | 'Source' | 'Authority' | 'Budget' | 'Qualification' | 'Evidence';
    };
export type EvaluationAdmissionOutcome = EvaluationAdmissionReceipt | { readonly kind: 'Invalid' };

/** Current qualification, mandate, and residual allowance are checked by trusted adapters. */
export interface EvaluationEligibility {
  inspect(input: {
    readonly ownerAid: string;
    readonly command: EvaluationAdmissionCommand;
  }): Promise<
    | {
        readonly kind: 'Eligible';
        readonly remaining: EvaluationAllowance;
        readonly verifiedMandateCeiling: EvaluationAllowance;
      }
    | {
        readonly kind: 'Blocked';
        readonly gate: 'Profile' | 'Source' | 'Authority' | 'Budget' | 'Qualification' | 'Evidence';
      }
    | { readonly kind: 'Unavailable' }
  >;
}

/** The repository rechecks immutable Run bindings and takes the owner slot; residual spend remains an eligibility gate. */
export interface EvaluationReservations {
  reconcile(input: {
    readonly ownerAid: string;
    readonly command: EvaluationAdmissionCommand;
  }): Promise<
    | Extract<EvaluationAdmissionReceipt, { kind: 'Admitted' | 'Conflict' | 'Unavailable' }>
    | { readonly kind: 'NotFound' }
  >;
  reserve(input: {
    readonly ownerAid: string;
    readonly command: EvaluationAdmissionCommand;
    readonly reserved: EvaluationAllowance;
    readonly verifiedMandateCeiling: EvaluationAllowance;
  }): Promise<EvaluationAdmissionReceipt>;
}

export async function admitEvaluation(
  input: { readonly ownerAid: string; readonly command: EvaluationAdmissionCommand },
  dependencies: {
    readonly eligibility: EvaluationEligibility;
    readonly reservations: EvaluationReservations;
  },
): Promise<EvaluationAdmissionOutcome> {
  if (!Value.Check(evaluationAdmissionCommandSchema, input.command) || input.ownerAid.length === 0)
    return { kind: 'Invalid' };
  const previous = await dependencies.reservations.reconcile(input);
  if (previous.kind !== 'NotFound') return previous;
  const eligibility = await dependencies.eligibility.inspect(input);
  if (eligibility.kind !== 'Eligible') {
    const concurrent = await dependencies.reservations.reconcile(input);
    return concurrent.kind === 'NotFound' ? eligibility : concurrent;
  }
  const allocation = assessComparisonAllocation(input.command.allocation, eligibility.remaining);
  if (allocation.kind !== 'Fits') return { kind: 'Blocked', gate: 'Budget' };
  return dependencies.reservations.reserve({
    ...input,
    reserved: allocation.total,
    verifiedMandateCeiling: eligibility.verifiedMandateCeiling,
  });
}
