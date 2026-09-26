import {
  taskBudgetNames,
  type Run,
  type TaskBudgetName,
  type TaskBudgets,
} from '@devrandom/domain';

import type {
  EvidenceBudgetDebit,
  EvidenceProducer,
  EvidenceRecording,
} from '../evidence/evidence-recorder.js';

export interface RunBudgetAmount {
  readonly budget: TaskBudgetName;
  readonly amount: number;
}

const acceptedRunBudgetReservation = Symbol('AcceptedRunBudgetReservation');

export interface AcceptedRunBudgetReservation {
  readonly reservationId: number;
  readonly [acceptedRunBudgetReservation]: typeof acceptedRunBudgetReservation;
}

export type RunBudgetReservation =
  | { readonly kind: 'Reserved'; readonly reservation: AcceptedRunBudgetReservation }
  | { readonly kind: 'Exhausted'; readonly budget: TaskBudgetName }
  | { readonly kind: 'ReservationInvalid' };

export interface RunBudgetCommitmentInput {
  readonly producer: EvidenceProducer;
  readonly actual: readonly RunBudgetAmount[];
}

export type RunBudgetCommitment =
  | { readonly kind: 'Committed' }
  | { readonly kind: 'Exhausted'; readonly budget: TaskBudgetName }
  | { readonly kind: 'ReservationRejected' }
  | { readonly kind: 'OutboxBackpressure' }
  | { readonly kind: 'SecretDetected' }
  | { readonly kind: 'EvidenceIntegrityFailure' }
  | { readonly kind: 'Unavailable' };

export type RunBudgetSettlement =
  | Exclude<RunBudgetCommitment, { readonly kind: 'Committed' | 'ReservationRejected' }>
  | { readonly kind: 'Settled' }
  | { readonly kind: 'SettlementRejected' };

export type RunBudgetRelease =
  { readonly kind: 'Released' } | { readonly kind: 'ReservationRejected' };

export interface RunBudgetEvidence {
  recordBudgetDebit(debit: EvidenceBudgetDebit): EvidenceRecording;
}

export interface RunResourceBudgetOptions {
  readonly run: Run;
  readonly evidence: RunBudgetEvidence;
  readonly now: () => string;
}

interface HeldReservation {
  readonly capability: AcceptedRunBudgetReservation;
  readonly amounts: ReadonlyMap<TaskBudgetName, number>;
}

function evidenceCommitment(
  recording: EvidenceRecording,
): Exclude<RunBudgetCommitment, { readonly kind: 'Exhausted' | 'ReservationRejected' }> {
  switch (recording.kind) {
    case 'SecretDetected':
      return { kind: 'SecretDetected' };
    case 'Recorded':
      return { kind: 'Committed' };
    case 'OutboxBackpressure':
    case 'OutboxBoundReached':
      return { kind: 'OutboxBackpressure' };
    case 'ObservationRejected':
    case 'LocalStateCorruption':
      return { kind: 'EvidenceIntegrityFailure' };
    case 'Unavailable':
      return { kind: 'Unavailable' };
  }
}

function checkedAmounts(
  amounts: readonly RunBudgetAmount[],
  policy: 'Reservation' | 'Actual',
): ReadonlyMap<TaskBudgetName, number> | undefined {
  const checked = new Map<TaskBudgetName, number>();
  for (const amount of amounts) {
    if (
      checked.has(amount.budget) ||
      !Number.isSafeInteger(amount.amount) ||
      amount.amount < (policy === 'Actual' ? 0 : 1)
    ) {
      return undefined;
    }
    checked.set(amount.budget, amount.amount);
  }
  return checked.size === 0 ? undefined : checked;
}

export class RunResourceBudget {
  readonly runId: string;
  readonly #ceiling: TaskBudgets;
  readonly #evidence: RunBudgetEvidence;
  readonly #now: () => string;
  readonly #reserved = new Map<TaskBudgetName, number>();
  readonly #reservations = new Map<number, HeldReservation>();
  #consumed: TaskBudgets;
  #nextReservationId = 0;
  #admission: 'Open' | 'Settled' = 'Open';

  constructor(options: RunResourceBudgetOptions) {
    this.runId = options.run.binding.runId;
    this.#ceiling = Object.freeze({ ...options.run.binding.budget });
    this.#consumed = Object.freeze({ ...options.run.consumedBudget });
    this.#evidence = options.evidence;
    this.#now = options.now;
    for (const budget of taskBudgetNames) {
      this.#reserved.set(budget, 0);
    }
  }

