import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import {
  HostedWorkConfigurationFailure,
  loadHostedWorkConfiguration,
  loadTaskCursorKey,
} from './hosted-work-environment.js';
import { workAccessPolicy } from '../access/domain/work-access-policy.js';

describe('hosted-work server configuration', () => {
  it.each([
    'mongodb://mongodb:27017/devrandom_e0?replicaSet=devrandom-rs',
    'mongodb+srv://devrandom-user:private-password@cluster.example/devrandom_e0?retryWrites=true&w=majority',
  ])('accepts a server-only MongoDB binding for devrandom_e0', (mongodbUri) => {
    expect(loadHostedWorkConfiguration({ DEVRANDOM_HOSTED_WORK_MONGODB_URI: mongodbUri })).toEqual({
      mongodbUri,
      workAccessPolicy,
    });
  });

  it('accepts only a lower machine-specific Work Access Grant lifetime', () => {
    const environment = {
      DEVRANDOM_HOSTED_WORK_MONGODB_URI:
        'mongodb://mongodb:27017/devrandom_e0?replicaSet=devrandom-rs',
      DEVRANDOM_WORK_ACCESS_GRANT_LIFETIME_SECONDS: '45',
    };

    expect(loadHostedWorkConfiguration(environment).workAccessPolicy).toEqual({
      ...workAccessPolicy,
      grantLifetimeSeconds: 45,
    });
  });

  it.each(['0', '-1', '1.5', 'not-a-duration', '1801'])(
    'rejects an invalid or ceiling-raising Work Access Grant lifetime %s',
    (grantLifetimeSeconds) => {
      const environment = {
        DEVRANDOM_HOSTED_WORK_MONGODB_URI:
          'mongodb://mongodb:27017/devrandom_e0?replicaSet=devrandom-rs',
        DEVRANDOM_WORK_ACCESS_GRANT_LIFETIME_SECONDS: grantLifetimeSeconds,
      };

      expect(() => loadHostedWorkConfiguration(environment)).toThrow(
        HostedWorkConfigurationFailure,
      );
    },
  );

  it.each([
    undefined,
    '',
    'https://cluster.example/devrandom_e0',
    'mongodb://mongodb:27017/devrandom',
    'mongodb://mongodb:27017/devrandom_e0#credentials',
  ])('rejects a missing or inapplicable hosted-work binding', (mongodbUri) => {
    expect(() =>
      loadHostedWorkConfiguration({ DEVRANDOM_HOSTED_WORK_MONGODB_URI: mongodbUri }),
    ).toThrow(HostedWorkConfigurationFailure);
  });

  it('never places the connection string in its caller-visible error', () => {
    const mongodbUri = 'mongodb://private-user:private-password@mongodb:27017/wrong';
    try {
      loadHostedWorkConfiguration({ DEVRANDOM_HOSTED_WORK_MONGODB_URI: mongodbUri });
    } catch (cause) {
      expect(cause).toBeInstanceOf(HostedWorkConfigurationFailure);
      expect(cause).toBeInstanceOf(Error);
      if (cause instanceof Error) {
        expect(cause.message).not.toContain('private-user');
        expect(cause.message).not.toContain('private-password');
      }
      return;
    }
    throw new Error('invalid hosted-work configuration was accepted');
  });

  it('decodes a server-only Task cursor key with at least 32 bytes', () => {
    const encoded = Buffer.alloc(32, 7).toString('base64url');

    expect([...loadTaskCursorKey({ DEVRANDOM_TASK_CURSOR_KEY: encoded })]).toEqual([
      ...Buffer.alloc(32, 7),
    ]);
  });

  it.each([
    undefined,
    '',
    Buffer.alloc(31, 7).toString('base64url'),
    `${Buffer.alloc(32, 7).toString('base64url')}=`,
    'not+base64url',
  ])('rejects a missing, short, or noncanonical Task cursor key', (encoded) => {
    expect(() => loadTaskCursorKey({ DEVRANDOM_TASK_CURSOR_KEY: encoded })).toThrow(
      HostedWorkConfigurationFailure,
    );
  });
});
