import { workAccessPolicy } from '../domain/work-access-policy.js';
import type {
  WorkAccessAttemptQuota,
  WorkAccessAttemptQuotaDisposition,
} from '../application/work-access-quota.js';

interface SourceWindow {
  readonly startedAt: number;
  readonly admittedAttempts: number;
}

export class BoundedWorkAccessAttemptQuota implements WorkAccessAttemptQuota {
  readonly #now: () => number;
  readonly #sources = new Map<string, SourceWindow>();

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  admit(sourceAddress: string): WorkAccessAttemptQuotaDisposition {
    const now = this.#now();
    this.#discardElapsedWindows(now);
    const current = this.#sources.get(sourceAddress);
    if (current === undefined) {
      if (this.#sources.size >= workAccessPolicy.globalNonterminalAttempts) {
        return { kind: 'AttemptRateExceeded' };
      }
      this.#sources.set(sourceAddress, { startedAt: now, admittedAttempts: 1 });
      return { kind: 'AttemptQuotaAdmitted' };
    }
    if (current.admittedAttempts >= workAccessPolicy.publicAttemptsPerLoopbackMinute) {
      return { kind: 'AttemptRateExceeded' };
    }
    this.#sources.set(sourceAddress, {
      startedAt: current.startedAt,
      admittedAttempts: current.admittedAttempts + 1,
    });
    return { kind: 'AttemptQuotaAdmitted' };
  }

  #discardElapsedWindows(now: number): void {
    for (const [sourceAddress, window] of this.#sources) {
      if (now - window.startedAt >= 60_000) {
        this.#sources.delete(sourceAddress);
      }
    }
  }
}
