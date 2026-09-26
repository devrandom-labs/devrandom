import type { ExperienceRetrieval } from '@devrandom/runtime';

/** Freshly admitted Atlas sources can precede their searchable vectors. This bounded
 * readiness wait neither invents relevance nor changes the authenticated query. */
export async function retrieveIndexedExperience(
  query: Parameters<ExperienceRetrieval['retrieve']>[0],
  retrieval: ExperienceRetrieval,
  signal: AbortSignal,
): ReturnType<ExperienceRetrieval['retrieve']> {
  if (signal.aborted) return { kind: 'Unavailable' };
  const exactQuery = Object.freeze({ ...query });
  const started = performance.now();
  const maximumMilliseconds = 90_000;
  const deadline = new AbortController();
  const stop = AbortSignal.any([signal, deadline.signal]);
  const stopped = () => stop.aborted;
  let last: Awaited<ReturnType<ExperienceRetrieval['retrieve']>> = { kind: 'Unavailable' };
  const timer = setTimeout(() => {
    deadline.abort();
  }, maximumMilliseconds);
  let onAbort: () => void = () => {};
  const aborted = new Promise<Awaited<ReturnType<ExperienceRetrieval['retrieve']>>>((resolve) => {
    onAbort = () => {
      resolve(signal.aborted ? { kind: 'Unavailable' } : last);
    };
    stop.addEventListener('abort', onAbort, { once: true });
  });
  const read = async (): ReturnType<ExperienceRetrieval['retrieve']> => {
    while (!stopped() && performance.now() - started < maximumMilliseconds) {
      let observed: Awaited<ReturnType<ExperienceRetrieval['retrieve']>>;
      try {
        observed = await retrieval.retrieve(exactQuery);
      } catch {
        return { kind: 'Unavailable' };
      }
      if (signal.aborted) return { kind: 'Unavailable' };
      if (stopped() || performance.now() - started >= maximumMilliseconds) return last;
      last = observed;
      if (observed.kind !== 'IndexNotReady' && observed.kind !== 'Irrelevant') return observed;
      const remaining = maximumMilliseconds - (performance.now() - started);
      if (remaining <= 0) return last;
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(poll);
          stop.removeEventListener('abort', finish);
          resolve();
        };
        const poll = setTimeout(finish, Math.min(2_000, remaining));
        stop.addEventListener('abort', finish, { once: true });
        if (stopped()) finish();
      });
    }
    return signal.aborted ? { kind: 'Unavailable' } : last;
  };
  try {
    return await Promise.race([read(), aborted]);
  } finally {
    clearTimeout(timer);
    stop.removeEventListener('abort', onAbort);
    deadline.abort();
  }
}
