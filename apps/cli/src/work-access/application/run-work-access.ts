import type { WorkAccessScope } from '@devrandom/protocol';
import type { LeaseClock } from '@devrandom/runtime';

import type { HostedRuns } from '../../run/application/baseline-run-admission.js';
import type { HostedEvidence } from '../../run/application/evidence-delivery.js';
import type { HostedEvidenceSeals } from '../../run/application/evidence-seal-delivery.js';

export interface RunWorkAccessGrant {
  readonly userAid: string;
  readonly credentialSaid: string;
  readonly clientInstanceId: string;
  readonly issuerAid: string;
  readonly scopes: readonly WorkAccessScope[];
  readonly deadline: number;
  readonly runs: Pick<HostedRuns, 'renewLease'>;
  readonly evidence: HostedEvidence & HostedEvidenceSeals;
  release(): Promise<void>;
}

export interface RunWorkAccessRenewal {
  readonly initialGrant: RunWorkAccessGrant;
  acquire(
    signal: AbortSignal,
  ): Promise<
    | { readonly kind: 'Granted'; readonly grant: RunWorkAccessGrant }
    | { readonly kind: 'Unavailable' }
  >;
}

// This owner selects authenticated transport. It cannot acquire a Run lease,
// change a Run incarnation, acknowledge evidence, or authorize local effects.
type GrantRetirement =
  | { readonly kind: 'Current' }
  | { readonly kind: 'Pending' }
  | { readonly kind: 'Releasing'; readonly completion: Promise<void> }
  | { readonly kind: 'Uncertain' }
  | { readonly kind: 'Released' };

interface HeldRunGrant {
  readonly grant: RunWorkAccessGrant;
  inFlight: number;
  retirement: GrantRetirement;
}

