import { runLeasePolicy } from '@devrandom/domain';

export interface RunLeaseReceipt {
  readonly runId: string;
  readonly incarnationId: string;
  readonly runVersion: number;
  readonly serverTime: string;
  readonly expiresAt: string;
}

export interface RunLeaseRenewalCommand {
  readonly runId: string;
  readonly incarnationId: string;
  readonly expectedRunVersion: number;
}

export type RunLeaseRenewal =
  | { readonly kind: 'Renewed'; readonly receipt: RunLeaseReceipt }
  | { readonly kind: 'Rejected' }
  | { readonly kind: 'Unavailable' };

export interface RunLeaseAuthority {
  renew(command: RunLeaseRenewalCommand): Promise<RunLeaseRenewal>;
}

export interface RunLeaseAcceptances {
  accept(receipt: RunLeaseReceipt, requestStartedAt: number): void;
}

export type LeaseWait = { readonly kind: 'Reached' } | { readonly kind: 'Aborted' };

export interface LeaseClock {
  monotonicNow(): number;
  waitUntil(deadline: number, signal: AbortSignal): Promise<LeaseWait>;
}

function signalIsAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

export type RunLeaseKeeping =
  | { readonly kind: 'StoppedBySupervisor'; readonly latestRunVersion: number }
  | { readonly kind: 'LeaseLost'; readonly lastAcceptedRunVersion: number }
  | { readonly kind: 'LeaseReceiptRejected'; readonly lastAcceptedRunVersion: number };

function remainingLeaseMilliseconds(receipt: RunLeaseReceipt): number | undefined {
  const serverTime = Date.parse(receipt.serverTime);
  const expiresAt = Date.parse(receipt.expiresAt);
  const duration = expiresAt - serverTime;
  return Number.isSafeInteger(duration) &&
    duration > 0 &&
    duration <= runLeasePolicy.leaseSeconds * 1_000
    ? duration
    : undefined;
}

export function runLeaseRenewalMatches(prior: RunLeaseReceipt, renewal: RunLeaseReceipt): boolean {
  return (
    renewal.runId === prior.runId &&
    renewal.incarnationId === prior.incarnationId &&
    renewal.runVersion === prior.runVersion + 1 &&
    remainingLeaseMilliseconds(renewal) !== undefined
  );
}

export function runLeaseSafetyDeadline(
  receivedAt: number,
  receipt: RunLeaseReceipt,
): number | undefined {
  if (!Number.isFinite(receivedAt)) {
    return undefined;
  }
  const duration = remainingLeaseMilliseconds(receipt);
  if (duration === undefined) {
    return undefined;
  }
  const deadline = receivedAt + duration - runLeasePolicy.clientSafetyMarginSeconds * 1_000;
  return Number.isFinite(deadline) ? deadline : undefined;
}

export async function keepRunLease(
  initialReceipt: RunLeaseReceipt,
  initialReceivedAt: number,
  authority: RunLeaseAuthority,
  clock: LeaseClock,
  signal: AbortSignal,
  acceptances: RunLeaseAcceptances,
): Promise<RunLeaseKeeping> {
  let accepted = initialReceipt;
  let acceptedAt = initialReceivedAt;
  let stopBefore = runLeaseSafetyDeadline(acceptedAt, accepted);
  if (stopBefore === undefined) {
    return { kind: 'LeaseReceiptRejected', lastAcceptedRunVersion: accepted.runVersion };
  }
  while (!signal.aborted) {
    if (clock.monotonicNow() >= stopBefore) {
      return { kind: 'LeaseLost', lastAcceptedRunVersion: accepted.runVersion };
    }
    const renewalAt = Math.min(acceptedAt + runLeasePolicy.renewalSeconds * 1_000, stopBefore);
    const wait = await clock.waitUntil(renewalAt, signal);
    if (wait.kind === 'Aborted' || signalIsAborted(signal)) {
      return { kind: 'StoppedBySupervisor', latestRunVersion: accepted.runVersion };
    }
    if (clock.monotonicNow() >= stopBefore) {
      return { kind: 'LeaseLost', lastAcceptedRunVersion: accepted.runVersion };
    }
    const requestStartedAt = clock.monotonicNow();
    const waiting = new AbortController();
    const renewal = await Promise.race([
      Promise.resolve()
        .then(() =>
          authority.renew({
            runId: accepted.runId,
            incarnationId: accepted.incarnationId,
            expectedRunVersion: accepted.runVersion,
          }),
        )
        .catch((): RunLeaseRenewal => ({ kind: 'Unavailable' })),
      clock.waitUntil(stopBefore, AbortSignal.any([signal, waiting.signal])).then(
        (deadline): RunLeaseRenewal => ({
          kind: deadline.kind === 'Reached' ? 'Rejected' : 'Unavailable',
        }),
        (): RunLeaseRenewal => ({ kind: 'Unavailable' }),
      ),
    ]);
    waiting.abort();
    const receivedAt = clock.monotonicNow();
    if (signalIsAborted(signal)) {
      return { kind: 'StoppedBySupervisor', latestRunVersion: accepted.runVersion };
    }
    if (receivedAt >= stopBefore || renewal.kind !== 'Renewed') {
      return { kind: 'LeaseLost', lastAcceptedRunVersion: accepted.runVersion };
    }
    if (!runLeaseRenewalMatches(accepted, renewal.receipt)) {
      return { kind: 'LeaseReceiptRejected', lastAcceptedRunVersion: accepted.runVersion };
    }
    const renewedDeadline = runLeaseSafetyDeadline(requestStartedAt, renewal.receipt);
    if (renewedDeadline === undefined || receivedAt >= renewedDeadline) {
      return { kind: 'LeaseReceiptRejected', lastAcceptedRunVersion: accepted.runVersion };
    }
    accepted = renewal.receipt;
    acceptedAt = requestStartedAt;
    stopBefore = renewedDeadline;
    acceptances.accept(accepted, requestStartedAt);
  }
  return { kind: 'StoppedBySupervisor', latestRunVersion: accepted.runVersion };
}

export class MonotonicLeaseClock implements LeaseClock {
  monotonicNow(): number {
    return performance.now();
  }

  waitUntil(deadline: number, signal: AbortSignal): Promise<LeaseWait> {
    if (signal.aborted) {
      return Promise.resolve({ kind: 'Aborted' });
    }
    return new Promise((resolve) => {
      const complete = (outcome: LeaseWait) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', aborted);
        resolve(outcome);
      };
      const aborted = () => {
        complete({ kind: 'Aborted' });
      };
      const timer = setTimeout(
        () => {
          complete({ kind: 'Reached' });
        },
        Math.max(0, deadline - this.monotonicNow()),
      );
      signal.addEventListener('abort', aborted, { once: true });
    });
  }
}
