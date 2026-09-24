import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';

interface CompletedCliCommand {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface RunningInitialization {
  readonly child: ChildProcessWithoutNullStreams;
  readonly registrationUrl: Promise<string>;
  readonly completion: Promise<CompletedCliCommand>;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required for the live identity journey`);
  }
  return value;
}

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const cliExecutable = resolve(repositoryRoot, 'node_modules/.bin/devrandom');
const stateDirectory = requiredEnvironment('DEVRANDOM_USER_STATE_DIR');
const siteOrigin = requiredEnvironment('DEVRANDOM_SITE_URL');
const cliEnvironment = { ...process.env, DEVRANDOM_USER_STATE_DIR: stateDirectory };

function captureCommand(child: ChildProcessWithoutNullStreams): {
  readonly completion: Promise<CompletedCliCommand>;
  readonly stdout: () => string;
} {
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const completion = new Promise<CompletedCliCommand>((resolveCompletion, rejectCompletion) => {
    child.once('error', rejectCompletion);
    child.once('close', (exitCode) => {
      resolveCompletion({ exitCode, stdout, stderr });
    });
  });
  return { completion, stdout: () => stdout };
}

function startInitialization(): RunningInitialization {
  const child = spawn(cliExecutable, ['init', '--no-open'], {
    cwd: repositoryRoot,
    env: cliEnvironment,
  });
  const captured = captureCommand(child);
  const registrationUrl = new Promise<string>((resolveUrl, rejectUrl) => {
    const deadline = setTimeout(() => {
      rejectUrl(new Error('CLI did not present a registration URL before the deadline'));
    }, 90_000);
    const inspect = (): void => {
      const match = /^Registration URL: (https?:\/\/[^\s]+)$/mu.exec(captured.stdout());
      const url = match?.[1];
      if (url !== undefined) {
        clearTimeout(deadline);
        resolveUrl(url);
      }
    };
    child.stdout.on('data', inspect);
    void captured.completion.then((result) => {
      clearTimeout(deadline);
      rejectUrl(
        new Error(
          `CLI exited before presenting registration URL (${String(result.exitCode)}): ${result.stderr}`,
        ),
      );
    });
  });
  return { child, registrationUrl, completion: captured.completion };
}

async function runCli(argumentsAfterCommand: readonly string[]): Promise<CompletedCliCommand> {
  const child = spawn(cliExecutable, argumentsAfterCommand, {
    cwd: repositoryRoot,
    env: cliEnvironment,
  });
  return await captureCommand(child).completion;
}

function reportedValue(output: string, label: string): string {
  const line = output.split('\n').find((candidate) => candidate.startsWith(`${label}: `));
  if (line === undefined) {
    throw new Error(`${label} is absent from CLI output`);
  }
  return line.slice(label.length + 2);
}

test('admits, recovers, rotates, and re-verifies one witnessed user identity', async ({ page }) => {
  await access(cliExecutable);
  const status = await runCli(['status']);
  expect(status.exitCode).toBe(0);
  expect(status.stdout).toContain('Devrandom services are ready.');
  const initialization = startInitialization();
  try {
    const registrationUrl = await initialization.registrationUrl;
    expect(registrationUrl.startsWith(`${siteOrigin}/#/registration/`)).toBe(true);

