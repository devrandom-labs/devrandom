import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import type { ProtectedCredentials } from '@devrandom/domain';
import type { RunResourceBudget } from '@devrandom/runtime';
import { expect, it } from 'vitest';

import { DockerExactChildCommands } from './docker-exact-child-commands.js';

function child() {
  const process = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(process, {
    stdin: new PassThrough(),
    stdout,
    stderr,
    kill: () => true,
  });
  return { process, stdout, stderr };
}

it('does not accept a native command when its OCI compartment removal cannot be confirmed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devrandom-run-oci-command-'));
  try {
    const native = child();
    const calls: string[] = [];
    const commands = new DockerExactChildCommands({
      environment: {
        close: () => Promise.resolve(true),
        runNative: () => {
          setImmediate(() => {
            native.stdout.write('public output');
            native.stdout.end();
            native.stderr.end();
            native.process.emit('close', 0, null);
          });
          return Promise.resolve({
            kind: 'Running',
            child: native.process,
            close: () => {
              calls.push('close');
              return Promise.resolve(false);
            },
          });
        },
      },
      outputRoot: root,
      maximumOutputBytes: 1024,
      budget: {
        reserve: () => ({ kind: 'Reserved', reservation: { reservationId: 1 } }),
        commit: () => {
          calls.push('debit');
          return { kind: 'Committed' };
        },
        release: () => ({ kind: 'Released' }),
      } as unknown as RunResourceBudget,
      protectedCredentials: {
        inspect: () => ({ kind: 'Recordable' }),
      } as unknown as ProtectedCredentials,
      monotonicNow: () => 1000,
    });
    const outcome = await commands.run(
      {
        executableRealpath: '/usr/bin/true',
        arguments: [],
        timeoutSeconds: 1,
        expectedExitCode: 0,
        budgetProducer: { kind: 'ToolGateway' },
      },
      new AbortController().signal,
    );
    expect(outcome.kind).toBe('ProcessCleanupUnconfirmed');
    expect(calls).toEqual(['close', 'debit']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('bounds a background native child by removing its disposable compartment on timeout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devrandom-run-oci-background-'));
  try {
    const native = child();
    let removals = 0;
    const commands = new DockerExactChildCommands({
      environment: {
        close: () => Promise.resolve(true),
        runNative: () =>
          Promise.resolve({
            kind: 'Running',
            child: native.process,
            close: () => {
              removals += 1;
              return Promise.resolve(true);
            },
          }),
      },
      outputRoot: root,
      maximumOutputBytes: 1024,
      budget: {
        reserve: () => ({ kind: 'Reserved', reservation: { reservationId: 1 } }),
        commit: () => ({ kind: 'Committed' }),
        release: () => ({ kind: 'Released' }),
      } as unknown as RunResourceBudget,
      protectedCredentials: {
        inspect: () => ({ kind: 'Recordable' }),
      } as unknown as ProtectedCredentials,
      monotonicNow: () => 1000,
    });
    const outcome = await commands.run(
      {
        executableRealpath: '/usr/bin/sleep',
        arguments: ['30'],
        timeoutSeconds: 1,
        expectedExitCode: 0,
        budgetProducer: { kind: 'ToolGateway' },
      },
      new AbortController().signal,
    );
    expect(outcome.kind).toBe('TimedOut');
    expect(removals).toBe(1);
    if ('output' in outcome) await outcome.output.acknowledge();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('locks command admission when OCI opening leaves cleanup unconfirmed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devrandom-run-oci-opening-'));
  try {
    const commands = new DockerExactChildCommands({
      environment: {
        close: () => Promise.resolve(true),
        runNative: () => Promise.resolve({ kind: 'CleanupUnconfirmed' }),
      },
      outputRoot: root,
      maximumOutputBytes: 1024,
      budget: {
        reserve: () => ({ kind: 'Reserved', reservation: { reservationId: 1 } }),
        commit: () => ({ kind: 'Committed' }),
        release: () => ({ kind: 'Released' }),
      } as unknown as RunResourceBudget,
      protectedCredentials: {
        inspect: () => ({ kind: 'Recordable' }),
      } as unknown as ProtectedCredentials,
      monotonicNow: () => 1000,
    });
    const outcome = await commands.run(
      {
        executableRealpath: '/usr/bin/true',
        arguments: [],
        timeoutSeconds: 1,
        expectedExitCode: 0,
        budgetProducer: { kind: 'ToolGateway' },
      },
      new AbortController().signal,
    );
    expect(outcome.kind).toBe('ProcessCleanupUnconfirmed');
    if ('output' in outcome) await outcome.output.acknowledge();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('rejects the worktree command on observed OCI profile drift', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devrandom-run-oci-drift-'));
  try {
    let released = false;
    let closed = false;
    const commands = new DockerExactChildCommands({
      environment: {
        close: () => {
          closed = true;
          return Promise.resolve(true);
        },
        runNative: () => Promise.resolve({ kind: 'ProfileDrift' }),
      },
      outputRoot: root,
      maximumOutputBytes: 1024,
      budget: {
        reserve: () => ({ kind: 'Reserved', reservation: { reservationId: 1 } }),
        commit: () => ({ kind: 'Committed' }),
        release: () => {
          released = true;
          return { kind: 'Released' };
        },
      } as unknown as RunResourceBudget,
      protectedCredentials: {
        inspect: () => ({ kind: 'Recordable' }),
      } as unknown as ProtectedCredentials,
      monotonicNow: () => 1000,
    });
    const outcome = await commands.run(
      {
        executableRealpath: '/usr/bin/true',
        arguments: [],
        timeoutSeconds: 1,
        expectedExitCode: 0,
        budgetProducer: { kind: 'ToolGateway' },
      },
      new AbortController().signal,
    );
    expect(outcome).toEqual({
      kind: 'WorktreeAdmissionRejected',
      failure: 'EvidenceIntegrityFailure',
    });
    expect(released).toBe(true);
    expect(closed).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
