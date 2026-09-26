import { expect, it, vi } from 'vitest';
import { EvaluationWorkAccess, type EvaluationGrant } from './evaluation-work-access.js';

function grant(id: string, remaining = 2000): EvaluationGrant {
  return {
    id,
    origin: 'http://127.0.0.1:3000',
    userAid: 'user',
    credentialSaid: 'credential',
    clientInstanceId: 'client',
    issuerAid: 'issuer',
    scopes: ['evaluation:append', 'evaluation:renew'],
    policyFingerprint: 'policy',
    deadline: 1_800_000,
    observe: vi.fn(() =>
      Promise.resolve({ kind: 'Active' as const, remainingRequests: remaining }),
    ),
    release: vi.fn(() => Promise.resolve()),
  };
}

it('stops new sends when fresh proof explicitly denies authority', async () => {
  const acquire = vi.fn(() => Promise.resolve({ kind: 'Denied' as const }));
  const access = new EvaluationWorkAccess(
    grant('first', 1000),
    acquire,
    new AbortController().signal,
    () => 0,
  );
  await access.request(() => Promise.resolve({ kind: 'Read' }));
  await vi.waitFor(() => {
    expect(acquire).toHaveBeenCalledTimes(1);
  });
  await expect(access.request(() => Promise.resolve({ kind: 'Read' }))).rejects.toThrow('Stopped');
  await access.close();
});

it('uses exact observation, keeps proof single-flight, and drains the predecessor before release', async () => {
  const first = grant('first', 1000);
  const next = grant('next');
  const proof = Promise.withResolvers<EvaluationGrant | undefined>();
  const acquire = vi.fn(() => proof.promise);
  const stopped = new AbortController();
  const access = new EvaluationWorkAccess(first, acquire, stopped.signal, () => 0);
  const pending = Promise.withResolvers<{ kind: 'Acknowledged' }>();
  const started = Promise.withResolvers<undefined>();
  const inFlight = access.request((held) => {
    expect(held).toBe(first);
    started.resolve(undefined);
    return pending.promise;
  });
  await started.promise;
  await access.request((held) => {
    expect(held).toBe(first);
    return Promise.resolve({ kind: 'Read' });
  }, true);
  expect(acquire).toHaveBeenCalledTimes(1);
  proof.resolve(next);
  await vi.waitFor(() => {
    expect(next.observe).toHaveBeenCalledTimes(1);
  });
  await access.request((held) => {
    expect(held).toBe(next);
    return Promise.resolve({ kind: 'Read' });
  });
  expect(first.release).not.toHaveBeenCalled();
  pending.resolve({ kind: 'Acknowledged' });
  expect(await inFlight).toEqual({ kind: 'Acknowledged' });
  await vi.waitFor(() => {
    expect(first.release).toHaveBeenCalledTimes(1);
  });
  await access.close();
});

it.each([
  'userAid',
  'credentialSaid',
  'clientInstanceId',
  'issuerAid',
  'origin',
  'policyFingerprint',
  'scopes',
] as const)('rejects changed %s without installing expanded authority', async (field) => {
  const first = grant('first', 1000);
  const replacement: EvaluationGrant = {
    ...grant('next'),
    [field]: field === 'scopes' ? ['evaluation:append'] : 'foreign',
  };
  const access = new EvaluationWorkAccess(
    first,
    () => Promise.resolve(replacement),
    new AbortController().signal,
    () => 0,
  );
  await access.request((held) => {
    expect(held).toBe(first);
    return Promise.resolve({ kind: 'Read' });
  });
  await vi.waitFor(() => {
    expect(replacement.release).toHaveBeenCalledTimes(1);
  });
  await access.request((held) => {
    expect(held).toBe(first);
    return Promise.resolve({ kind: 'Read' });
  });
  await access.close();
});

it('does not infer a renewable grant from an unknown denial or retry its command', async () => {
  const original = grant('first');
  const acquire = vi.fn(() => Promise.resolve(grant('next')));
  const access = new EvaluationWorkAccess(original, acquire, new AbortController().signal, () => 0);
  const send = vi.fn(() => Promise.resolve({ kind: 'Denied' }));
  expect(await access.request(send)).toEqual({ kind: 'Denied' });
  await expect(access.request(send)).rejects.toThrow('Stopped');
  expect(send).toHaveBeenCalledTimes(1);
  expect(acquire).not.toHaveBeenCalled();
  await access.close();
});

it('blocks revoked observation before any request or fresh proof', async () => {
  const original = {
    ...grant('first'),
    observe: () => Promise.resolve({ kind: 'Denied' as const }),
  };
  const acquire = vi.fn(() => Promise.resolve(grant('next')));
  const access = new EvaluationWorkAccess(original, acquire, new AbortController().signal, () => 0);
  const send = vi.fn();
  await expect(access.request(send)).rejects.toThrow('Observation');
  expect(send).not.toHaveBeenCalled();
  expect(acquire).not.toHaveBeenCalled();
  await access.close();
});

