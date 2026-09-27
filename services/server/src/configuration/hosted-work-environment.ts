import { Buffer } from 'node:buffer';

import {
  workAccessPolicy,
  workAccessPolicyForGrantLifetime,
  type WorkAccessPolicy,
} from '../access/domain/work-access-policy.js';

declare const hostedWorkMongoUriBrand: unique symbol;

export type HostedWorkMongoUri = string & {
  readonly [hostedWorkMongoUriBrand]: 'HostedWorkMongoUri';
};

export interface HostedWorkConfiguration {
  readonly mongodbUri: HostedWorkMongoUri;
  readonly workAccessPolicy: WorkAccessPolicy;
  readonly approvedNineRunOwnerAid?: string;
}

export type HostedWorkConfigurationError =
  | { readonly kind: 'HostedWorkMongoBindingMissing' }
  | { readonly kind: 'HostedWorkMongoBindingInvalid' }
  | { readonly kind: 'WorkAccessGrantLifetimeInvalid' }
  | { readonly kind: 'TaskCursorKeyMissing' }
  | { readonly kind: 'TaskCursorKeyInvalid' }
  | { readonly kind: 'NineRunOwnerAidInvalid' };

function configurationFailureMessage(detail: HostedWorkConfigurationError): string {
  switch (detail.kind) {
    case 'HostedWorkMongoBindingMissing':
      return 'DEVRANDOM_HOSTED_WORK_MONGODB_URI is required';
    case 'HostedWorkMongoBindingInvalid':
      return 'DEVRANDOM_HOSTED_WORK_MONGODB_URI is invalid';
    case 'WorkAccessGrantLifetimeInvalid':
      return 'DEVRANDOM_WORK_ACCESS_GRANT_LIFETIME_SECONDS must be a positive integer no greater than 1800';
    case 'TaskCursorKeyMissing':
      return 'DEVRANDOM_TASK_CURSOR_KEY is required';
    case 'TaskCursorKeyInvalid':
      return 'DEVRANDOM_TASK_CURSOR_KEY is invalid';
    case 'NineRunOwnerAidInvalid':
      return 'DEVRANDOM_APPROVED_NINE_RUN_OWNER_AID is invalid';
  }
}

export class HostedWorkConfigurationFailure extends Error {
  readonly detail: HostedWorkConfigurationError;

  constructor(detail: HostedWorkConfigurationError, cause?: unknown) {
    super(configurationFailureMessage(detail), cause === undefined ? undefined : { cause });
    this.name = 'HostedWorkConfigurationFailure';
    this.detail = detail;
  }
}

export interface HostedWorkEnvironment {
  readonly DEVRANDOM_HOSTED_WORK_MONGODB_URI?: string | undefined;
  readonly DEVRANDOM_WORK_ACCESS_GRANT_LIFETIME_SECONDS?: string | undefined;
  readonly DEVRANDOM_TASK_CURSOR_KEY?: string | undefined;
  readonly DEVRANDOM_APPROVED_NINE_RUN_OWNER_AID?: string | undefined;
}

export function loadTaskCursorKey(environment: HostedWorkEnvironment): Uint8Array {
  const encoded = environment.DEVRANDOM_TASK_CURSOR_KEY;
  if (encoded === undefined || encoded.length === 0) {
    throw new HostedWorkConfigurationFailure({ kind: 'TaskCursorKeyMissing' });
  }
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) {
    throw new HostedWorkConfigurationFailure({ kind: 'TaskCursorKeyInvalid' });
  }
  const decoded = Buffer.from(encoded, 'base64url');
  if (decoded.byteLength < 32 || decoded.toString('base64url') !== encoded) {
    throw new HostedWorkConfigurationFailure({ kind: 'TaskCursorKeyInvalid' });
  }
  return Uint8Array.from(decoded);
}

export function loadHostedWorkConfiguration(
  environment: HostedWorkEnvironment,
): HostedWorkConfiguration {
  const mongodbUri = environment.DEVRANDOM_HOSTED_WORK_MONGODB_URI;
  if (mongodbUri === undefined || mongodbUri.length === 0) {
    throw new HostedWorkConfigurationFailure({ kind: 'HostedWorkMongoBindingMissing' });
  }

  let parsed: URL;
  try {
    parsed = new URL(mongodbUri);
  } catch (cause) {
    throw new HostedWorkConfigurationFailure({ kind: 'HostedWorkMongoBindingInvalid' }, cause);
  }
  if (
    (parsed.protocol !== 'mongodb:' && parsed.protocol !== 'mongodb+srv:') ||
    parsed.hostname.length === 0 ||
    parsed.pathname !== '/devrandom_e0' ||
    parsed.hash.length > 0 ||
    (parsed.protocol === 'mongodb+srv:' && parsed.port.length > 0)
  ) {
    throw new HostedWorkConfigurationFailure({ kind: 'HostedWorkMongoBindingInvalid' });
  }

  const configuredGrantLifetime = environment.DEVRANDOM_WORK_ACCESS_GRANT_LIFETIME_SECONDS;
  let effectiveWorkAccessPolicy = workAccessPolicy;
  if (configuredGrantLifetime !== undefined && configuredGrantLifetime.length > 0) {
    if (!/^[1-9][0-9]*$/u.test(configuredGrantLifetime)) {
      throw new HostedWorkConfigurationFailure({ kind: 'WorkAccessGrantLifetimeInvalid' });
    }
    try {
      effectiveWorkAccessPolicy = workAccessPolicyForGrantLifetime(Number(configuredGrantLifetime));
    } catch (cause) {
      throw new HostedWorkConfigurationFailure({ kind: 'WorkAccessGrantLifetimeInvalid' }, cause);
    }
  }

  const approvedNineRunOwnerAid = environment.DEVRANDOM_APPROVED_NINE_RUN_OWNER_AID;
  if (
    approvedNineRunOwnerAid !== undefined &&
    approvedNineRunOwnerAid.length > 0 &&
    !/^E[A-Za-z0-9_-]{43}$/u.test(approvedNineRunOwnerAid)
  ) {
    throw new HostedWorkConfigurationFailure({ kind: 'NineRunOwnerAidInvalid' });
  }

  return {
    mongodbUri: mongodbUri as HostedWorkMongoUri,
    workAccessPolicy: effectiveWorkAccessPolicy,
    ...(approvedNineRunOwnerAid ? { approvedNineRunOwnerAid } : {}),
  };
}
