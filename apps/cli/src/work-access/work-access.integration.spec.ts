import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  prepareTaskCommand,
  workAccessAttemptProjectionSchema,
  type WorkAccessAttemptProjection,
} from '@devrandom/protocol';
import Value from 'typebox/value';
import { describe, expect, it } from 'vitest';

import type { DevrandomFetch } from '../infrastructure/devrandom-server-http.js';
import {
  UserIdentityApplication,
  userIdentityDefaults,
} from '../identity/application/user-identity.js';
import { IdentityFiles } from '../identity/infrastructure/identity-files.js';
import { IssuerRegistrationHttp } from '../identity/infrastructure/issuer-registration-http.js';
import {
  loadUserIdentityConfiguration,
  userIdentityEnvironment,
} from '../identity/infrastructure/user-environment.js';
import { clientInstanceId } from '../identity/domain/user-profile.js';
import {
  ServerWorkAccessHttp,
  type WorkAccessHttpObservation,
} from './infrastructure/server-work-access-http.js';
import {
  acquireWorkAccess,
  workAccessAcquisitionDefaults,
} from './application/work-access-acquisition.js';
import { taskSourceFixture } from '../../test/task-source-fixture.js';

const describeLiveWorkAccess =
  process.env.DEVRANDOM_WORK_ACCESS_INTEGRATION === '1' ? describe : describe.skip;
const executeFile = promisify(execFile);