  snapshot(): Readonly<TaskBudgets> {
    return Object.freeze({ ...this.#consumed });
  }

  reserve(amounts: readonly RunBudgetAmount[]): RunBudgetReservation {
    if (this.#admission === 'Settled') return { kind: 'ReservationInvalid' };
    const checked = checkedAmounts(amounts, 'Reservation');
    if (checked === undefined) {
      return { kind: 'ReservationInvalid' };
    }
    for (const [budget, amount] of checked) {
      const reserved = this.#reserved.get(budget);
      if (reserved === undefined) {
        return { kind: 'ReservationInvalid' };
      }
      const claimed = this.#consumed[budget] + reserved + amount;
      if (!Number.isSafeInteger(claimed) || claimed > this.#ceiling[budget]) {
        return { kind: 'Exhausted', budget };
      }
    }
    const capability: AcceptedRunBudgetReservation = {
      reservationId: this.#nextReservationId,
      [acceptedRunBudgetReservation]: acceptedRunBudgetReservation,
    };
    Object.freeze(capability);
    this.#nextReservationId += 1;
    for (const [budget, amount] of checked) {
      this.#reserved.set(budget, this.#reservedAmount(budget) + amount);
    }
    this.#reservations.set(capability.reservationId, {
      capability,
      amounts: checked,
    });
    return { kind: 'Reserved', reservation: capability };
  }

  commit(
    reservation: AcceptedRunBudgetReservation,
    input: RunBudgetCommitmentInput,
  ): RunBudgetCommitment {
    const held = this.#held(reservation);
    const actual = checkedAmounts(input.actual, 'Actual');
    if (held === undefined || actual === undefined) {
      return { kind: 'ReservationRejected' };
    }
    let exceededReservation: TaskBudgetName | undefined;
    for (const [budget, amount] of actual) {
      const reserved = held.amounts.get(budget);
      if (reserved === undefined) {
        this.#release(held);
        return { kind: 'ReservationRejected' };
      }
      const consumed = this.#consumed[budget] + amount;
      if (!Number.isSafeInteger(consumed)) {
        this.#release(held);
        return { kind: 'ReservationRejected' };
      }
      if (amount > reserved || consumed > this.#ceiling[budget]) exceededReservation ??= budget;
    }
    const recording = this.#recordActual(actual, input.producer);
    this.#release(held);
    if (recording.kind !== 'Committed') return recording;
    return exceededReservation === undefined
      ? { kind: 'Committed' }
      : { kind: 'Exhausted', budget: exceededReservation };
  }

  /** Final accounting of incurred effects; never grants permission for another effect. */
  settle(input: RunBudgetCommitmentInput): RunBudgetSettlement {
    if (this.#admission === 'Settled' || this.#reservations.size !== 0)
      return { kind: 'SettlementRejected' };
    const actual = checkedAmounts(input.actual, 'Actual');
    if (actual === undefined) return { kind: 'SettlementRejected' };
    let exceededCeiling: TaskBudgetName | undefined;
    for (const [budget, amount] of actual) {
      const consumed = this.#consumed[budget] + amount;
      if (!Number.isSafeInteger(consumed)) return { kind: 'SettlementRejected' };
      if (consumed > this.#ceiling[budget]) exceededCeiling ??= budget;
    }
    const recording = this.#recordActual(actual, input.producer);
    if (recording.kind !== 'Committed') return recording;
    this.#admission = 'Settled';
    return exceededCeiling === undefined
      ? { kind: 'Settled' }
      : { kind: 'Exhausted', budget: exceededCeiling };
  }

  #recordActual(
    actual: ReadonlyMap<TaskBudgetName, number>,
    producer: EvidenceProducer,
  ): ReturnType<typeof evidenceCommitment> {
    let nextConsumed = this.#consumed;
    const debits: EvidenceBudgetDebit['debits'][number][] = [];
    for (const [budget, amount] of actual) {
      if (amount === 0) continue;
      const consumed = nextConsumed[budget] + amount;
      debits.push({ kind: 'BudgetDebited', budget, amount, consumed });
      nextConsumed = { ...nextConsumed, [budget]: consumed };
    }
    if (debits.length > 0) {
      const recorded = evidenceCommitment(
        this.#evidence.recordBudgetDebit({
          occurredAt: this.#now(),
          producer,
          debits,
        }),
      );
      if (recorded.kind !== 'Committed') {
        return recorded;
      }
    }
    this.#consumed = Object.freeze(nextConsumed);
    return { kind: 'Committed' };
  }

  release(reservation: AcceptedRunBudgetReservation): RunBudgetRelease {
    const held = this.#held(reservation);
    if (held === undefined) {
      return { kind: 'ReservationRejected' };
    }
    this.#release(held);
    return { kind: 'Released' };
  }

  #held(reservation: AcceptedRunBudgetReservation): HeldReservation | undefined {
    const held = this.#reservations.get(reservation.reservationId);
    return held?.capability === reservation ? held : undefined;
  }

  #release(held: HeldReservation): void {
    for (const [budget, amount] of held.amounts) {
      this.#reserved.set(budget, this.#reservedAmount(budget) - amount);
    }
    this.#reservations.delete(held.capability.reservationId);
  }

  #reservedAmount(budget: TaskBudgetName): number {
    return this.#reserved.get(budget) ?? 0;
  }
}
