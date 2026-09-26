import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  demoCliActions,
  invokeDemoCliAction,
  prepareDemoCliAction,
  redactDemoCliOutput,
} from './demo-cli-actions.js';

describe('interactive demo public CLI boundary', () => {
  it('builds exact public command arguments without a shell', () => {
    expect(
      prepareDemoCliAction({ action: 'task-inspect', inputs: { label: 'demo; echo nope' } }),
    ).toEqual({ kind: 'Prepared', args: ['task', 'inspect', 'demo; echo nope'] });
  });
  it('rejects option injection, unknown inputs and unknown commands', () => {
    for (const input of [
      { action: 'task-inspect', inputs: { label: '--help' } },
      { action: 'task-inspect', inputs: { label: 'demo', extra: 'x' } },
      { action: 'arbitrary-shell', inputs: {} },
    ])
      expect(prepareDemoCliAction(input).kind).toBe('Rejected');
  });
  it('requires explicit confirmation before a real paid Run or Task creation', () => {
    expect(prepareDemoCliAction({ action: 'task-run', inputs: { label: 'demo' } }).kind).toBe(
      'Rejected',
    );
    expect(
      prepareDemoCliAction({ action: 'task-create', inputs: { file: 'task.json' } }).kind,
    ).toBe('Rejected');
    expect(
      prepareDemoCliAction({ action: 'task-run', inputs: { label: 'demo' }, confirmed: true }),
    ).toEqual({ kind: 'Prepared', args: ['task', 'run', 'demo'] });
  });
  it('does not imply an unfinished campaign has current promotion authority', () => {
    expect(demoCliActions.find((a) => a.id === 'harness-promote')?.availability).toBe('Blocked');
    expect(
      prepareDemoCliAction({ action: 'harness-promote', inputs: {}, confirmed: true }).kind,
    ).toBe('Rejected');
  });
  it('preserves truthful live invocation and exact flags when current recovery is explicitly enabled', () => {
    expect(
      prepareDemoCliAction({
        action: 'task-resume',
        inputs: { label: 'demo', run: 'run-id', pauseAfterCheckpoint: 'true' },
        confirmed: true,
        enabledActions: ['task-resume'],
      }),
    ).toEqual({
      kind: 'Prepared',
      args: ['task', 'resume', 'demo', '--run', 'run-id', '--pause-after-checkpoint'],
    });
  });
  it('redacts local secrets without hiding domain refusal text', () => {
    expect(
      redactDemoCliOutput('Unavailable token=secret-value mongodb+srv://u:p@host/db', {
        API_TOKEN: 'secret-value',
      }),
    ).toBe('Unavailable token=[REDACTED] [REDACTED]');
  });
});

describe('public subprocess adapter', () => {
  it('preserves nonzero exit and live provenance without a simulated fallback', async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), 'devrandom-demo-invocation-'));
    try {
      await mkdir(join(repositoryRoot, 'apps/cli/dist'), { recursive: true });
      await writeFile(
        join(repositoryRoot, 'apps/cli/dist/main.js'),
        "process.stdout.write('Domain refusal '+process.env.DEMO_API_TOKEN+'\\n');process.exitCode=6;",
      );
      const outcome = await invokeDemoCliAction({
        action: 'whoami',
        inputs: {},
        repositoryRoot,
        environment: { DEMO_API_TOKEN: 'fixture-secret' },
      });
      expect(outcome).toEqual({
        kind: 'Completed',
        action: 'whoami',
        provenance: 'Live',
        output: 'Domain refusal [REDACTED]\n',
        exitCode: 6,
      });
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  });
});
