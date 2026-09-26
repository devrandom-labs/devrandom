import { taskBudgetCeilings } from '@devrandom/domain';
import type { WorkAccessScope } from '@devrandom/protocol';
import type { WorkAccessAcquisition } from './work-access-acquisition.js';

export type GrantedEvaluationAccess = Extract<WorkAccessAcquisition, { kind: 'Granted' }>;
/** Fresh proof under the already admitted caller; never new Evaluation authority. */
export interface EvaluationWorkAccessSupply {
  readonly initial: GrantedEvaluationAccess;
  acquire(signal: AbortSignal): Promise<WorkAccessAcquisition>;
  release(grant: GrantedEvaluationAccess): Promise<void>;
}

export interface EvaluationGrant {
  readonly id: string;
  readonly origin: string;
  readonly userAid: string;
  readonly credentialSaid: string;
  readonly clientInstanceId: string;
  readonly issuerAid: string;
  readonly scopes: readonly WorkAccessScope[];
  readonly policyFingerprint: string;
  readonly deadline: number;
  readonly observe: () => Promise<
    | { readonly kind: 'Active'; readonly remainingRequests: number }
    | { readonly kind: 'Denied' | 'Unavailable' }
  >;
  readonly release: () => Promise<void>;
}

// Scheduling headroom, not additional authority: half a full grant starts proof;
// 128 requests retain up to 5 minutes of 5-second position/renewal traffic (120)
// plus 8 already-started requests. Every send still requires the server grant.
const proofWatermark = Math.floor(taskBudgetCeilings.requestsPerGrant / 2);
const maintenanceReserve = 128;
const observationInterval = 32;
const retryMilliseconds = 10_000;

type Held<Grant> = {
  readonly grant: Grant;
  remaining: number | undefined;
  started: number;
  observedAt: number;
  inFlight: number;
  inFlightRequests: number;
  inspecting?: Promise<void>;
  releasing?: Promise<void>;
  releaseAfter: number;
  drain?: ReturnType<typeof Promise.withResolvers<undefined>>;
};