    const issuerRequests: string[] = [];
    const issuerRequestBodies: string[] = [];
    const contentSecurityPolicyFailures: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/issuer/')) {
        issuerRequests.push(request.url());
        issuerRequestBodies.push(request.postData() ?? '');
      }
    });
    page.on('console', (message) => {
      if (
        message.type() === 'error' &&
        (message.text().includes('Content Security Policy') ||
          message.text().includes('Refused to'))
      ) {
        contentSecurityPolicyFailures.push(message.text());
      }
    });
    await page.goto(registrationUrl);
    await expect(page).not.toHaveURL(/#/u);
    await expect(
      page.getByRole('heading', { name: 'Approve Devrandom registration' }),
    ).toBeVisible();
    await expect(page.getByText('self-asserted and unverified')).toBeVisible();
    await expect(page.getByText('ReceiveTaskResults')).toBeVisible();
    expect(issuerRequests.length).toBeGreaterThan(0);

    await page.getByLabel('Contact email (self-asserted)').fill('identity-acceptance@example.test');
    await page.getByRole('button', { name: 'Approve registration' }).click();
    await expect(page).toHaveURL(`${siteOrigin}/registration/success/`, { timeout: 120_000 });
    await expect(page.getByRole('heading', { name: 'Credential issued' })).toBeVisible();
    await expect(page.getByText('return to your terminal')).toBeVisible();
    expect(contentSecurityPolicyFailures).toEqual([]);

    const initialized = await initialization.completion;
    expect(initialized.exitCode, initialized.stderr).toBe(0);
    expect(initialized.stdout).toContain('Identity Ready');
    expect(initialized.stdout).toContain('ReceiveTaskResults');
    expect(initialized.stdout).not.toContain('identity-acceptance@example.test');
    const userAid = reportedValue(initialized.stdout, 'User AID');
    const controllerAid = reportedValue(initialized.stdout, 'Controller AID');
    const agentAid = reportedValue(initialized.stdout, 'KERIA agent AID');
    const credentialSaid = reportedValue(initialized.stdout, 'Credential SAID');
    const attributeSaid = reportedValue(initialized.stdout, 'Credential attribute SAID');
    const issuerAid = reportedValue(initialized.stdout, 'Issuer AID');
    const issueeAid = reportedValue(initialized.stdout, 'Issuee AID');
    const schemaSaid = reportedValue(initialized.stdout, 'Schema SAID');
    const registryId = reportedValue(initialized.stdout, 'Registry ID');
    const anchorSaid = reportedValue(initialized.stdout, 'Issuer anchor event SAID');
    const initialSequence = Number(reportedValue(initialized.stdout, 'KEL sequence'));
    expect(initialSequence).toBe(0);
    expect(reportedValue(initialized.stdout, 'Witness receipt indexes')).toBe('0');
    expect(issueeAid).toBe(userAid);
    expect(initialized.stdout).toContain('Provenance: live');
    for (const claim of [
      'CreateAgent',
      'CreateTask',
      'RunPrivateTask',
      'PublishHarness',
      'ReceiveTaskResults',
    ]) {
      expect(initialized.stdout).toContain(`- ${claim}`);
    }

    const repeated = await runCli(['init', '--no-open']);
    expect(repeated.exitCode, repeated.stderr).toBe(0);
    expect(reportedValue(repeated.stdout, 'User AID')).toBe(userAid);
    expect(reportedValue(repeated.stdout, 'Controller AID')).toBe(controllerAid);
    expect(reportedValue(repeated.stdout, 'KERIA agent AID')).toBe(agentAid);
    expect(repeated.stdout).toContain('Recovery disposition: ExistingIdentity');
    expect(repeated.stdout).not.toContain('Registration URL:');

    const rotated = await runCli(['identity', 'rotate']);
    expect(rotated.exitCode, rotated.stderr).toBe(0);
    expect(reportedValue(rotated.stdout, 'User AID')).toBe(userAid);
    expect(reportedValue(rotated.stdout, 'KEL sequence')).toBe(String(initialSequence + 1));
    expect(reportedValue(rotated.stdout, 'Witness receipt indexes')).toBe('0');

    const whoami = await runCli(['whoami']);
    expect(whoami.exitCode, whoami.stderr).toBe(0);
    expect(reportedValue(whoami.stdout, 'User AID')).toBe(userAid);
    expect(reportedValue(whoami.stdout, 'Controller AID')).toBe(controllerAid);
    expect(reportedValue(whoami.stdout, 'KERIA agent AID')).toBe(agentAid);
    expect(reportedValue(whoami.stdout, 'KEL sequence')).toBe(String(initialSequence + 1));
    expect(reportedValue(whoami.stdout, 'Witness receipt indexes')).toBe('0');
    expect(reportedValue(whoami.stdout, 'Credential SAID')).toBe(credentialSaid);
    expect(reportedValue(whoami.stdout, 'Credential attribute SAID')).toBe(attributeSaid);
    expect(reportedValue(whoami.stdout, 'Issuer AID')).toBe(issuerAid);
    expect(reportedValue(whoami.stdout, 'Issuee AID')).toBe(issueeAid);
    expect(reportedValue(whoami.stdout, 'Schema SAID')).toBe(schemaSaid);
    expect(reportedValue(whoami.stdout, 'Registry ID')).toBe(registryId);
    expect(reportedValue(whoami.stdout, 'Issuer anchor event SAID')).toBe(anchorSaid);
    expect(whoami.stdout).toContain('TEL status: Issued');
    expect(whoami.stdout).toContain('Provenance: live');
    for (const claim of [
      'CreateAgent',
      'CreateTask',
      'RunPrivateTask',
      'PublishHarness',
      'ReceiveTaskResults',
    ]) {
      expect(whoami.stdout).toContain(`- ${claim}`);
    }
    expect(whoami.stdout).toContain('Recovery disposition: ExistingIdentity');

    const profilePath = resolve(stateDirectory, 'user-profile.json');
    const custodyPath = resolve(stateDirectory, 'signify-custody.json');
    const profile = await readFile(profilePath, 'utf8');
    const custodySource = await readFile(custodyPath, 'utf8');
    const custody: unknown = JSON.parse(custodySource);
    if (
      typeof custody !== 'object' ||
      custody === null ||
      !('bran' in custody) ||
      typeof custody.bran !== 'string'
    ) {
      throw new Error('live custody file does not contain a Signify bran');
    }
    expect(profile).not.toContain('identity-acceptance@example.test');
    expect(profile).not.toContain('cli_');
    expect(profile).not.toContain('browser_');
    expect(profile).not.toContain(custody.bran);
    expect(initialized.stdout).not.toContain(custody.bran);
    expect(initialized.stderr).not.toContain(custody.bran);
    expect(issuerRequestBodies).not.toContainEqual(expect.stringContaining(custody.bran));
    expect((await lstat(profilePath)).mode & 0o777).toBe(0o600);
    expect((await lstat(custodyPath)).mode & 0o777).toBe(0o600);
    await expect(access(resolve(stateDirectory, 'registration-secrets.json'))).rejects.toThrow();
  } finally {
    if (initialization.child.exitCode === null && initialization.child.signalCode === null) {
      initialization.child.kill('SIGTERM');
    }
  }
});
