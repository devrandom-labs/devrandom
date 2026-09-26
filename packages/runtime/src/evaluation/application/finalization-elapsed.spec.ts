import { expect, it } from 'vitest';
import {
  measureFinalizationElapsed,
  measureResearchPreparationElapsed,
} from './finalization-elapsed.js';
it('subtracts all eighteen disjoint real coding intervals without double billing', () => {
  const intervals = Array.from({ length: 18 }, (_, i) => ({
    artifactSaid: `E${String(i).padStart(43, '0')}`,
    startedMonotonicMicroseconds: i * 2000 + 100,
    finishedMonotonicMicroseconds: i * 2000 + 1100,
  }));
  expect(measureFinalizationElapsed(0, 36000, intervals)).toEqual({
    kind: 'Measured',
    elapsedMilliseconds: 18,
  });
  expect(
    measureFinalizationElapsed(
      0,
      36000,
      intervals.map((item, index) =>
        index === 0 ? { ...item, artifactSaid: intervals[1]?.artifactSaid ?? '' } : item,
      ),
    ),
  ).toEqual({ kind: 'Invalid' });
  expect(measureFinalizationElapsed(0, 35000, intervals)).toEqual({ kind: 'Invalid' });
});
it('measures research orchestration outside this invocation’s exact paid intervals', () => {
  expect(measureResearchPreparationElapsed(1000, 5000, [])).toEqual({
    kind: 'Measured',
    elapsedMilliseconds: 4,
  });
  expect(
    measureResearchPreparationElapsed(1000, 5000, [
      {
        artifactSaid: `E${'a'.repeat(43)}`,
        startedMonotonicMicroseconds: 2000,
        finishedMonotonicMicroseconds: 4000,
      },
    ]),
  ).toEqual({ kind: 'Measured', elapsedMilliseconds: 2 });
  expect(
    measureResearchPreparationElapsed(1000, 5000, [
      {
        artifactSaid: `E${'a'.repeat(43)}`,
        startedMonotonicMicroseconds: 0,
        finishedMonotonicMicroseconds: 4000,
      },
    ]),
  ).toEqual({ kind: 'Invalid' });
});
