import { type EventResult, type OOBIOperation, type SignifyClient } from 'signify-ts';
import Type from 'typebox';
import Value from 'typebox/value';

import { signifyUserChallengeProof, type UserChallengeProof } from './challenge.js';
import { signifyCredentialSchemaAvailability } from './credential-schema.js';
import type { CredentialPayloadSchema } from './credential-delivery.js';
import { IdentityFailure, reasonFromUnknown } from './identity-error.js';
import {
  type AgentAid,
  type ControllerAid,
  type IssuerAid,
  type IssuerOobi,
  type UserAid,
  type WitnessAid,
} from './keri-identifier.js';
import {
  connectOrBootstrapSignifyController,
  connectSignifyController,
  type SignifyControllerConfiguration,
} from './signify-controller.js';
import { completeSignifyOperation } from './signify-operation.js';
import {
  provisionWitnessedUserIdentifier,
  rotateWitnessedUserIdentifier,
  verifyWitnessedUserIdentifier,
  type WitnessedUserIdentifier,
  type WitnessedUserPolicy,
} from './user-identifier.js';
import {
  signifyUserCredentialReception,
  type UserCredentialReception,
} from './user-credential-reception.js';

export interface WitnessOobi {
  readonly aid: WitnessAid;
  readonly oobi: string;
}

interface LocalUserConnectionPolicy extends SignifyControllerConfiguration {
  readonly alias: string;
  readonly witnessPolicy: WitnessedUserPolicy;
  readonly witnessOobis: readonly WitnessOobi[];
  readonly operationTimeoutMs: number;
  readonly oobiAvailabilityTimeoutMs: number;
}

export interface ProvisionLocalUser extends LocalUserConnectionPolicy {
  readonly kind: 'provision-local-user';
}

export interface RecoverLocalUser extends LocalUserConnectionPolicy {
  readonly kind: 'recover-local-user';
  readonly expectedControllerAid: ControllerAid;
  readonly expectedAgentAid: AgentAid;
  readonly expectedUserAid: UserAid;
}

export type LocalUserConnection = ProvisionLocalUser | RecoverLocalUser;

export interface LocalUserIdentity {
  readonly controllerAid: ControllerAid;
  readonly agentAid: AgentAid;
  readonly user: WitnessedUserIdentifier;
  readonly userAgentOobi: string;
}

export interface LocalUserInfrastructure {
  readonly identity: LocalUserIdentity;
  readonly challengeProof: UserChallengeProof;
  readonly credentialReception: UserCredentialReception;
  resolveIssuer(oobi: IssuerOobi, expectedIssuer: IssuerAid): Promise<void>;
  resolveCredentialSchema(schemaOobi: string, expected: CredentialPayloadSchema): Promise<void>;
  rotate(): Promise<WitnessedUserIdentifier>;
}

const endRoleSchema = Type.Object(
  {
    cid: Type.String({ minLength: 1 }),
    role: Type.String({ minLength: 1 }),
    eid: Type.String({ minLength: 1 }),
  },
  { additionalProperties: true },
);

const endRolesSchema = Type.Array(endRoleSchema);