it('cancels a request awaiting proof and releases a late grant without installing it', async () => {
  const original = grant('first', 128);
  const proof = Promise.withResolvers<EvaluationGrant | undefined>();
  const acquire = vi.fn(() => proof.promise);
  const stopped = new AbortController();
  const access = new EvaluationWorkAccess(original, acquire, stopped.signal, () => 0);
  const send = vi.fn(() => Promise.resolve({ kind: 'Read' }));
  const waiting = access.request(send);
  const rejected = expect(waiting).rejects.toThrow();
  await vi.waitFor(() => {
    expect(acquire).toHaveBeenCalledTimes(1);
  });
  stopped.abort();
  await rejected;
  await access.close();
  const late = grant('late');
  proof.resolve(late);
  await vi.waitFor(() => {
    expect(late.release).toHaveBeenCalledTimes(1);
  });
  expect(send).not.toHaveBeenCalled();
  expect(late.observe).not.toHaveBeenCalled();
});

it('leaves request headroom available to the lease owner while ordinary traffic awaits proof', async () => {
  const original = grant('first', 128);
  const proof = Promise.withResolvers<EvaluationGrant | undefined>();
  const acquire = vi.fn(() => proof.promise);
  const access = new EvaluationWorkAccess(original, acquire, new AbortController().signal, () => 0);
  const send = vi.fn(() => Promise.resolve({ kind: 'Acknowledged' }));
  const waiting = access.request(send);
  await vi.waitFor(() => {
    expect(acquire).toHaveBeenCalledTimes(1);
  });
  expect(await access.request(() => Promise.resolve({ kind: 'Renewed' }), true)).toEqual({
    kind: 'Renewed',
  });
  expect(send).not.toHaveBeenCalled();
  proof.resolve(grant('next'));
  expect(await waiting).toEqual({ kind: 'Acknowledged' });
  await access.close();
});

it('never restores consumed request allowance from a stale observation', async () => {
  const original = grant('first', 132);
  const access = new EvaluationWorkAccess(
    original,
    () => Promise.resolve(undefined),
    new AbortController().signal,
    () => 0,
  );
  const send = vi.fn(() => Promise.resolve({ kind: 'Read' }));
  for (let index = 0; index < 132; index++) await access.request(send, true);
  await expect(access.request(send, true)).rejects.toThrow('Unavailable');
  expect(send).toHaveBeenCalledTimes(132);
  expect(original.observe).toHaveBeenCalledTimes(5);
  await access.close();
});

it('does not acquire a third grant while predecessor release is uncertain', async () => {
  const first = {
    ...grant('first', 1000),
    release: vi.fn(() => Promise.reject(new Error('lost release response'))),
  };
  const next = grant('next');
  const acquire = vi.fn(() => Promise.resolve(next));
  const access = new EvaluationWorkAccess(first, acquire, new AbortController().signal, () => 0);
  await access.request(() => Promise.resolve({ kind: 'Read' }));
  await vi.waitFor(() => {
    expect(first.release).toHaveBeenCalledTimes(1);
  });
  for (let index = 0; index < 1100; index++)
    await access.request(() => Promise.resolve({ kind: 'Read' }));
  expect(acquire).toHaveBeenCalledTimes(1);
  expect(first.release).toHaveBeenCalledTimes(1);
  await access.close();
});

it('drains a pending predecessor observation before release and keeps the replacement usable', async () => {
  const first = grant('first', 1000);
  const observed = Promise.withResolvers<{ kind: 'Active'; remainingRequests: number }>();
  const observe = vi.mocked(first.observe);
  observe.mockResolvedValueOnce({ kind: 'Active', remainingRequests: 1000 });
  observe.mockImplementationOnce(() => observed.promise);
  const proof = Promise.withResolvers<EvaluationGrant>();
  const next = grant('next');
  const access = new EvaluationWorkAccess(
    first,
    () => proof.promise,
    new AbortController().signal,
    () => 0,
  );
  for (let index = 0; index < 32; index++) await access.request(() => Promise.resolve('sent'));
  const pending = access.request((held) => Promise.resolve(held.id));
  await vi.waitFor(() => {
    expect(observe).toHaveBeenCalledTimes(2);
  });
  proof.resolve(next);
  await vi.waitFor(() => {
    expect(next.observe).toHaveBeenCalledTimes(1);
  });
  expect(first.release).not.toHaveBeenCalled();
  observed.resolve({ kind: 'Active', remainingRequests: 968 });
  expect(await pending).toBe('next');
  await vi.waitFor(() => {
    expect(first.release).toHaveBeenCalledTimes(1);
  });
  expect(await access.request((held) => Promise.resolve(held.id))).toBe('next');
  await access.close();
});

it('close waits for an in-flight current-grant observation before release', async () => {
  const observed = Promise.withResolvers<{ kind: 'Active'; remainingRequests: number }>();
  const first = { ...grant('first'), observe: vi.fn(() => observed.promise) };
  const access = new EvaluationWorkAccess(
    first,
    () => Promise.resolve(undefined),
    new AbortController().signal,
    () => 0,
  );
  const pending = access.request(() => Promise.resolve('sent'));
  const rejected = expect(pending).rejects.toThrow();
  const closing = access.close();
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  expect(first.release).not.toHaveBeenCalled();
  observed.resolve({ kind: 'Active', remainingRequests: 2000 });
  await rejected;
  await closing;
  expect(first.release).toHaveBeenCalledTimes(1);
});
