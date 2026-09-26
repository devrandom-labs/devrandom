export interface CodingElapsedInterval {
  readonly artifactSaid: string;
  readonly startedMonotonicMicroseconds: number;
  readonly finishedMonotonicMicroseconds: number;
}
/** Real parent time outside the eighteen coding intervals belongs to F. */
export function measureFinalizationElapsed(
  started: number,
  finished: number,
  intervals: readonly CodingElapsedInterval[],
):
  | { readonly kind: 'Measured'; readonly elapsedMilliseconds: number }
  | { readonly kind: 'Invalid' } {
  if (
    !Number.isSafeInteger(started) ||
    !Number.isSafeInteger(finished) ||
    started < 0 ||
    finished < started ||
    intervals.length !== 18 ||
    new Set(intervals.map((item) => item.artifactSaid)).size !== 18
  )
    return { kind: 'Invalid' };
  let previous = started;
  let excluded = 0;
  for (const interval of [...intervals].sort(
    (a, b) => a.startedMonotonicMicroseconds - b.startedMonotonicMicroseconds,
  )) {
    if (
      !/^[A-Z][A-Za-z0-9_-]{43}$/u.test(interval.artifactSaid) ||
      !Number.isSafeInteger(interval.startedMonotonicMicroseconds) ||
      !Number.isSafeInteger(interval.finishedMonotonicMicroseconds) ||
      interval.startedMonotonicMicroseconds < previous ||
      interval.finishedMonotonicMicroseconds < interval.startedMonotonicMicroseconds ||
      interval.finishedMonotonicMicroseconds > finished
    )
      return { kind: 'Invalid' };
    excluded += interval.finishedMonotonicMicroseconds - interval.startedMonotonicMicroseconds;
    previous = interval.finishedMonotonicMicroseconds;
  }
  return {
    kind: 'Measured',
    elapsedMilliseconds: Math.ceil((finished - started - excluded) / 1000),
  };
}
