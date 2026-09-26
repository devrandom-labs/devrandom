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