export class RunWorkAccess
  implements Pick<HostedRuns, 'renewLease'>, HostedEvidence, HostedEvidenceSeals
{
  readonly #renewal: RunWorkAccessRenewal;
  readonly #clock: LeaseClock;
  #current: HeldRunGrant;
  readonly #predecessors = new Set<HeldRunGrant>();
  #maintenance: 'Idle' | 'Running' | 'Stopped' = 'Idle';

  constructor(renewal: RunWorkAccessRenewal, clock: LeaseClock) {
    this.#renewal = renewal;
    this.#current = { grant: renewal.initialGrant, inFlight: 0, retirement: { kind: 'Current' } };
    this.#clock = clock;
  }

  async maintain(signal: AbortSignal): Promise<void> {
    if (this.#maintenance !== 'Idle') return;
    this.#maintenance = 'Running';
    let nextAttempt = this.#current.grant.deadline - 300_000;
    try {
      for (;;) {
        const wait = await this.#clock.waitUntil(nextAttempt, signal);
        if (wait.kind === 'Aborted') return;
        await this.#retireUnused();
        const acquisition = this.#renewal.acquire(signal);
        const stopped = Promise.withResolvers<{ readonly kind: 'Stopped' }>();
        const onAbort = () => {
          stopped.resolve({ kind: 'Stopped' });
        };
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
        const observed = acquisition.then(async (acquired) => {
          if (signal.aborted && acquired.kind === 'Granted') {
            await this.#retireUninstalled(acquired.grant);
            return { kind: 'Stopped' as const };
          }
          return { kind: 'Observed' as const, acquired };
        });
        const outcome = await Promise.race([observed, stopped.promise]).finally(() => {
          signal.removeEventListener('abort', onAbort);
        });
        if (outcome.kind === 'Stopped') return;
        const acquired = outcome.acquired;
        if (signal.aborted) {
          if (acquired.kind === 'Granted') await this.#retireUninstalled(acquired.grant);
          return;
        }
        nextAttempt = this.#clock.monotonicNow() + 10_000;
        if (acquired.kind !== 'Granted') continue;
        const replacement = acquired.grant;
        if (replacement === this.#current.grant) continue;
        if (!sameAuthority(this.#current.grant, replacement)) {
          await this.#retireUninstalled(replacement);
          continue;
        }
        if (replacement.deadline <= this.#clock.monotonicNow()) {
          await this.#retireUninstalled(replacement);
          continue;
        }
        if (replacement.deadline <= this.#current.grant.deadline) {
          // Keep the longer-lived grant and wait until the unused replacement
          // has expired before attempting to occupy another grant slot.
          nextAttempt = replacement.deadline;
          await this.#retireUninstalled(replacement);
          continue;
        }
        const previous = this.#current;
        const previousDeadline = previous.grant.deadline;
        previous.retirement = { kind: 'Pending' };
        this.#predecessors.add(previous);
        this.#current = { grant: replacement, inFlight: 0, retirement: { kind: 'Current' } };
        await this.#retire(previous);
        // At most two grants may overlap. Shortened server policies must not
        // cause a tight reacquisition loop while both slots are occupied.
        nextAttempt = Math.max(replacement.deadline - 300_000, previousDeadline);
      }
    } catch {
      // Existing lease renewal continues using the last admitted capability.
      // If authority becomes unavailable, the lease owner stops effects.
    } finally {
      this.#maintenance = 'Stopped';
      await this.#retireUnused();
    }
  }

  async #use<Result>(operation: (grant: RunWorkAccessGrant) => Promise<Result>): Promise<Result> {
    const held = this.#current;
    held.inFlight += 1;
    try {
      return await operation(held.grant);
    } finally {
      held.inFlight -= 1;
      if (held.retirement.kind !== 'Current') void this.#retire(held);
    }
  }

  async #retireUninstalled(grant: RunWorkAccessGrant): Promise<void> {
    if (grant === this.#current.grant) return;
    const predecessor = [...this.#predecessors].find((held) => held.grant === grant);
    if (predecessor) {
      await this.#retire(predecessor);
      return;
    }
    const held: HeldRunGrant = { grant, inFlight: 0, retirement: { kind: 'Pending' } };
    this.#predecessors.add(held);
    await this.#retire(held);
  }

  async #retireUnused(): Promise<void> {
    await Promise.all([...this.#predecessors].map((held) => this.#retire(held)));
  }

  async #retire(held: HeldRunGrant): Promise<void> {
    if (held.inFlight > 0 || held.retirement.kind === 'Current') return;
    if (held.retirement.kind === 'Releasing') return held.retirement.completion;
    if (held.retirement.kind === 'Released') return;
    const completion = Promise.resolve()
      .then(() => held.grant.release())
      .then(
        () => {
          held.retirement = { kind: 'Released' };
          this.#predecessors.delete(held);
        },
        () => {
          held.retirement = { kind: 'Uncertain' };
        },
      );
    held.retirement = { kind: 'Releasing', completion };
    await completion;
  }

  renewLease(...input: Parameters<HostedRuns['renewLease']>): ReturnType<HostedRuns['renewLease']> {
    return this.#use((grant) => grant.runs.renewLease(...input));
  }

  storeArtifact(
    ...input: Parameters<HostedEvidence['storeArtifact']>
  ): ReturnType<HostedEvidence['storeArtifact']> {
    return this.#use((grant) => grant.evidence.storeArtifact(...input));
  }

  appendBatch(
    ...input: Parameters<HostedEvidence['appendBatch']>
  ): ReturnType<HostedEvidence['appendBatch']> {
    return this.#use((grant) => grant.evidence.appendBatch(...input));
  }

  reconcileSeal(
    ...input: Parameters<HostedEvidenceSeals['reconcileSeal']>
  ): ReturnType<HostedEvidenceSeals['reconcileSeal']> {
    return this.#use((grant) => grant.evidence.reconcileSeal(...input));
  }
}

function sameAuthority(current: RunWorkAccessGrant, replacement: RunWorkAccessGrant): boolean {
  return (
    current.userAid === replacement.userAid &&
    current.credentialSaid === replacement.credentialSaid &&
    current.clientInstanceId === replacement.clientInstanceId &&
    current.issuerAid === replacement.issuerAid &&
    current.scopes.length === replacement.scopes.length &&
    current.scopes.every((scope) => replacement.scopes.includes(scope))
  );
}