const agentOobiSchema = Type.Object(
  {
    role: Type.Literal('agent'),
    oobis: Type.Array(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export function verifyUserAgentOobiEvidence(
  evidence: unknown,
  expectedUser: UserAid,
  expectedAgent: AgentAid,
): string {
  if (!Value.Check(agentOobiSchema, evidence) || evidence.oobis.length !== 1) {
    return invalidUserInfrastructure('user agent OOBI response is absent or ambiguous');
  }
  const oobi = evidence.oobis[0];
  if (oobi === undefined) {
    return invalidUserInfrastructure('user agent OOBI response is absent');
  }
  let parsed: URL;
  try {
    parsed = new URL(oobi);
  } catch (cause) {
    return invalidUserInfrastructure('user agent OOBI is not a URL', cause);
  }
  const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    segments.length !== 4 ||
    segments[0] !== 'oobi' ||
    segments[1] !== expectedUser ||
    segments[2] !== 'agent' ||
    segments[3] !== expectedAgent
  ) {
    return invalidUserInfrastructure('user agent OOBI does not bind the expected user and agent');
  }
  return oobi;
}

export async function connectLocalUserInfrastructure(
  input: LocalUserConnection,
): Promise<LocalUserInfrastructure> {
  const controller =
    input.kind === 'provision-local-user'
      ? await connectOrBootstrapSignifyController(input)
      : await connectSignifyController(input);

  if (input.kind === 'recover-local-user') {
    if (
      controller.controllerAid !== input.expectedControllerAid ||
      controller.agentAid !== input.expectedAgentAid
    ) {
      return invalidUserInfrastructure('controller or KERIA agent differs from the local profile');
    }
  }

  for (const witness of input.witnessOobis) {
    await resolveWitnessOobi(controller.client, witness, input.operationTimeoutMs);
  }

  const user =
    input.kind === 'provision-local-user'
      ? await provisionWitnessedUserIdentifier(
          controller.client,
          input.alias,
          input.witnessPolicy,
          input.operationTimeoutMs,
        )
      : await verifyWitnessedUserIdentifier(controller.client, input.alias, input.witnessPolicy);

  if (input.kind === 'recover-local-user' && user.aid !== input.expectedUserAid) {
    return invalidUserInfrastructure('managed user AID differs from the local profile');
  }

  if (input.kind === 'provision-local-user') {
    await ensureUserAgentEndRole(
      controller.client,
      input.alias,
      user.aid,
      controller.agentAid,
      input.operationTimeoutMs,
    );
  } else {
    await verifyUserAgentEndRole(controller.client, user.aid, controller.agentAid);
  }
  const userAgentOobi = await availableUserAgentOobi(
    controller.client,
    input.alias,
    user.aid,
    controller.agentAid,
    input.oobiAvailabilityTimeoutMs,
  );

  return {
    identity: {
      controllerAid: controller.controllerAid,
      agentAid: controller.agentAid,
      user,
      userAgentOobi,
    },
    challengeProof: signifyUserChallengeProof(controller.client),
    credentialReception: signifyUserCredentialReception(controller.client),
    resolveIssuer: (oobi, expectedIssuer) =>
      resolveIssuerOobi(controller.client, oobi, expectedIssuer, input.operationTimeoutMs),
    resolveCredentialSchema: (schemaOobi, expected) =>
      signifyCredentialSchemaAvailability(
        controller.client,
        expected,
        input.operationTimeoutMs,
      ).resolve(schemaOobi),
    rotate: () =>
      rotateWitnessedUserIdentifier(
        controller.client,
        input.alias,
        input.witnessPolicy,
        input.operationTimeoutMs,
      ),
  };
}

async function resolveIssuerOobi(
  client: SignifyClient,
  oobi: IssuerOobi,
  expectedIssuer: IssuerAid,
  timeoutMs: number,
): Promise<void> {
  const parsed = new URL(oobi);
  if (!parsed.pathname.split('/').includes(expectedIssuer)) {
    return invalidUserInfrastructure('issuer OOBI does not identify the expected issuer');
  }
  let operation: OOBIOperation;
  try {
    operation = await client.oobis().resolve(oobi);
  } catch (cause) {
    throw unavailable('issuer OOBI resolution', cause);
  }
  await completeSignifyOperation(client, operation, 'issuer OOBI resolution', timeoutMs);
}

async function resolveWitnessOobi(
  client: SignifyClient,
  witness: WitnessOobi,
  timeoutMs: number,
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(witness.oobi);
  } catch (cause) {
    return invalidUserInfrastructure('witness OOBI is not a URL', cause);
  }
  if (!parsed.pathname.split('/').includes(witness.aid)) {
    return invalidUserInfrastructure('witness OOBI does not identify its configured witness');
  }
  let operation: OOBIOperation;
  try {
    operation = await client.oobis().resolve(witness.oobi);
  } catch (cause) {
    throw unavailable('witness OOBI resolution', cause);
  }
  await completeSignifyOperation(client, operation, 'witness OOBI resolution', timeoutMs);
}

async function userAgentEndRoles(client: SignifyClient, user: UserAid): Promise<unknown> {
  try {
    return await client.oobis().endroles(user, 'agent');
  } catch (cause) {
    throw unavailable('user agent end-role lookup', cause);
  }
}

async function verifyUserAgentEndRole(
  client: SignifyClient,
  user: UserAid,
  agent: AgentAid,
): Promise<void> {
  const evidence = await userAgentEndRoles(client, user);
  if (!Value.Check(endRolesSchema, evidence)) {
    return invalidUserInfrastructure('user agent end-role evidence is malformed');
  }
  const matching = evidence.filter((role) => role.cid === user && role.role === 'agent');
  if (matching.length !== 1 || matching[0]?.eid !== agent) {
    return invalidUserInfrastructure('user does not authorize the expected KERIA agent endpoint');
  }
}

async function ensureUserAgentEndRole(
  client: SignifyClient,
  alias: string,
  user: UserAid,
  agent: AgentAid,
  timeoutMs: number,
): Promise<void> {
  try {
    await verifyUserAgentEndRole(client, user, agent);
    return;
  } catch (cause) {
    if (!(cause instanceof IdentityFailure) || cause.detail.kind !== 'user-identifier-invalid') {
      throw cause;
    }
  }

  let authorization: EventResult;
  try {
    authorization = await client.identifiers().addEndRole(alias, 'agent', agent);
  } catch (cause) {
    throw unavailable('user agent end-role authorization', cause);
  }
  await completeSignifyOperation(
    client,
    await authorization.op(),
    'user agent end-role authorization',
    timeoutMs,
  );
  await verifyUserAgentEndRole(client, user, agent);
}

async function availableUserAgentOobi(
  client: SignifyClient,
  alias: string,
  user: UserAid,
  agent: AgentAid,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  do {
    let evidence: unknown;
    try {
      evidence = await client.oobis().get(alias, 'agent');
    } catch (cause) {
      if (Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
        continue;
      }
      throw unavailable('user agent OOBI retrieval', cause);
    }
    try {
      return verifyUserAgentOobiEvidence(evidence, user, agent);
    } catch (cause) {
      if (Date.now() >= deadline) {
        throw cause;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
  } while (Date.now() < deadline);
  return invalidUserInfrastructure('user agent OOBI did not become available');
}

function invalidUserInfrastructure(reason: string, cause?: unknown): never {
  throw new IdentityFailure(
    { kind: 'user-identifier-invalid', reason },
    cause === undefined ? undefined : cause,
  );
}

function unavailable(stage: string, cause: unknown): IdentityFailure {
  return new IdentityFailure(
    { kind: 'keria-unavailable', stage, reason: reasonFromUnknown(cause) },
    cause,
  );
}