/** Selects authenticated transport only. Lease/effect/ACK law stays with its owners. */
export class EvaluationWorkAccess<Grant extends EvaluationGrant> {
  readonly #acquire: (
    signal: AbortSignal,
  ) => Promise<Grant | { readonly kind: 'Denied' } | undefined>;
  readonly #now: () => number;
  readonly #stop = new AbortController();
  readonly #signal: AbortSignal;
  readonly #authority: EvaluationGrant;
  readonly #retired = new Set<Held<Grant>>();
  #current: Held<Grant>;
  #acquiring: Promise<void> | undefined;
  #retryAt = 0;
  #blocked = false;

  constructor(
    initial: Grant,
    acquire: (signal: AbortSignal) => Promise<Grant | { readonly kind: 'Denied' } | undefined>,
    signal: AbortSignal,
    now: () => number = () => performance.now(),
  ) {
    this.#current = this.#hold(initial);
    this.#authority = { ...initial, scopes: [...initial.scopes] };
    this.#acquire = acquire;
    this.#now = now;
    this.#signal = AbortSignal.any([signal, this.#stop.signal]);
  }

  #stopped(): boolean {
    return this.#signal.aborted || this.#blocked;
  }

  #hold(grant: Grant): Held<Grant> {
    return {
      grant,
      remaining: undefined,
      started: 0,
      observedAt: 0,
      inFlight: 0,
      inFlightRequests: 0,
      releaseAfter: 0,
    };
  }

  #sameAuthority(grant: Grant): boolean {
    const current = this.#authority;
    return (
      current.origin === grant.origin &&
      current.userAid === grant.userAid &&
      current.credentialSaid === grant.credentialSaid &&
      current.clientInstanceId === grant.clientInstanceId &&
      current.issuerAid === grant.issuerAid &&
      current.policyFingerprint === grant.policyFingerprint &&
      current.scopes.length === grant.scopes.length &&
      current.scopes.every((scope) => grant.scopes.includes(scope))
    );
  }

  async #inspect(held: Held<Grant>): Promise<void> {
    if (held.inspecting !== undefined) return held.inspecting;
    if (held.remaining !== undefined && held.started - held.observedAt < observationInterval)
      return;
    const started = held.started;
    const inFlight = held.inFlightRequests;
    const inspection = (async () => {
      const observed = await held.grant.observe();
      if (
        observed.kind !== 'Active' ||
        !Number.isSafeInteger(observed.remainingRequests) ||
        observed.remainingRequests < 0 ||
        observed.remainingRequests > taskBudgetCeilings.requestsPerGrant
      ) {
        if (observed.kind === 'Denied') this.#blocked = true;
        throw new Error('EvaluationWorkAccessObservation');
      }
      // The observation can race sends. Subtract every possibly-unreflected
      // request and never restore allowance from a later/stale snapshot.
      const available = Math.max(
        0,
        observed.remainingRequests - inFlight - (held.started - started),
      );
      held.remaining =
        held.remaining === undefined ? available : Math.min(held.remaining, available);
      held.observedAt = started;
    })();
    held.inspecting = inspection;
    try {
      await inspection;
    } finally {
      delete held.inspecting;
      if (this.#retired.has(held)) void this.#retire(held);
    }
  }

  #replace(): void {
    if (this.#acquiring !== undefined || this.#stopped() || this.#now() < this.#retryAt) return;
    this.#retryAt = this.#now() + retryMilliseconds;
    this.#acquiring = (async () => {
      await Promise.all([...this.#retired].map((held) => this.#retire(held)));
      if (this.#retired.size !== 0 || this.#stopped()) return;
      const next = await this.#acquire(this.#signal);
      if (next !== undefined && 'kind' in next) {
        this.#blocked = true;
        return;
      }
      if (next === undefined || !('id' in next) || next.id === this.#current.grant.id) return;
      const replacement = this.#hold(next);
      if (this.#stopped() || !this.#sameAuthority(next) || next.deadline <= this.#now()) {
        this.#retired.add(replacement);
        await this.#retire(replacement);
        return;
      }
      try {
        await this.#inspect(replacement);
      } catch {
        this.#retired.add(replacement);
        await this.#retire(replacement);
        return;
      }
      if (this.#stopped() || (replacement.remaining ?? 0) <= proofWatermark) {
        this.#retired.add(replacement);
        await this.#retire(replacement);
        return;
      }
      const previous = this.#current;
      this.#current = replacement;
      this.#retryAt = 0;
      this.#retired.add(previous);
      await this.#retire(previous);
    })()
      .catch(() => {
        /* Unavailable fresh proof never authorizes a request. */
      })
      .finally(() => {
        this.#acquiring = undefined;
      });
  }

  async #retire(held: Held<Grant>): Promise<void> {
    if (!this.#retired.has(held)) return;
    if (held.inFlight > 0 || held.inspecting !== undefined || this.#now() < held.releaseAfter)
      return;
    if (held.releasing !== undefined) return held.releasing;
    held.releasing = held.grant.release().then(
      () => {
        this.#retired.delete(held);
      },
      () => {
        held.releaseAfter = this.#now() + retryMilliseconds;
      },
    );
    try {
      await held.releasing;
    } finally {
      delete held.releasing;
    }
  }

  async request<Output>(
    operation: (grant: Grant) => Promise<Output>,
    maintenance = false,
    maximumRequests = 1,
  ): Promise<Output> {
    if (!Number.isSafeInteger(maximumRequests) || maximumRequests < 1 || maximumRequests > 2)
      throw new Error('EvaluationRequestAccounting');
    for (;;) {
      if (this.#stopped()) throw new Error('EvaluationWorkAccessStopped');
      const held = this.#current;
      await this.#inspect(held);
      if (held !== this.#current) continue;
      if (held.grant.deadline <= this.#now()) throw new Error('EvaluationWorkAccessExpired');
      if ((held.remaining ?? 0) <= proofWatermark || held.grant.deadline - this.#now() <= 300_000)
        this.#replace();
      if (!maintenance && (held.remaining ?? 0) - maximumRequests < maintenanceReserve) {
        // Leave the old transport available to the independent lease pulse.
        // Waiting here is asynchronous, abortable, and never permits an effect.
        if (this.#acquiring === undefined) throw new Error('EvaluationWorkAccessUnavailable');
        await this.#untilStopped(this.#acquiring);
        if (held === this.#current) throw new Error('EvaluationWorkAccessUnavailable');
        continue;
      }
      if (this.#stopped() || (held.remaining ?? 0) < maximumRequests)
        throw new Error('EvaluationWorkAccessUnavailable');
      held.remaining = (held.remaining ?? 0) - maximumRequests;
      held.started += maximumRequests;
      if (held.inFlight === 0) held.drain = Promise.withResolvers<undefined>();
      held.inFlight++;
      held.inFlightRequests += maximumRequests;
      try {
        const outcome = await operation(held.grant);
        if (
          typeof outcome === 'object' &&
          outcome !== null &&
          'kind' in outcome &&
          (outcome.kind === 'Denied' ||
            outcome.kind === 'Rejected' ||
            outcome.kind === 'RequestRejected')
        )
          this.#blocked = true;
        return outcome;
      } finally {
        held.inFlight--;
        held.inFlightRequests -= maximumRequests;
        if (held.inFlight === 0) held.drain?.resolve(undefined);
        if (this.#retired.has(held)) void this.#retire(held);
      }
    }
  }

  async #untilStopped(completion: Promise<void>): Promise<void> {
    const stopped = Promise.withResolvers<undefined>();
    const abort = () => {
      stopped.resolve(undefined);
    };
    this.#signal.addEventListener('abort', abort, { once: true });
    if (this.#signal.aborted) abort();
    try {
      await Promise.race([completion, stopped.promise]);
    } finally {
      this.#signal.removeEventListener('abort', abort);
    }
  }

  async close(): Promise<void> {
    this.#stop.abort();
    this.#retired.add(this.#current);
    const held = [...this.#retired];
    await Promise.allSettled(held.map((item) => item.inspecting ?? Promise.resolve()));
    await Promise.all(
      held.map((item) =>
        item.inFlight === 0 ? Promise.resolve() : (item.drain?.promise ?? Promise.resolve()),
      ),
    );
    await Promise.all(held.map((item) => this.#retire(item)));
    // A late acquisition is observed by #replace and retires its own result.
  }
}
