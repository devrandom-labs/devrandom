import { prepareEvidenceArtifact } from '@devrandom/protocol';
import { keepRunLease, MonotonicLeaseClock } from '@devrandom/runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HostedRuns } from '../../run/application/baseline-run-admission.js';
import { HostedRunLeaseAuthority } from '../../run/infrastructure/hosted-run-lease-authority.js';
import {
  RunWorkAccess,
  type RunWorkAccessGrant,
  type RunWorkAccessRenewal,
} from './run-work-access.js';

function grant(deadline: number) {
  return {
    userAid: 'user',
    credentialSaid: 'credential',
    clientInstanceId: 'client',
    issuerAid: 'issuer',
    scopes: ['run:execute', 'evidence:append', 'evidence:seal'],
    deadline,
    runs: { renewLease: vi.fn(() => Promise.resolve({ kind: 'ServerUnavailable' as const })) },
    evidence: {
      storeArtifact: vi.fn(() => Promise.resolve({ kind: 'ServerUnavailable' as const })),
      appendBatch: vi.fn(() => Promise.resolve({ kind: 'ServerUnavailable' as const })),
      reconcileSeal: vi.fn(() => Promise.resolve({ kind: 'ServerUnavailable' as const })),
    },
    release: vi.fn(() => Promise.resolve()),
  } satisfies RunWorkAccessGrant;
}

const command = { version: 1 as const, expectedRunVersion: 7 };

afterEach(() => vi.useRealTimers());

