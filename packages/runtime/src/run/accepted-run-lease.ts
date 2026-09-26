import type { HeldToolLease, ToolLeaseInspection } from '../tool-gateway/tool-gateway.js';
import {
  runLeaseRenewalMatches,
  runLeaseSafetyDeadline,
  type RunLeaseAcceptances,
  type RunLeaseReceipt,
} from './lease-keeper.js';

export interface AcceptedRunLeaseClock {
  monotonicNow(): number;
}

type AcceptedLeaseState =
  | {
      readonly kind: 'Accepted';
      readonly receipt: RunLeaseReceipt;
      readonly stopBefore: number;
    }
  | { readonly kind: 'Lost' }
  | { readonly kind: 'Unavailable' };

export class AcceptedRunLease implements HeldToolLease, RunLeaseAcceptances {
  readonly #clock: AcceptedRunLeaseClock;
  #state: AcceptedLeaseState;

  constructor(receipt: RunLeaseReceipt, clock: AcceptedRunLeaseClock, requestStartedAt: number) {
    this.#clock = clock;
    const stopBefore = runLeaseSafetyDeadline(requestStartedAt, receipt);
    this.#state =
      stopBefore === undefined
        ? { kind: 'Unavailable' }
        : { kind: 'Accepted', receipt, stopBefore };
  }

  accept(receipt: RunLeaseReceipt, requestStartedAt: number): void {
    if (this.#state.kind !== 'Accepted') {
      return;
    }
    const receivedAt = this.#clock.monotonicNow();
    if (!Number.isFinite(receivedAt) || !Number.isFinite(requestStartedAt)) {
      this.#state = { kind: 'Unavailable' };
      return;
    }
    if (
      requestStartedAt > receivedAt ||
      receivedAt >= this.#state.stopBefore ||
      !runLeaseRenewalMatches(this.#state.receipt, receipt)
    ) {
      this.#state = { kind: 'Lost' };
      return;
    }
    const stopBefore = runLeaseSafetyDeadline(requestStartedAt, receipt);
    this.#state =
      stopBefore === undefined || receivedAt >= stopBefore
        ? { kind: 'Lost' }
        : { kind: 'Accepted', receipt, stopBefore };
  }

  inspect(input: {
    readonly runId: string;
    readonly incarnationId: string;
  }): Promise<ToolLeaseInspection> {
    if (this.#state.kind !== 'Accepted') {
      return Promise.resolve({ kind: this.#state.kind });
    }
    const now = this.#clock.monotonicNow();
    if (!Number.isFinite(now)) {
      this.#state = { kind: 'Unavailable' };
      return Promise.resolve({ kind: 'Unavailable' });
    }
    if (
      input.runId !== this.#state.receipt.runId ||
      input.incarnationId !== this.#state.receipt.incarnationId
    ) {
      return Promise.resolve({ kind: 'Lost' });
    }
    if (now >= this.#state.stopBefore) {
      this.#state = { kind: 'Lost' };
      return Promise.resolve({ kind: 'Lost' });
    }
    return Promise.resolve({ kind: 'Held' });
  }
}
