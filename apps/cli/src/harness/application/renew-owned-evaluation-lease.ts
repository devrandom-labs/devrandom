import { assessEvaluationLease, type EvaluationLeaseReceipt } from '@devrandom/domain';

export interface EvaluationLeaseRenewalCustody {
  inspect(): Promise<
    | {
        readonly kind: 'Read';
        readonly position: {
          readonly ownerAid: string;
          readonly evaluationId: string;
          readonly currentEvaluationVersion: number;
          readonly lease: EvaluationLeaseReceipt;
        };
      }
    | { readonly kind: 'Denied' | 'Conflict' | 'Unavailable' | 'ResponseInvalid' }
  >;
  renew(expectedEvaluationVersion: number): Promise<
    | {
        readonly kind: 'Renewed' | 'AlreadyRenewed';
        readonly receipt: {
          readonly version: number;
          readonly lease: EvaluationLeaseReceipt;
        };
      }
    | {
        readonly kind:
          'Lost' | 'Blocked' | 'Rejected' | 'Conflict' | 'Unavailable' | 'ResponseInvalid';
      }
  >;
}

/** Retries only an append's optimistic-concurrency conflict within the same unexpired lease. */
export async function renewOwnedEvaluationLease(
  input: {
    readonly ownerAid: string;
    readonly currentEvaluationVersion: number;
    readonly lease: EvaluationLeaseReceipt;
    readonly leaseRequestStartedAt: number;
    readonly signal: AbortSignal;
    readonly now: () => number;
  },
  custody: EvaluationLeaseRenewalCustody,
): Promise<
  | {
      readonly kind: 'Renewed';
      readonly lease: EvaluationLeaseReceipt;
      readonly requestStartedAt: number;
    }
  | { readonly kind: 'Lost' }
> {
  let version = input.currentEvaluationVersion;
  const held = () =>
    !input.signal.aborted &&
    assessEvaluationLease(
      input.lease,
      input.lease.evaluationId,
      input.lease.leaseId,
      input.leaseRequestStartedAt,
      input.now(),
    ).kind === 'Held';
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!held()) return { kind: 'Lost' };
      const requestStartedAt = input.now();
      const renewed = await custody.renew(version);
      if (input.signal.aborted) return { kind: 'Lost' };
      if (renewed.kind === 'Renewed' || renewed.kind === 'AlreadyRenewed') {
        const { lease } = renewed.receipt;
        return renewed.receipt.version === version + 1 &&
          lease.version === input.lease.version + 1 &&
          assessEvaluationLease(
            lease,
            input.lease.evaluationId,
            input.lease.leaseId,
            requestStartedAt,
            input.now(),
          ).kind === 'Held'
          ? { kind: 'Renewed', lease, requestStartedAt }
          : { kind: 'Lost' };
      }
      if (renewed.kind !== 'Conflict' || attempt === 2 || !held()) return { kind: 'Lost' };
      const fresh = await custody.inspect();
      if (fresh.kind !== 'Read' || !held()) return { kind: 'Lost' };
      const position = fresh.position;
      if (
        position.ownerAid !== input.ownerAid ||
        position.evaluationId !== input.lease.evaluationId ||
        position.lease.evaluationId !== input.lease.evaluationId ||
        position.lease.leaseId !== input.lease.leaseId ||
        position.lease.version !== input.lease.version ||
        position.lease.serverTime !== input.lease.serverTime ||
        position.lease.expiresAt !== input.lease.expiresAt ||
        !Number.isSafeInteger(position.currentEvaluationVersion) ||
        position.currentEvaluationVersion <= version
      )
        return { kind: 'Lost' };
      version = position.currentEvaluationVersion;
    }
  } catch {
    return { kind: 'Lost' };
  }
  return { kind: 'Lost' };
}
