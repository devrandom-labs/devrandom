import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

export type DemoCliAction = {
  readonly id: string;
  readonly title: string;
  readonly command: readonly string[];
  readonly inputs: readonly {
    name: string;
    label: string;
    required: boolean;
    flag?: string;
    switch?: true;
  }[];
  readonly availability: 'Live' | 'Blocked';
  readonly requiresConfirmation: boolean;
  readonly reason?: string;
};
const positional = (name: string, label = name) => ({ name, label, required: true });
const flag = (name: string, flagName: string, required = true) => ({
  name,
  label: name,
  required,
  flag: flagName,
});
function action(
  id: string,
  title: string,
  command: readonly string[],
  inputs: DemoCliAction['inputs'] = [],
  requiresConfirmation = false,
  blocked = false,
): DemoCliAction {
  return {
    id,
    title,
    command,
    inputs,
    requiresConfirmation,
    availability: blocked ? 'Blocked' : 'Live',
    ...(blocked
      ? {
          reason:
            'Requires current qualified campaign artifacts; live journey acceptance is not established.',
        }
      : {}),
  };
}
/** Presentation readiness is not a domain grant. Every invocation still enters the public CLI. */
export const demoCliActions: readonly DemoCliAction[] = [
  action('help', 'Show public CLI commands', ['--help']),
  action('status', 'Check live services', ['status']),
  action('init', 'Create or recover local identity', ['init', '--no-open'], [], true),
  action('whoami', 'Verify current identity', ['whoami']),
  action('identity-rotate', 'Rotate user keys', ['identity', 'rotate'], [], true),
  action('task-list', 'List Tasks', ['task', 'list']),
  action('task-create', 'Create Task from JSON', ['task', 'create'], [positional('file')], true),
  action('task-inspect', 'Inspect Task', ['task', 'inspect'], [positional('label')]),
  action('task-status', 'Inspect durable Run state', ['task', 'status'], [positional('label')]),
  action('task-watch', 'Watch accepted Run evidence', ['task', 'watch'], [positional('label')]),
  action(
    'task-run',
    'Start governed Run (may spend provider budget)',
    ['task', 'run'],
    [positional('label')],
    true,
  ),
  action(
    'task-cancel',
    'Cancel exact expired interrupted Run',
    ['task', 'cancel'],
    [positional('label'), flag('run', '--run')],
    true,
  ),
  action(
    'task-resume',
    'Resume same retained Run',
    ['task', 'resume'],
    [
      positional('label'),
      flag('run', '--run'),
      {
        name: 'pauseAfterCheckpoint',
        label: 'Pause after checkpoint (true/false)',
        required: false,
        flag: '--pause-after-checkpoint',
        switch: true,
      },
    ],
    true,
    true,
  ),
  action(
    'task-verify',
    'Verify original completion contract',
    ['task', 'verify'],
    [positional('label'), flag('run', '--run')],
    true,
    true,
  ),
  action(
    'harness-inspect',
    'Inspect retained harness',
    ['harness', 'inspect'],
    [positional('said')],
  ),
  action(
    'evidence-inspect',
    'Inspect exact evidence',
    ['evidence', 'inspect'],
    [positional('said')],
  ),
  action(
    'harness-propose',
    'Record authority proposal',
    ['harness', 'propose'],
    [positional('label'), positional('file')],
    true,
  ),
  action(
    'harness-evaluate',
    'Evaluate qualified retained failure',
    ['harness', 'evaluate'],
    [positional('label'), flag('run', '--from-run'), flag('policy', '--policy')],
    true,
    true,
  ),
  action(
    'harness-promote',
    'Request governed activation',
    ['harness', 'promote'],
    [
      positional('label'),
      flag('evaluation', '--evaluation'),
      flag('closure', '--closure'),
      flag('commandId', '--command-id'),
      flag('manifest', '--confirm-manifest'),
    ],
    true,
    true,
  ),
  action(
    'harness-publish',
    'Publish sanitized behavior',
    ['harness', 'publish'],
    [positional('label'), flag('evaluation', '--evaluation'), flag('commandId', '--command-id')],
    true,
    true,
  ),
  action(
    'harness-fetch',
    'Fetch and verify package',
    ['harness', 'fetch'],
    [positional('said'), flag('publisherOobi', '--publisher-oobi')],
    true,
    true,
  ),
  action(
    'harness-fork',
    'Fork verified private lineage',
    ['harness', 'fork'],
    [
      positional('said'),
      flag('publisherOobi', '--publisher-oobi'),
      flag('commandId', '--command-id'),
    ],
    true,
    true,
  ),
  action(
    'harness-manifest-resume',
    'Reconcile staged manifest',
    ['harness', 'manifest-resume'],
    [positional('evaluation')],
    true,
    true,
  ),
  action(
    'harness-h0-progress',
    'Progress reviewed hypothesis',
    ['harness', 'h0-progress'],
    [
      positional('label'),
      flag('run', '--from-run'),
      flag('policy', '--policy'),
      flag('review', '--review'),
      flag('configuration', '--configuration-said'),
      flag('nonTreatmentInputs', '--non-treatment-inputs-said'),
    ],
    true,
    true,
  ),
  action(
    'harness-source-inventory',
    'Record qualified verifier sources',
    ['harness', 'source-inventory'],
    [
      positional('label'),
      flag('run', '--from-run'),
      flag('profile', '--profile-said'),
      flag('activeRevision', '--active-revision-said'),
      flag('outputDirectory', '--output-dir'),
    ],
    true,
    true,
  ),
];
export type DemoCliInvocation = {
  action: string;
  inputs: Readonly<Record<string, string>>;
  confirmed?: boolean;
  enabledActions?: readonly string[];
};
export function prepareDemoCliAction(
  input: DemoCliInvocation,
): { kind: 'Prepared'; args: string[] } | { kind: 'Rejected'; reason: string } {
  const definition = demoCliActions.find((item) => item.id === input.action);
  if (!definition) return { kind: 'Rejected', reason: 'Unknown public command.' };
  if (definition.availability === 'Blocked' && !input.enabledActions?.includes(input.action))
    return { kind: 'Rejected', reason: definition.reason ?? 'Unavailable prerequisites.' };
  if (definition.requiresConfirmation && input.confirmed !== true)
    return {
      kind: 'Rejected',
      reason: 'Explicit confirmation is required before this live action.',
    };
  if (
    Object.keys(input.inputs).some(
      (name) => !definition.inputs.some((field) => field.name === name),
    )
  )
    return { kind: 'Rejected', reason: 'Unknown command input.' };
  const args = [...definition.command];
  for (const field of definition.inputs) {
    const value = input.inputs[field.name];
    if (!value && !field.required) continue;
    if (
      !value ||
      value.startsWith('-') ||
      value
        .split('')
        .some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
      value.length > 4096
    )
      return { kind: 'Rejected', reason: `Invalid input: ${field.name}.` };
    if (field.switch) {
      if (value === 'true' && field.flag) args.push(field.flag);
      else if (value !== 'false')
        return { kind: 'Rejected', reason: `Invalid input: ${field.name}.` };
      continue;
    }
    if (field.flag) args.push(field.flag);
    args.push(value);
  }
  return { kind: 'Prepared', args };
}
export function redactDemoCliOutput(
  output: string,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  let redacted = output.replace(/mongodb(?:\+srv)?:\/\/[^\s"']+/giu, '[REDACTED]');
  for (const [key, value] of Object.entries(environment)) {
    if (
      value &&
      value.length >= 4 &&
      /secret|token|password|bran|private|api.?key|credential/iu.test(key)
    )
      redacted = redacted.replaceAll(value, '[REDACTED]');
  }
  return redacted;
}
export type DemoCliOutcome = {
  kind: 'Completed' | 'Rejected' | 'Unavailable';
  action: string;
  provenance: 'Live';
  output: string;
  exitCode: number | null;
};
/** Local demo driving adapter. Never evaluates, signs, selects, or substitutes domain outcomes. */
export async function invokeDemoCliAction(
  input: DemoCliInvocation & {
    repositoryRoot: string;
    workingDirectory?: string;
    environment?: Readonly<Record<string, string | undefined>>;
    environmentFile?: string;
    signal?: AbortSignal;
    onOutput?: (text: string) => void;
  },
): Promise<DemoCliOutcome> {
  const prepared = prepareDemoCliAction(input);
  const base = { action: input.action, provenance: 'Live' as const };
  if (prepared.kind === 'Rejected')
    return { ...base, kind: 'Rejected', output: prepared.reason, exitCode: null };
  let environment = { ...process.env, ...input.environment };
  if (input.environmentFile) {
    try {
      environment = { ...parseEnv(await readFile(input.environmentFile, 'utf8')), ...environment };
    } catch {
      return {
        ...base,
        kind: 'Unavailable',
        output: 'Configured CLI environment file is unavailable.',
        exitCode: null,
      };
    }
  }
  if (input.signal?.aborted)
    return {
      ...base,
      kind: 'Unavailable',
      output: 'Invocation interrupted before launch.',
      exitCode: null,
    };
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [join(input.repositoryRoot, 'apps/cli/dist/main.js'), ...prepared.args],
      {
        cwd: input.workingDirectory ?? input.repositoryRoot,
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      },
    );
    let output = '';
    let pending = '';
    const emit = (value: string) => {
      const safe = redactDemoCliOutput(value, environment);
      const remaining = 131072 - output.length;
      if (remaining > 0) {
        const bounded = safe.slice(0, remaining);
        output += bounded;
        input.onOutput?.(bounded);
      }
    };
    const receive = (chunk: Buffer) => {
      pending += chunk.toString('utf8');
      const newline = pending.lastIndexOf('\n');
      if (newline >= 0) {
        emit(pending.slice(0, newline + 1));
        pending = pending.slice(newline + 1);
      }
      if (pending.length > 131072) {
        emit('[Output line exceeded display limit]\n');
        pending = '';
      }
    };
    const interrupt = () => {
      child.kill('SIGINT');
    };
    input.signal?.addEventListener('abort', interrupt, { once: true });
    child.stdout.on('data', receive);
    child.stderr.on('data', receive);
    child.once('error', () => {
      input.signal?.removeEventListener('abort', interrupt);
      resolve({
        ...base,
        kind: 'Unavailable',
        output: 'Public CLI process could not start.',
        exitCode: null,
      });
    });
    child.once('close', (code) => {
      input.signal?.removeEventListener('abort', interrupt);
      emit(pending);
      resolve({
        ...base,
        kind: code === null ? 'Unavailable' : 'Completed',
        output,
        exitCode: code,
      });
    });
  });
}
