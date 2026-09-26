import { evaluationLeaseRenewalCommandSchema } from '@devrandom/protocol';
import type { evaluationLeaseRenewalReceiptSchema } from '@devrandom/protocol';
import type Type from 'typebox';
import Value from 'typebox/value';

export type EvaluationLeaseRenewalCommand = Type.Static<typeof evaluationLeaseRenewalCommandSchema>;
export type EvaluationLeaseRenewalReceipt = Type.Static<typeof evaluationLeaseRenewalReceiptSchema>;

/** Current Task/Mandate and residual budget must be checked before extending effect rights. */
export interface EvaluationLeaseRenewalAuthority {
  inspect(input: {
    readonly ownerAid: string;
    readonly command: EvaluationLeaseRenewalCommand;
  }): Promise<
    | { readonly kind: 'Authorized' }
    | { readonly kind: 'Blocked'; readonly gate: 'Authority' | 'Budget' | 'Closed' }
    | { readonly kind: 'Unavailable' }
  >;
}

export interface EvaluationLeases {
  renew(input: {
    readonly ownerAid: string;
    readonly command: EvaluationLeaseRenewalCommand;
  }): Promise<EvaluationLeaseRenewalReceipt>;
}

export async function renewHostedEvaluationLease(
  input: { readonly ownerAid: string; readonly command: EvaluationLeaseRenewalCommand },
  dependencies: {
    readonly authority: EvaluationLeaseRenewalAuthority;
    readonly leases: EvaluationLeases;
  },
): Promise<EvaluationLeaseRenewalReceipt> {
  if (
    !Value.Check(evaluationLeaseRenewalCommandSchema, input.command) ||
    input.ownerAid.length === 0
  )
    return { kind: 'Conflict' };
  const authority = await dependencies.authority.inspect(input);
  if (authority.kind !== 'Authorized') return authority;
  return dependencies.leases.renew(input);
}
