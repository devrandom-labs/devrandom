import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExperienceRetrieval } from '@devrandom/runtime';
import { retrieveIndexedExperience } from './retrieve-indexed-experience.js';
const query = {
  taskId: 'task',
  taskRevisionSaid: 'revision',
  sourceInventorySaid: 'inventory',
  corpusSaid: 'corpus',
  failureQuery: 'exact public failure',
  maximumResults: 3 as const,
};
afterEach(() => vi.useRealTimers());
describe('fresh source indexing readiness', () => {
  it('repeats only the exact query until genuine indexed hits arrive', async () => {
    vi.useFakeTimers();
    const hit = {
      kind: 'Retrieved' as const,
      sources: [{ episodeSaid: 'episode', rawEvidenceSaid: 'raw', score: 0.81 }],
      queryReceiptSaid: 'receipt',
      chargedMicroUsd: 0,
    };
    const retrieve = vi
      .fn<ExperienceRetrieval['retrieve']>()
      .mockResolvedValueOnce({ kind: 'IndexNotReady' })
      .mockResolvedValueOnce({ kind: 'Irrelevant' })
      .mockResolvedValue(hit);
    const pending = retrieveIndexedExperience(query, { retrieve }, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(4000);
    expect(await pending).toEqual(hit);
    expect(retrieve.mock.calls).toEqual([[query], [query], [query]]);
  });
  it('returns permanent irrelevance unchanged after the bounded ninety seconds', async () => {
    vi.useFakeTimers();
    const retrieve = vi
      .fn<ExperienceRetrieval['retrieve']>()
      .mockResolvedValue({ kind: 'Irrelevant' });
    const pending = retrieveIndexedExperience(query, { retrieve }, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(90000);
    expect(await pending).toEqual({ kind: 'Irrelevant' });
    const count = retrieve.mock.calls.length;
    expect(count).toBeLessThanOrEqual(45);
    await vi.advanceTimersByTimeAsync(10000);
    expect(retrieve).toHaveBeenCalledTimes(count);
  });
  it.each(['Denied', 'Unavailable'] as const)('does not retry %s', async (kind) => {
    const retrieve = vi.fn<ExperienceRetrieval['retrieve']>().mockResolvedValue({ kind });
    expect(
      await retrieveIndexedExperience(query, { retrieve }, new AbortController().signal),
    ).toEqual({ kind });
    expect(retrieve).toHaveBeenCalledTimes(1);
  });
  it('honors preparation cancellation while waiting without another query', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const retrieve = vi
      .fn<ExperienceRetrieval['retrieve']>()
      .mockResolvedValue({ kind: 'Irrelevant' });
    const pending = retrieveIndexedExperience(query, { retrieve }, controller.signal);
    await vi.advanceTimersByTimeAsync(1000);
    controller.abort();
    expect(await pending).toEqual({ kind: 'Unavailable' });
    await vi.advanceTimersByTimeAsync(10000);
    expect(retrieve).toHaveBeenCalledTimes(1);
  });
  it('bounds a stalled hosted read and launches no late retries', async () => {
    vi.useFakeTimers();
    const retrieve = vi
      .fn<ExperienceRetrieval['retrieve']>()
      .mockReturnValue(new Promise(() => {}));
    const pending = retrieveIndexedExperience(query, { retrieve }, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(90000);
    expect(await pending).toEqual({ kind: 'Unavailable' });
    expect(retrieve).toHaveBeenCalledTimes(1);
  });
});

it('counts hosted request time inside the readiness deadline and preserves the last failure', async () => {
  vi.useFakeTimers();
  const retrieve = vi.fn<ExperienceRetrieval['retrieve']>().mockImplementation(
    () =>
      new Promise((resolve) =>
        setTimeout(() => {
          resolve({ kind: 'IndexNotReady' });
        }, 60000),
      ),
  );
  const pending = retrieveIndexedExperience(query, { retrieve }, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(90000);
  expect(await pending).toEqual({ kind: 'IndexNotReady' });
  expect(retrieve).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(90000);
  expect(retrieve).toHaveBeenCalledTimes(2);
});
it('does not read when the preparation deadline has already aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  const retrieve = vi.fn<ExperienceRetrieval['retrieve']>();
  expect(await retrieveIndexedExperience(query, { retrieve }, controller.signal)).toEqual({
    kind: 'Unavailable',
  });
  expect(retrieve).not.toHaveBeenCalled();
});