describeLiveWorkAccess('live Work Access boundary', () => {
  it('reconciles lost attempt and proof replies with one precommitted bearer', async () => {
    const configuration = loadUserIdentityConfiguration(userIdentityEnvironment(process.env));
    const identity = new UserIdentityApplication(
      configuration,
      new IdentityFiles(configuration.stateDirectory),
      new IssuerRegistrationHttp(configuration.issuerUrl),
      userIdentityDefaults,
    );
    const admitted = await identity.admitHostedWork();
    if (admitted.kind !== 'Ready') {
      throw new Error(`live hosted-work identity was not ready: ${admitted.kind}`);
    }
    const isolatedIdentity = { ...admitted, clientInstanceId: clientInstanceId(randomUUID()) };

    const createRequests: string[] = [];
    const createStatuses: number[] = [];
    const proofRequests: string[] = [];
    const proofStatuses: number[] = [];
    const proofBearers: string[] = [];
    let committedAttemptId: string | undefined;
    const lostReplyFetch: DevrandomFetch = async (input, init) => {
      if (typeof input !== 'string') throw new Error('expected Work Access URL');
      const url = input;
      if (url.endsWith('/api/work-access-attempts') && init?.method === 'POST') {
        if (typeof init.body !== 'string') throw new Error('expected attempt JSON body');
        createRequests.push(init.body);
        const response = await fetch(input, init);
        createStatuses.push(response.status);
        if (createRequests.length === 1) {
          const body: unknown = await response.clone().json();
          if (!Value.Check(workAccessAttemptProjectionSchema, body)) {
            throw new Error('server did not commit a valid first attempt');
          }
          committedAttemptId = body.attemptId;
          throw new Error('response lost after committed Work Access attempt');
        }
        return response;
      }
      const authorization = new Headers(init?.headers).get('authorization');
      if (authorization !== null) proofBearers.push(authorization);
      if (url.endsWith('/proof') && init?.method === 'PUT') {
        if (typeof init.body !== 'string') throw new Error('expected proof JSON body');
        proofRequests.push(init.body);
        const response = await fetch(input, init);
        proofStatuses.push(response.status);
        if (proofRequests.length === 1) {
          throw new Error('response lost after committed Work Access proof');
        }
        return response;
      }
      return fetch(input, init);
    };

    const acquisition = await acquireWorkAccess(configuration.issuerUrl, isolatedIdentity, {
      ...workAccessAcquisitionDefaults,
      fetch: lostReplyFetch,
    });
    if (acquisition.kind !== 'Granted') {
      throw new Error(`lost-response Work Access was not granted: ${acquisition.kind}`);
    }
    expect(createStatuses).toEqual([201, 200]);
    expect(createRequests).toHaveLength(2);
    expect(createRequests[1]).toBe(createRequests[0]);
    expect(proofRequests).toHaveLength(2);
    expect(proofRequests[1]).toBe(proofRequests[0]);
    expect(proofStatuses.every((status) => status === 200 || status === 202)).toBe(true);
    expect(acquisition.server.grant.attemptId).toBe(committedAttemptId);
    expect(proofBearers.length).toBeGreaterThan(0);
    expect(new Set(proofBearers).size).toBe(1);
    await expect(acquisition.server.observeWorkAccessAttempt()).resolves.toMatchObject({
      kind: 'Observed',
      attempt: { kind: 'Granted', attemptId: committedAttemptId },
    });
  }, 120_000);

  it('proves current user-AID control and activates the client-precommitted grant secret', async () => {
    const configuration = loadUserIdentityConfiguration(userIdentityEnvironment(process.env));
    const identity = new UserIdentityApplication(
      configuration,
      new IdentityFiles(configuration.stateDirectory),
      new IssuerRegistrationHttp(configuration.issuerUrl),
      userIdentityDefaults,
    );
    const admitted = await identity.admitHostedWork();
    if (admitted.kind !== 'Ready') {
      throw new Error(`live hosted-work identity was not ready: ${admitted.kind}`);
    }

    const responses: { readonly status: number; readonly cacheControl: string | null }[] = [];
    const projections: WorkAccessAttemptProjection[] = [];
    const authorizations: string[] = [];
    const observedFetch: DevrandomFetch = async (input, init) => {
      const response = await fetch(input, init);
      const authorization = new Headers(init?.headers).get('authorization');
      if (authorization !== null) {
        authorizations.push(authorization);
      }
      const body: unknown = await response.clone().json();
      if (Value.Check(workAccessAttemptProjectionSchema, body)) {
        projections.push(Value.Parse(workAccessAttemptProjectionSchema, body));
      }
      responses.push({
        status: response.status,
        cacheControl: response.headers.get('cache-control'),
      });
      return response;
    };
    const acquisition = await acquireWorkAccess(configuration.issuerUrl, admitted, {
      ...workAccessAcquisitionDefaults,
      fetch: observedFetch,
    });
    if (acquisition.kind !== 'Granted') {
      throw new Error(
        `live Work Access was not granted: ${acquisition.kind}; responses=${JSON.stringify(responses)}`,
      );
    }

    expect(acquisition.server.grant).toMatchObject({
      kind: 'Granted',
      userAid: admitted.user.principal.aid,
      credentialSaid: admitted.user.credential.credentialSaid,
      issuerRecipientAid: admitted.user.credential.issuerAid,
      disposition: { kind: 'Active' },
    });
    expect(acquisition.server.grant.scopes).toEqual([
      'evidence:append',
      'evidence:seal',
      'run:create',
      'run:execute',
      'run:prepare',
      'run:read',
      'task:create',
      'task:read',
    ]);

    await expect(acquisition.server.observeWorkAccessAttempt()).resolves.toMatchObject({
      kind: 'Observed',
      attempt: {
        kind: 'Granted',
        attemptId: acquisition.server.grant.attemptId,
        verifiedResponseSaid: acquisition.server.grant.verifiedResponseSaid,
      },
    });

    const repositoryDirectory = join(configuration.stateDirectory, 'task-boundary-repository');
    await mkdir(join(repositoryDirectory, 'src'), { recursive: true });
    const taskDocument = {
      ...taskSourceFixture(),
      expiresAt: new Date(Date.now() + 3 * 60 * 60 * 1_000).toISOString(),
    };
    await Promise.all([
      writeFile(join(repositoryDirectory, 'src', 'parser.ts'), 'export const parser = true;\n'),
      writeFile(
        join(repositoryDirectory, 'task.devrandom.json'),
        `${JSON.stringify(taskDocument, null, 2)}\n`,
      ),
    ]);
    await executeFile('git', ['init', '--initial-branch=main'], { cwd: repositoryDirectory });
    await executeFile('git', ['config', 'user.name', 'Devrandom Acceptance'], {
      cwd: repositoryDirectory,
    });
    await executeFile('git', ['config', 'user.email', 'acceptance@devrandom.example'], {
      cwd: repositoryDirectory,
    });
    await executeFile('git', ['add', 'src/parser.ts', 'task.devrandom.json'], {
      cwd: repositoryDirectory,
    });
    await executeFile('git', ['commit', '-m', 'Prepare Task acceptance repository'], {
      cwd: repositoryDirectory,
    });
    const [commitObservation, treeObservation] = await Promise.all([
      executeFile('git', ['rev-parse', 'HEAD'], { cwd: repositoryDirectory }),
      executeFile('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repositoryDirectory }),
    ]);
    const repository = {
      objectFormat: 'sha1' as const,
      commit: commitObservation.stdout.trim(),
      tree: treeObservation.stdout.trim(),
    };

    const cli = await executeFile(
      process.execPath,
      [
        join(process.cwd(), 'apps', 'cli', 'dist', 'main.js'),
        'task',
        'create',
        'task.devrandom.json',
      ],
      { cwd: repositoryDirectory, env: process.env, maxBuffer: 1024 * 1024 },
    );
    expect(cli.stderr).toBe('');
    expect(cli.stdout).toContain('Task Created\n');
    expect(cli.stdout).toContain('Label: repair-parser\n');
    expect(cli.stdout).toContain('Lifecycle: Open\n');

    // All three commands share one persisted client ID. Each process must
    // retire its own grant after its public request, leaving the first
    // in-process grant active throughout this sequence.
    const cliPath = join(process.cwd(), 'apps', 'cli', 'dist', 'main.js');
    const listedByCli = await executeFile(process.execPath, [cliPath, 'task', 'list'], {
      cwd: repositoryDirectory,
      env: process.env,
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    });
    expect(listedByCli.stderr).toBe('');
    expect(listedByCli.stdout).toContain('repair-parser');
    const inspectedByCli = await executeFile(
      process.execPath,
      [cliPath, 'task', 'inspect', 'repair-parser'],
      {
        cwd: repositoryDirectory,
        env: process.env,
        timeout: 20_000,
        maxBuffer: 1024 * 1024,
      },
    );
    expect(inspectedByCli.stderr).toBe('');
    expect(inspectedByCli.stdout).toContain('Label: repair-parser');

    const tasks = acquisition.server.tasks();
    await expect(tasks.list({ limit: 25 })).resolves.toMatchObject({
      kind: 'Listed',
      page: {
        tasks: [
          {
            label: 'repair-parser',
            ownerAid: admitted.user.principal.aid,
            lifecycle: { kind: 'Open' },
          },
        ],
      },
    });
    await expect(tasks.inspect('repair-parser')).resolves.toMatchObject({
      kind: 'Inspected',
      task: {
        label: 'repair-parser',
        ownerAid: admitted.user.principal.aid,
        lifecycle: { kind: 'Open' },
      },
    });

    const retryCommand = prepareTaskCommand(
      { ...taskDocument, label: 'retry-contract' },
      '7b914588-2a90-4f72-bcbb-bafbd6093570',
      repository,
    );
    if (retryCommand.kind !== 'Prepared') {
      throw new Error(`live retry Task command was not prepared: ${retryCommand.reason}`);
    }
    const created = await tasks.create(retryCommand.command);
    if (created.kind !== 'Created') {
      throw new Error(`live retry Task was not created: ${created.kind}`);
    }
    const reconciled = await tasks.create(retryCommand.command);
    expect(reconciled).toEqual({ kind: 'Reconciled', task: created.task });

    const conflictingCommand = prepareTaskCommand(
      { ...taskDocument, label: 'conflicting-command' },
      retryCommand.command.commandId,
      repository,
    );
    if (conflictingCommand.kind !== 'Prepared') {
      throw new Error(
        `live conflicting Task command was not prepared: ${conflictingCommand.reason}`,
      );
    }
    await expect(tasks.create(conflictingCommand.command)).resolves.toMatchObject({
      kind: 'RequestRejected',
      problem: { code: 'TaskCommandConflict' },
    });

    const collidingLabel = prepareTaskCommand(
      { ...taskDocument, label: retryCommand.command.label },
      '4684bb7b-d250-4293-9e7d-329ee7f37cf4',
      repository,
    );
    if (collidingLabel.kind !== 'Prepared') {
      throw new Error(
        `live label-collision Task command was not prepared: ${collidingLabel.reason}`,
      );
    }
    await expect(tasks.create(collidingLabel.command)).resolves.toMatchObject({
      kind: 'RequestRejected',
      problem: { code: 'TaskLabelConflict' },
    });

    const concurrentSecret = randomBytes(32);
    const concurrentAccess = new ServerWorkAccessHttp(
      configuration.issuerUrl,
      concurrentSecret,
      observedFetch,
    );
    concurrentSecret.fill(0);
    const concurrentAttempt = await concurrentAccess.createAttempt({
      version: 1,
      commandId: randomUUID(),
      clientInstanceId: randomUUID(),
      userAid: admitted.user.principal.aid,
      credentialSaid: admitted.user.credential.credentialSaid,
      grantSecretHash: concurrentAccess.grantSecretHash,
    });
    if (concurrentAttempt.kind !== 'AwaitingProof') {
      throw new Error(`concurrent retry attempt was not awaiting proof: ${concurrentAttempt.kind}`);
    }
    const concurrentResponseSaid = await admitted.userAidProof.respond(
      concurrentAttempt.challengeWords,
    );
    const submissions = await Promise.all([
      concurrentAccess.submitProof(concurrentAttempt.attemptId, concurrentResponseSaid),
      concurrentAccess.submitProof(concurrentAttempt.attemptId, concurrentResponseSaid),
    ]);
    expect(submissions).toEqual([
      expect.objectContaining({ kind: 'Pending' }),
      expect.objectContaining({ kind: 'Pending' }),
    ]);
    let concurrentObservation: WorkAccessHttpObservation = submissions[0];
    for (let poll = 0; poll < 20 && concurrentObservation.kind === 'Pending'; poll += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      concurrentObservation = await concurrentAccess.observeAttempt(concurrentAttempt.attemptId);
    }
    expect(concurrentObservation).toMatchObject({
      kind: 'Observed',
      attempt: { kind: 'Granted', verifiedResponseSaid: concurrentResponseSaid },
    });

    const awaiting = projections.filter(
      (projection): projection is Extract<WorkAccessAttemptProjection, { kind: 'AwaitingProof' }> =>
        projection.kind === 'AwaitingProof',
    );
    const bearers = new Set(
      authorizations.map((authorization) => authorization.slice('Bearer '.length)),
    );
    if (awaiting.length !== 2 || bearers.size !== 2) {
      throw new Error('live Work Access private-material evidence was not observed');
    }
    for (const bearer of bearers) {
      expect(bearer).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    }

    const privateNeedles = [
      ...bearers,
      ...awaiting.flatMap((projection) => [
        JSON.stringify(projection.challengeWords),
        projection.challengeWords.join(' '),
      ]),
    ];
    for (const name of ['signify-custody.json', 'user-profile.json']) {
      const content = await readFile(join(configuration.stateDirectory, name), 'utf8');
      for (const needle of privateNeedles) {
        expect(content).not.toContain(needle);
      }
    }
    await expect(
      readFile(join(configuration.stateDirectory, 'registration-secrets.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    const composeProject = process.env.DEVRANDOM_WORK_ACCESS_COMPOSE_PROJECT;
    const composeEnvironment = process.env.DEVRANDOM_WORK_ACCESS_COMPOSE_ENV;
    if (composeProject === undefined || composeEnvironment === undefined) {
      throw new Error('live Work Access evidence configuration is incomplete');
    }
    const logs = await executeFile(
      'docker',
      [
        'compose',
        '--project-name',
        composeProject,
        '--env-file',
        composeEnvironment,
        'logs',
        '--no-color',
        'server',
        'site',
      ],
      { maxBuffer: 4 * 1_024 * 1_024 },
    );
    for (const needle of privateNeedles) {
      expect(logs.stdout).not.toContain(needle);
      expect(logs.stderr).not.toContain(needle);
    }
  }, 120_000);
});
