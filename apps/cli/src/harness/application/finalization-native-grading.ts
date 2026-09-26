import type { TaskArtifactConstruction, ReceiptObservation } from '@devrandom/runtime';
export interface FinalizationNativeMeasurement {
  readonly kind: 'EvaluationFinalizationNativeElapsed';
  readonly method: 'ParentNativeRoundTripUpperBound';
  readonly operation: 'Build' | 'PublicObservation' | 'ProtectedObservation';
  readonly rawReceiptSaid: string;
  readonly cleanupReceiptSaid: string;
  readonly startedMonotonicMicroseconds: number;
  readonly finishedMonotonicMicroseconds: number;
  readonly elapsedMilliseconds: number;
  readonly childCommandDebitedSeconds: number;
}
interface FinalizationNativeGradingInputs {
  readonly maximumSeconds: number;
  readonly construction: TaskArtifactConstruction;
  readonly observation: ReceiptObservation;
  nowMicroseconds(): number;
  record(receipt: FinalizationNativeMeasurement): Promise<boolean>;
}
/** Trusted grading owns F native time separately from the stopped candidate's B metrics. */
export class FinalizationNativeGrading implements TaskArtifactConstruction, ReceiptObservation {
  readonly #input: FinalizationNativeGradingInputs;
  #consumed = 0;
  #unresolved = false;
  constructor(input: FinalizationNativeGradingInputs) {
    this.#input = input;
  }
  async #perform<T>(
    operation: FinalizationNativeMeasurement['operation'],
    signal: AbortSignal,
    effect: (signal: AbortSignal) => Promise<T>,
    identify: (outcome: T) => { rawReceiptSaid: string; cleanupReceiptSaid: string } | undefined,
  ): Promise<T | { kind: 'Invalid'; reason: 'EvidenceUnavailable' }> {
    const remaining = this.#input.maximumSeconds - this.#consumed;
    if (this.#unresolved || signal.aborted || !Number.isSafeInteger(remaining) || remaining <= 0)
      return { kind: 'Invalid', reason: 'EvidenceUnavailable' };
    this.#unresolved = true;
    const startedMonotonicMicroseconds = this.#input.nowMicroseconds();
    try {
      const outcome = await effect(
        AbortSignal.any([signal, AbortSignal.timeout(Math.min(2147483647, remaining * 1000))]),
      );
      const finishedMonotonicMicroseconds = this.#input.nowMicroseconds();
      const identity = identify(outcome);
      if (
        identity === undefined ||
        !Number.isSafeInteger(startedMonotonicMicroseconds) ||
        !Number.isSafeInteger(finishedMonotonicMicroseconds) ||
        startedMonotonicMicroseconds < 0 ||
        finishedMonotonicMicroseconds < startedMonotonicMicroseconds
      )
        return { kind: 'Invalid', reason: 'EvidenceUnavailable' };
      const elapsedMilliseconds = Math.ceil(
        (finishedMonotonicMicroseconds - startedMonotonicMicroseconds) / 1000,
      );
      const childCommandDebitedSeconds = Math.max(1, Math.ceil(elapsedMilliseconds / 1000));
      const recorded = await this.#input.record({
        kind: 'EvaluationFinalizationNativeElapsed',
        method: 'ParentNativeRoundTripUpperBound',
        operation,
        ...identity,
        startedMonotonicMicroseconds,
        finishedMonotonicMicroseconds,
        elapsedMilliseconds,
        childCommandDebitedSeconds,
      });
      this.#consumed += childCommandDebitedSeconds;
      if (!recorded || this.#consumed > this.#input.maximumSeconds)
        return { kind: 'Invalid', reason: 'EvidenceUnavailable' };
      this.#unresolved = false;
      return outcome;
    } catch {
      return { kind: 'Invalid', reason: 'EvidenceUnavailable' };
    }
  }
  build(
    input: Parameters<TaskArtifactConstruction['build']>[0],
  ): ReturnType<TaskArtifactConstruction['build']> {
    return this.#perform(
      'Build',
      input.signal,
      (signal) => this.#input.construction.build({ ...input, signal }),
      (outcome) =>
        outcome.kind === 'Invalid'
          ? undefined
          : {
              rawReceiptSaid: outcome.buildReceiptSaid,
              cleanupReceiptSaid: outcome.cleanupReceiptSaid,
            },
    );
  }
  observe(
    input: Parameters<ReceiptObservation['observe']>[0],
  ): ReturnType<ReceiptObservation['observe']> {
    return this.#perform(
      input.caseScope === 'Public' ? 'PublicObservation' : 'ProtectedObservation',
      input.signal,
      (signal) => this.#input.observation.observe({ ...input, signal }),
      (outcome) =>
        outcome.kind === 'Invalid'
          ? undefined
          : {
              rawReceiptSaid: outcome.rawObservationSaid,
              cleanupReceiptSaid: outcome.cleanupReceiptSaid,
            },
    );
  }
}
