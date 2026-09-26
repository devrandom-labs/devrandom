export const evaluationLeasePolicy = Object.freeze({
  leaseSeconds: 45,
  renewalSeconds: 15,
  clientSafetyMarginSeconds: 5,
});

export interface EvaluationLeaseReceipt {
  readonly evaluationId: string;
  readonly leaseId: string;
  readonly version: number;
  readonly serverTime: string;
  readonly expiresAt: string;
}

const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export function evaluationLeaseSafetyDeadline(
  receipt: EvaluationLeaseReceipt,
  requestStartedAt: number,
): number | undefined {
  if (
    receipt.evaluationId.length === 0 ||
    receipt.leaseId.length === 0 ||
    !Number.isSafeInteger(receipt.version) ||
    receipt.version < 0 ||
    !Number.isFinite(requestStartedAt) ||
    !timestampPattern.test(receipt.serverTime) ||
    !timestampPattern.test(receipt.expiresAt)
  )
    return undefined;
  const started = Date.parse(receipt.serverTime);
  const expires = Date.parse(receipt.expiresAt);
  const duration = expires - started;
  if (
    !Number.isSafeInteger(duration) ||
    duration <= 0 ||
    duration > evaluationLeasePolicy.leaseSeconds * 1000
  )
    return undefined;
  const deadline =
    requestStartedAt + duration - evaluationLeasePolicy.clientSafetyMarginSeconds * 1000;
  return Number.isFinite(deadline) ? deadline : undefined;
}

export function assessEvaluationLease(
  receipt: EvaluationLeaseReceipt,
  evaluationId: string,
  leaseId: string,
  requestStartedAt: number,
  now: number,
): { readonly kind: 'Held' | 'Lost' } {
  const deadline = evaluationLeaseSafetyDeadline(receipt, requestStartedAt);
  return {
    kind:
      deadline !== undefined &&
      Number.isFinite(now) &&
      now >= requestStartedAt &&
      now < deadline &&
      receipt.evaluationId === evaluationId &&
      receipt.leaseId === leaseId
        ? 'Held'
        : 'Lost',
  };
}

export type EvaluationLeaseRenewal =
  | { readonly kind: 'Renewed'; readonly lease: EvaluationLeaseReceipt }
  | { readonly kind: 'TooEarly' | 'Lost' | 'Invalid' };

export function renewEvaluationLease(
  current: EvaluationLeaseReceipt,
  observedAt: string,
): EvaluationLeaseRenewal {
  if (
    evaluationLeaseSafetyDeadline(current, 0) === undefined ||
    current.version < 1 ||
    !timestampPattern.test(observedAt)
  )
    return { kind: 'Invalid' };
  const now = Date.parse(observedAt);
  const expiry = Date.parse(current.expiresAt);
  if (!Number.isFinite(now) || new Date(now).toISOString() !== observedAt)
    return { kind: 'Invalid' };
  if (now >= expiry) return { kind: 'Lost' };
  if (now < expiry - evaluationLeasePolicy.renewalSeconds * 1_000) return { kind: 'TooEarly' };
  return {
    kind: 'Renewed',
    lease: {
      evaluationId: current.evaluationId,
      leaseId: current.leaseId,
      version: current.version + 1,
      serverTime: observedAt,
      expiresAt: new Date(now + evaluationLeasePolicy.leaseSeconds * 1_000).toISOString(),
    },
  };
}