describe('active Run Work Access', () => {
  it('joins promptly after cancellation and retires a late grant without installing it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const original = grant(1_800_000);
    const replacement = grant(3_300_000);
    const pending = Promise.withResolvers<Awaited<ReturnType<RunWorkAccessRenewal['acquire']>>>();
    const access = new RunWorkAccess(
      { initialGrant: original, acquire: () => pending.promise },
      new MonotonicLeaseClock(),
    );
    const stopped = new AbortController();
    let joined = false;
    const maintenance = access.maintain(stopped.signal).then(() => {
      joined = true;
    });
    await vi.advanceTimersByTimeAsync(1_500_000);
    stopped.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(joined).toBe(true);
    pending.resolve({ kind: 'Granted', grant: replacement });
    await vi.advanceTimersByTimeAsync(0);
    expect(replacement.release).toHaveBeenCalledOnce();
    expect(original.release).not.toHaveBeenCalled();
    await maintenance;
  });

  it('keeps the current bearer when a late cancelled acquisition returns the same grant', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const original = grant(1_800_000);
    const pending = Promise.withResolvers<Awaited<ReturnType<RunWorkAccessRenewal['acquire']>>>();
    const access = new RunWorkAccess(
      { initialGrant: original, acquire: () => pending.promise },
      new MonotonicLeaseClock(),
    );
    const stopped = new AbortController();
    const maintenance = access.maintain(stopped.signal);
    await vi.advanceTimersByTimeAsync(1_500_000);
    stopped.abort();
    await maintenance;
    pending.resolve({ kind: 'Granted', grant: original });
    await vi.advanceTimersByTimeAsync(0);
    expect(original.release).not.toHaveBeenCalled();
    await access.renewLease('run', 'incarnation', command);
    expect(original.runs.renewLease).toHaveBeenCalledOnce();
  });

  it('releases a superseded grant only after its last in-flight request settles', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const pending = Promise.withResolvers<Awaited<ReturnType<HostedRuns['renewLease']>>>();
    const oldRelease = vi.fn(() => Promise.resolve());
    const newRelease = vi.fn(() => Promise.resolve());
    const old = {
      ...grant(1_800_000),
      runs: { renewLease: vi.fn(() => pending.promise) },
      release: oldRelease,
    };
    const newer = { ...grant(3_300_000), release: newRelease };
    const access = new RunWorkAccess(
      { initialGrant: old, acquire: () => Promise.resolve({ kind: 'Granted', grant: newer }) },
      new MonotonicLeaseClock(),
    );
    const stopped = new AbortController();
    const inFlight = access.renewLease('run', 'incarnation', command);
    const maintenance = access.maintain(stopped.signal);
    await vi.advanceTimersByTimeAsync(1_500_000);
    expect(oldRelease).not.toHaveBeenCalled();
    expect(newRelease).not.toHaveBeenCalled();
    await access.renewLease('run', 'incarnation', command);
    expect(newer.runs.renewLease).toHaveBeenCalledOnce();
    pending.resolve({ kind: 'ServerUnavailable' });
    await inFlight;
    await vi.advanceTimersByTimeAsync(0);
    expect(oldRelease).toHaveBeenCalledOnce();
    expect(newRelease).not.toHaveBeenCalled();
    stopped.abort();
    await maintenance;
  });

  it('loses the same Run lease when grant replacement fails and the old bearer expires', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const original = grant(10_000);
    const renewLease = vi.fn<HostedRuns['renewLease']>(() =>
      Promise.resolve({
        kind: 'RequestRejected',
        problem: {
          type: 'https://devrandom.example/problems/work-access-grant-expired',
          title: 'Work Access Grant expired',
          status: 401,
          code: 'WorkAccessGrantExpired',
          correlationId: 'grant-expired-fixture',
        },
      }),
    );
    const acquire = vi.fn<RunWorkAccessRenewal['acquire']>(() =>
      Promise.resolve({ kind: 'Unavailable' }),
    );
    const clock = new MonotonicLeaseClock();
    const access = new RunWorkAccess(
      { initialGrant: { ...original, runs: { renewLease } }, acquire },
      clock,
    );
    const stopped = new AbortController();
    const accept = vi.fn();
    const maintenance = access.maintain(stopped.signal);
    const keeping = keepRunLease(
      {
        runId: 'run',
        incarnationId: 'incarnation',
        runVersion: 1,
        serverTime: '2026-09-24T20:00:00.000Z',
        expiresAt: '2026-09-24T20:00:45.000Z',
      },
      0,
      new HostedRunLeaseAuthority(access),
      clock,
      stopped.signal,
      { accept },
    );

    await vi.advanceTimersByTimeAsync(15_000);
    await expect(keeping).resolves.toEqual({ kind: 'LeaseLost', lastAcceptedRunVersion: 1 });
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(renewLease).toHaveBeenCalledExactlyOnceWith('run', 'incarnation', {
      version: 1,
      expectedRunVersion: 1,
    });
    expect(accept).not.toHaveBeenCalled();
    stopped.abort();
    await maintenance;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves in-flight evidence and sends later calls through the replacement', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const original = grant(1_800_000);
    const replacement = grant(3_300_000);
    const pending =
      Promise.withResolvers<Awaited<ReturnType<typeof original.evidence.storeArtifact>>>();
    const storeArtifact = vi.fn(() => pending.promise);
    const access = new RunWorkAccess(
      {
        initialGrant: { ...original, evidence: { ...original.evidence, storeArtifact } },
        acquire: () => Promise.resolve({ kind: 'Granted', grant: replacement }),
      },
      new MonotonicLeaseClock(),
    );
    const bytes = new TextEncoder().encode('unchanged evidence');
    const artifact = prepareEvidenceArtifact(bytes, 'text/plain; charset=utf-8');
    if (artifact.kind !== 'Prepared') throw new Error('invalid artifact fixture');
    const stopped = new AbortController();
    const deliverySignal = new AbortController().signal;
    const delivery = access.storeArtifact('run', artifact.artifact, bytes, deliverySignal);
    const maintenance = access.maintain(stopped.signal);
    await vi.advanceTimersByTimeAsync(1_500_000);
    expect(storeArtifact).toHaveBeenCalledExactlyOnceWith(
      'run',
      artifact.artifact,
      bytes,
      deliverySignal,
    );
    expect(replacement.evidence.storeArtifact).not.toHaveBeenCalled();
    pending.resolve({ kind: 'ServerUnavailable' });
    await expect(delivery).resolves.toEqual({ kind: 'ServerUnavailable' });
    await access.storeArtifact('run', artifact.artifact, bytes, deliverySignal);
    expect(replacement.evidence.storeArtifact).toHaveBeenCalledExactlyOnceWith(
      'run',
      artifact.artifact,
      bytes,
      deliverySignal,
    );
    const seal = { version: 1 as const, sealExchangeSaid: 'E' + 's'.repeat(43) };
    await access.reconcileSeal('run', seal);
    expect(replacement.evidence.reconcileSeal).toHaveBeenCalledExactlyOnceWith('run', seal);
    stopped.abort();
    await maintenance;
  });

  it('does not repeatedly acquire shortened grants while both overlap slots are occupied', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const original = grant(60_000);
    const replacement = grant(90_000);
    const acquire = vi
      .fn<RunWorkAccessRenewal['acquire']>()
      .mockResolvedValue({ kind: 'Granted', grant: replacement });
    const access = new RunWorkAccess(
      { initialGrant: original, acquire },
      new MonotonicLeaseClock(),
    );
    const stopped = new AbortController();
    const maintenance = access.maintain(stopped.signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(acquire).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(acquire).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(acquire).toHaveBeenCalledTimes(2);
    stopped.abort();
    await maintenance;
  });

  it('starts five minutes early, retains old capabilities during proof, and swaps only after grant', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const original = grant(1_800_000);
    const replacement = grant(3_300_000);
    const proof = Promise.withResolvers<Awaited<ReturnType<RunWorkAccessRenewal['acquire']>>>();
    const acquire = vi.fn(() => proof.promise);
    const access = new RunWorkAccess(
      { initialGrant: original, acquire },
      new MonotonicLeaseClock(),
    );
    const stopped = new AbortController();
    const maintenance = access.maintain(stopped.signal);
    await vi.advanceTimersByTimeAsync(1_499_999);
    expect(acquire).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(acquire).toHaveBeenCalledExactlyOnceWith(stopped.signal);
    await access.renewLease('run', 'incarnation', command);
    expect(original.runs.renewLease).toHaveBeenCalledExactlyOnceWith('run', 'incarnation', command);
    expect(replacement.runs.renewLease).not.toHaveBeenCalled();
    proof.resolve({ kind: 'Granted', grant: replacement });
    await vi.advanceTimersByTimeAsync(0);
    await access.renewLease('run', 'incarnation', command);
    expect(replacement.runs.renewLease).toHaveBeenCalledExactlyOnceWith(
      'run',
      'incarnation',
      command,
    );
    stopped.abort();
    await maintenance;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    'userAid',
    'credentialSaid',
    'clientInstanceId',
    'issuerAid',
    'scopes',
    'deadline',
    'Stopped',
  ] as const)('does not install a replacement with changed %s', async (field) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const original = grant(1_800_000);
    const replacement = {
      ...grant(3_300_000),
      ...(field === 'scopes'
        ? { scopes: ['task:read'] as const }
        : field === 'deadline'
          ? { deadline: 1_500_000 }
          : field === 'Stopped'
            ? {}
            : { [field]: 'changed' }),
    };
    const stopped = new AbortController();
    const acquire = vi.fn(() => {
      if (field === 'Stopped') stopped.abort();
      return Promise.resolve({ kind: 'Granted' as const, grant: replacement });
    });
    const access = new RunWorkAccess(
      { initialGrant: original, acquire },
      new MonotonicLeaseClock(),
    );
    const maintenance = access.maintain(stopped.signal);
    await vi.advanceTimersByTimeAsync(1_500_000);
    await access.renewLease('run', 'incarnation', command);
    expect(original.runs.renewLease).toHaveBeenCalledOnce();
    expect(replacement.runs.renewLease).not.toHaveBeenCalled();
    if (field !== 'Stopped') expect(replacement.release).toHaveBeenCalledOnce();
    expect(original.release).not.toHaveBeenCalled();
    stopped.abort();
    await maintenance;
  });

  it('retains current transport on failed proof and retries without admitting another Run', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const original = grant(1_800_000);
    const replacement = grant(3_300_000);
    const acquire = vi
      .fn<RunWorkAccessRenewal['acquire']>()
      .mockResolvedValueOnce({ kind: 'Unavailable' })
      .mockResolvedValue({ kind: 'Granted', grant: replacement });
    const access = new RunWorkAccess(
      { initialGrant: original, acquire },
      new MonotonicLeaseClock(),
    );
    const stopped = new AbortController();
    const maintenance = access.maintain(stopped.signal);
    await vi.advanceTimersByTimeAsync(1_500_000);
    await access.renewLease('run', 'incarnation', command);
    expect(original.runs.renewLease).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10_000);
    await access.renewLease('run', 'incarnation', command);
    expect(replacement.runs.renewLease).toHaveBeenCalledOnce();
    expect(acquire).toHaveBeenCalledTimes(2);
    stopped.abort();
    await maintenance;
  });
});
