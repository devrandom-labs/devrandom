import { randomUUID } from 'node:crypto';

import { type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { taskOwnerAid } from '../../task/test/task-command-fixture.js';
import { admitBaselineHarness } from '../application/admit-baseline-harness.js';
import { baselineHarnessCommandFixture } from '../test/harness-command-fixture.js';
import { harnessRoutes, type HarnessRoutesConfiguration } from './harness-routes.js';

const userCredentialSaid = `E${'b'.repeat(43)}`;
const bearerSecret = 's'.repeat(43);
const command = baselineHarnessCommandFixture();
const projection = {
  version: 1 as const,
  ownerAid: taskOwnerAid,
  commandId: command.commandId,
  acceptedAt: '2026-09-24T12:30:00.000Z',
  revision: command.revision,
};

function configuration(
  overrides: Partial<HarnessRoutesConfiguration> = {},
): HarnessRoutesConfiguration {
  return {
    access: {
      authorize: () =>
        Promise.resolve({
          kind: 'HarnessAccessAuthorized',
          owner: { ownerAid: taskOwnerAid, credentialSaid: userCredentialSaid },
        }),
    },
    conversation: {
      admit: () => Promise.resolve({ kind: 'HarnessRevisionCreated', projection }),
    },
    now: () => '2026-09-24T12:30:00.000Z',
    newCorrelationId: randomUUID,
    ...overrides,
  };
}

async function server(configurationInput: HarnessRoutesConfiguration) {
  const instance = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await instance.register(harnessRoutes(configurationInput));
  return instance;
}

describe('Harness Revision HTTP route', () => {
  it('derives the owner from run:prepare and admits the exact path-bound H1', async () => {
    const authorize = vi.fn<HarnessRoutesConfiguration['access']['authorize']>(() =>
      Promise.resolve({
        kind: 'HarnessAccessAuthorized',
        owner: { ownerAid: taskOwnerAid, credentialSaid: userCredentialSaid },
      }),
    );
    const admit = vi.fn<HarnessRoutesConfiguration['conversation']['admit']>(() =>
      Promise.resolve({ kind: 'HarnessRevisionCreated', projection }),
    );
    const instance = await server(
      configuration({ access: { authorize }, conversation: { admit } }),
    );

    const response = await instance.inject({
      method: 'PUT',
      url: `/api/harness-revisions/${command.revision.d}`,
      headers: { authorization: `Bearer ${bearerSecret}` },
      payload: command,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual(projection);
    expect(authorize).toHaveBeenCalledExactlyOnceWith({
      bearerSecret,
      scope: 'run:prepare',
      observedAt: '2026-09-24T12:30:00.000Z',
    });
    expect(admit).toHaveBeenCalledOnce();
    const admission = admit.mock.calls[0]?.[0];
    expect(admission?.owner).toEqual({
      ownerAid: taskOwnerAid,
      credentialSaid: userCredentialSaid,
    });
    expect(admission?.command).toEqual(command);
    expect(admission?.protectedCredentials.inspect(new TextEncoder().encode(bearerSecret))).toEqual(
      {
        kind: 'WithheldSecret',
        reason: 'Credential',
        byteLength: bearerSecret.length,
      },
    );
    await instance.close();
  });

  it('rejects a path/body SAID mismatch before application invocation', async () => {
    const admit = vi.fn<HarnessRoutesConfiguration['conversation']['admit']>();
    const instance = await server(configuration({ conversation: { admit } }));

    const response = await instance.inject({
      method: 'PUT',
      url: `/api/harness-revisions/E${'z'.repeat(43)}`,
      headers: { authorization: `Bearer ${bearerSecret}` },
      payload: command,
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      code: 'HarnessRevisionRejected',
      reason: 'HarnessSaidMismatch',
    });
    expect(admit).not.toHaveBeenCalled();
    await instance.close();
  });

  it('rejects a valid H1 containing its authorized Grant bearer before admission', async () => {
    const secretCommand = baselineHarnessCommandFixture(undefined, bearerSecret);
    const reconcile = vi.fn(() => Promise.resolve({ kind: 'NoHarnessRevision' as const }));
    const admit = vi.fn<HarnessRoutesConfiguration['conversation']['admit']>((input) =>
      admitBaselineHarness(input, {
        currentUserCredential: {
          verify: () => Promise.resolve({ kind: 'UserCredentialNotCurrent' }),
        },
        currentTaskMandate: { authorize: () => Promise.resolve({ kind: 'TaskNotFound' }) },
        revisions: {
          reconcile,
          create: () => Promise.resolve({ kind: 'HarnessRevisionCreated' }),
          findAccepted: () => Promise.resolve({ kind: 'HarnessNotFound' }),
        },
        now: () => '2026-09-24T12:30:00.000Z',
      }),
    );
    const instance = await server(configuration({ conversation: { admit } }));

    const response = await instance.inject({
      method: 'PUT',
      url: `/api/harness-revisions/${secretCommand.revision.d}`,
      headers: { authorization: `Bearer ${bearerSecret}` },
      payload: secretCommand,
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      code: 'HarnessRevisionRejected',
      reason: 'SecretDetected',
    });
    expect(admit).toHaveBeenCalledOnce();
    expect(reconcile).not.toHaveBeenCalled();
    await instance.close();
  });

  it('rejects owner and Governor fields outside the closed H1 command', async () => {
    const admit = vi.fn<HarnessRoutesConfiguration['conversation']['admit']>();
    const instance = await server(configuration({ conversation: { admit } }));

    const response = await instance.inject({
      method: 'PUT',
      url: `/api/harness-revisions/${command.revision.d}`,
      headers: { authorization: `Bearer ${bearerSecret}` },
      payload: { ...command, ownerAid: taskOwnerAid, governorAid: `E${'g'.repeat(43)}` },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'HarnessRequestInvalid' });
    expect(admit).not.toHaveBeenCalled();
    await instance.close();
  });
});
