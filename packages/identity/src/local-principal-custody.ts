import { type EventResult, type OOBIOperation, type SignifyClient } from 'signify-ts';
import Type from 'typebox';
import Value from 'typebox/value';

import { IdentityFailure, reasonFromUnknown } from './identity-error.js';
import {
  governorAid,
  personalAgentAid,
  type AgentAid,
  type ControllerAid,
  type GovernorAid,
  type PersonalAgentAid,
  type UserAid,
} from './keri-identifier.js';
import type { WitnessOobi } from './local-user.js';
import {
  connectSignifyController,
  type SignifyControllerConfiguration,
} from './signify-controller.js';
import { completeSignifyOperation } from './signify-operation.js';
import {
  provisionWitnessedIdentifier,
  verifyWitnessedIdentifier,
  type WitnessedIdentifier,
  type WitnessedIdentifierProvisioning,
  type WitnessedUserPolicy,
} from './user-identifier.js';

export const PERSONAL_AGENT_ALIAS = 'devrandom-personal-agent';
export const GOVERNOR_ALIAS = 'devrandom-governor';

export interface WitnessedPersonalAgentIdentifier extends WitnessedIdentifier<PersonalAgentAid> {
  readonly alias: typeof PERSONAL_AGENT_ALIAS;
}

export interface WitnessedGovernorIdentifier extends WitnessedIdentifier<GovernorAid> {
  readonly alias: typeof GOVERNOR_ALIAS;
}

export type LocalPrincipalOrigin = 'principal-provisioned' | 'existing-principal-verified';

interface LocalWitnessedPrincipal<Identifier> {
  readonly origin: LocalPrincipalOrigin;
  readonly identifier: Identifier;
  readonly agentOobi: string;
}

export type LocalPersonalAgent = LocalWitnessedPrincipal<WitnessedPersonalAgentIdentifier>;
export type LocalGovernor = LocalWitnessedPrincipal<WitnessedGovernorIdentifier>;

export interface LocalPrincipalCustody {
  readonly controllerAid: ControllerAid;
  readonly agentAid: AgentAid;
  readonly prepareWitnesses: (policy: WitnessedUserPolicy) => Promise<void>;
  readonly provisionPersonalAgent: (
    policy: WitnessedUserPolicy,
    disallowedAids: readonly string[],
  ) => Promise<LocalPersonalAgent>;
  readonly provisionGovernor: (
    policy: WitnessedUserPolicy,
    disallowedAids: readonly string[],
  ) => Promise<LocalGovernor>;
  readonly recoverPersonalAgent: (
    policy: WitnessedUserPolicy,
    disallowedAids: readonly string[],
  ) => Promise<LocalPersonalAgent>;
  readonly recoverGovernor: (
    policy: WitnessedUserPolicy,
    disallowedAids: readonly string[],
  ) => Promise<LocalGovernor>;
}

interface LocalPrincipalExpectation {
  readonly expectedControllerAid: ControllerAid;
  readonly expectedAgentAid: AgentAid;
  readonly userAid: UserAid;
  readonly witnessPolicy: WitnessedUserPolicy;
}

export interface ProvisionLocalPrincipals extends LocalPrincipalExpectation {
  readonly kind: 'provision-local-principals';
}

export interface RecoverLocalPrincipals extends LocalPrincipalExpectation {
  readonly kind: 'recover-local-principals';
  readonly expectedPersonalAgentAid: PersonalAgentAid;
  readonly expectedGovernorAid: GovernorAid;
}

export type LocalPrincipalEstablishment = ProvisionLocalPrincipals | RecoverLocalPrincipals;

export interface EstablishedLocalPrincipals {
  readonly controllerAid: ControllerAid;
  readonly agentAid: AgentAid;
  readonly userAid: UserAid;
  readonly personalAgent: LocalPersonalAgent;
  readonly governor: LocalGovernor;
}

export interface SignifyLocalPrincipalCustodyConfiguration extends SignifyControllerConfiguration {
  readonly witnessOobis: readonly WitnessOobi[];
  readonly operationTimeoutMs: number;
  readonly oobiAvailabilityTimeoutMs: number;
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

type AgentEndRoleDisposition = { readonly kind: 'Authorized' } | { readonly kind: 'Missing' };

function invalidLocalPrincipals(reason: string, cause?: unknown): never {
  throw new IdentityFailure(
    { kind: 'identifier-conflict', alias: `${PERSONAL_AGENT_ALIAS}/${GOVERNOR_ALIAS}`, reason },
    cause === undefined ? undefined : cause,
  );
}

function principalConflict(alias: string, reason: string, cause?: unknown): never {
  throw new IdentityFailure(
    { kind: 'identifier-conflict', alias, reason },
    cause === undefined ? undefined : cause,
  );
}

function unavailable(stage: string, cause: unknown): IdentityFailure {
  return new IdentityFailure(
    { kind: 'keria-unavailable', stage, reason: reasonFromUnknown(cause) },
    cause,
  );
}

function verifyAllowedAid(alias: string, aid: string, disallowedAids: readonly string[]): void {
  if (disallowedAids.includes(aid)) {
    principalConflict(alias, 'AID aliases another principal in the local Signify profile');
  }
}

function sameAid(left: string, right: string): boolean {
  return left === right;
}

function exactPersonalAgent(
  identifier: WitnessedIdentifier<PersonalAgentAid>,
): WitnessedPersonalAgentIdentifier {
  if (identifier.alias !== PERSONAL_AGENT_ALIAS) {
    principalConflict(PERSONAL_AGENT_ALIAS, `KERIA returned alias ${identifier.alias}`);
  }
  return { ...identifier, alias: PERSONAL_AGENT_ALIAS };
}

function exactGovernor(identifier: WitnessedIdentifier<GovernorAid>): WitnessedGovernorIdentifier {
  if (identifier.alias !== GOVERNOR_ALIAS) {
    principalConflict(GOVERNOR_ALIAS, `KERIA returned alias ${identifier.alias}`);
  }
  return { ...identifier, alias: GOVERNOR_ALIAS };
}

interface LocalPrincipalDefinition<
  Aid extends string,
  Identifier extends WitnessedIdentifier<Aid>,
> {
  readonly alias: string;
  readonly decodeAid: (value: string) => Aid;
  readonly exactIdentifier: (identifier: WitnessedIdentifier<Aid>) => Identifier;
}

const personalAgentDefinition: LocalPrincipalDefinition<
  PersonalAgentAid,
  WitnessedPersonalAgentIdentifier
> = {
  alias: PERSONAL_AGENT_ALIAS,
  decodeAid: personalAgentAid,
  exactIdentifier: exactPersonalAgent,
};

const governorDefinition: LocalPrincipalDefinition<GovernorAid, WitnessedGovernorIdentifier> = {
  alias: GOVERNOR_ALIAS,
  decodeAid: governorAid,
  exactIdentifier: exactGovernor,
};

function principalOrigin(
  outcome: WitnessedIdentifierProvisioning<string>['kind'],
): LocalPrincipalOrigin {
  switch (outcome) {
    case 'identifier-provisioned':
      return 'principal-provisioned';
    case 'existing-identifier-verified':
      return 'existing-principal-verified';
  }
}

function translateIdentifierFailure(alias: string, cause: unknown): never {
  if (cause instanceof IdentityFailure && cause.detail.kind === 'user-identifier-invalid') {
    principalConflict(alias, cause.detail.reason, cause);
  }
  throw cause;
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
    return invalidLocalPrincipals('witness OOBI is not a URL', cause);
  }
  if (!parsed.pathname.split('/').includes(witness.aid)) {
    return invalidLocalPrincipals('witness OOBI does not identify its configured witness');
  }

  let operation: OOBIOperation;
  try {
    operation = await client.oobis().resolve(witness.oobi);
  } catch (cause) {
    throw unavailable('local-principal witness OOBI resolution', cause);
  }
  await completeSignifyOperation(
    client,
    operation,
    'local-principal witness OOBI resolution',
    timeoutMs,
  );
}

async function agentEndRoleDisposition(
  client: SignifyClient,
  alias: string,
  aid: string,
  expectedAgent: AgentAid,
): Promise<AgentEndRoleDisposition> {
  let evidence: unknown;
  try {
    evidence = await client.oobis().endroles(aid, 'agent');
  } catch (cause) {
    throw unavailable(`${alias} agent end-role lookup`, cause);
  }
  if (!Value.Check(endRolesSchema, evidence)) {
    return principalConflict(alias, 'agent end-role evidence is malformed');
  }
  const matching = evidence.filter((role) => role.cid === aid && role.role === 'agent');
  if (matching.length === 0) {
    return { kind: 'Missing' };
  }
  if (matching.length !== 1 || matching[0]?.eid !== expectedAgent) {
    return principalConflict(alias, 'agent end role does not name the expected KERIA agent');
  }
  return { kind: 'Authorized' };
}

async function verifyAgentEndRole(
  client: SignifyClient,
  alias: string,
  aid: string,
  expectedAgent: AgentAid,
): Promise<void> {
  const disposition = await agentEndRoleDisposition(client, alias, aid, expectedAgent);
  if (disposition.kind === 'Missing') {
    principalConflict(alias, 'required agent endpoint role is missing');
  }
}

async function ensureAgentEndRole(
  client: SignifyClient,
  alias: string,
  aid: string,
  expectedAgent: AgentAid,
  timeoutMs: number,
): Promise<void> {
  const disposition = await agentEndRoleDisposition(client, alias, aid, expectedAgent);
  if (disposition.kind === 'Authorized') {
    return;
  }

  let authorization: EventResult;
  try {
    authorization = await client.identifiers().addEndRole(alias, 'agent', expectedAgent);
  } catch (cause) {
    throw unavailable(`${alias} agent end-role authorization`, cause);
  }
  let operation: unknown;
  try {
    operation = await authorization.op();
  } catch (cause) {
    throw unavailable(`${alias} agent end-role operation submission`, cause);
  }
  await completeSignifyOperation(
    client,
    operation,
    `${alias} agent end-role authorization`,
    timeoutMs,
  );
  await verifyAgentEndRole(client, alias, aid, expectedAgent);
}

export function verifyLocalPrincipalAgentOobiEvidence(
  evidence: unknown,
  alias: string,
  expectedAid: string,
  expectedAgent: AgentAid,
): string {
  if (!Value.Check(agentOobiSchema, evidence) || evidence.oobis.length !== 1) {
    return principalConflict(alias, 'agent OOBI response is absent or ambiguous');
  }
  const oobi = evidence.oobis[0];
  if (oobi === undefined) {
    return principalConflict(alias, 'agent OOBI response is absent');
  }

  let parsed: URL;
  try {
    parsed = new URL(oobi);
  } catch (cause) {
    return principalConflict(alias, 'agent OOBI is not a URL', cause);
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
    segments[1] !== expectedAid ||
    segments[2] !== 'agent' ||
    segments[3] !== expectedAgent
  ) {
    return principalConflict(alias, 'agent OOBI does not bind the expected principal and agent');
  }
  return oobi;
}

async function availableAgentOobi(
  client: SignifyClient,
  alias: string,
  aid: string,
  expectedAgent: AgentAid,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  do {
    let evidence: unknown;
    try {
      evidence = await client.oobis().get(alias, 'agent');
    } catch (cause) {
      if (Date.now() >= deadline) {
        throw unavailable(`${alias} agent OOBI retrieval`, cause);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      continue;
    }
    try {
      return verifyLocalPrincipalAgentOobiEvidence(evidence, alias, aid, expectedAgent);
    } catch (cause) {
      if (Date.now() >= deadline) {
        throw cause;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
  } while (Date.now() < deadline);
  return principalConflict(alias, 'agent OOBI did not become available');
}

async function provisionPrincipal<Aid extends string, Identifier extends WitnessedIdentifier<Aid>>(
  client: SignifyClient,
  controllerAgent: AgentAid,
  definition: LocalPrincipalDefinition<Aid, Identifier>,
  policy: WitnessedUserPolicy,
  disallowedAids: readonly string[],
  operationTimeoutMs: number,
  oobiAvailabilityTimeoutMs: number,
): Promise<LocalWitnessedPrincipal<Identifier>> {
  let outcome: WitnessedIdentifierProvisioning<Aid>;
  try {
    outcome = await provisionWitnessedIdentifier(
      client,
      definition.alias,
      policy,
      operationTimeoutMs,
      definition.decodeAid,
    );
  } catch (cause) {
    return translateIdentifierFailure(definition.alias, cause);
  }
  const identifier = definition.exactIdentifier(outcome.identifier);
  verifyAllowedAid(definition.alias, identifier.aid, disallowedAids);
  await ensureAgentEndRole(
    client,
    definition.alias,
    identifier.aid,
    controllerAgent,
    operationTimeoutMs,
  );
  return {
    origin: principalOrigin(outcome.kind),
    identifier,
    agentOobi: await availableAgentOobi(
      client,
      definition.alias,
      identifier.aid,
      controllerAgent,
      oobiAvailabilityTimeoutMs,
    ),
  };
}

async function recoverPrincipal<Aid extends string, Identifier extends WitnessedIdentifier<Aid>>(
  client: SignifyClient,
  controllerAgent: AgentAid,
  definition: LocalPrincipalDefinition<Aid, Identifier>,
  policy: WitnessedUserPolicy,
  disallowedAids: readonly string[],
  oobiAvailabilityTimeoutMs: number,
): Promise<LocalWitnessedPrincipal<Identifier>> {
  let unrefined: WitnessedIdentifier<Aid>;
  try {
    unrefined = await verifyWitnessedIdentifier(
      client,
      definition.alias,
      policy,
      definition.decodeAid,
      `${definition.alias} witnessed identifier verification`,
    );
  } catch (cause) {
    return translateIdentifierFailure(definition.alias, cause);
  }
  const identifier = definition.exactIdentifier(unrefined);
  verifyAllowedAid(definition.alias, identifier.aid, disallowedAids);
  await verifyAgentEndRole(client, definition.alias, identifier.aid, controllerAgent);
  return {
    origin: 'existing-principal-verified',
    identifier,
    agentOobi: await availableAgentOobi(
      client,
      definition.alias,
      identifier.aid,
      controllerAgent,
      oobiAvailabilityTimeoutMs,
    ),
  };
}

function sameWitnessPolicy(
  policy: WitnessedUserPolicy,
  witnessOobis: readonly WitnessOobi[],
): boolean {
  return (
    witnessOobis.length === policy.witnessAids.length &&
    witnessOobis.every((witness, index) => witness.aid === policy.witnessAids[index])
  );
}

export async function connectLocalPrincipalCustody(
  configuration: SignifyLocalPrincipalCustodyConfiguration,
): Promise<LocalPrincipalCustody> {
  const controller = await connectSignifyController(configuration);
  const { client } = controller;

  async function prepareWitnesses(policy: WitnessedUserPolicy): Promise<void> {
    if (!sameWitnessPolicy(policy, configuration.witnessOobis)) {
      return invalidLocalPrincipals('witness OOBIs do not match the configured witness policy');
    }
    for (const witness of configuration.witnessOobis) {
      await resolveWitnessOobi(client, witness, configuration.operationTimeoutMs);
    }
  }

  return {
    controllerAid: controller.controllerAid,
    agentAid: controller.agentAid,
    prepareWitnesses,
    provisionPersonalAgent: (policy, disallowedAids) =>
      provisionPrincipal(
        client,
        controller.agentAid,
        personalAgentDefinition,
        policy,
        disallowedAids,
        configuration.operationTimeoutMs,
        configuration.oobiAvailabilityTimeoutMs,
      ),
    provisionGovernor: (policy, disallowedAids) =>
      provisionPrincipal(
        client,
        controller.agentAid,
        governorDefinition,
        policy,
        disallowedAids,
        configuration.operationTimeoutMs,
        configuration.oobiAvailabilityTimeoutMs,
      ),
    recoverPersonalAgent: (policy, disallowedAids) =>
      recoverPrincipal(
        client,
        controller.agentAid,
        personalAgentDefinition,
        policy,
        disallowedAids,
        configuration.oobiAvailabilityTimeoutMs,
      ),
    recoverGovernor: (policy, disallowedAids) =>
      recoverPrincipal(
        client,
        controller.agentAid,
        governorDefinition,
        policy,
        disallowedAids,
        configuration.oobiAvailabilityTimeoutMs,
      ),
  };
}

export async function establishLocalPrincipals(
  custody: LocalPrincipalCustody,
  input: LocalPrincipalEstablishment,
): Promise<EstablishedLocalPrincipals> {
  if (
    custody.controllerAid !== input.expectedControllerAid ||
    custody.agentAid !== input.expectedAgentAid
  ) {
    return invalidLocalPrincipals('controller or KERIA agent differs from the local profile');
  }

  await custody.prepareWitnesses(input.witnessPolicy);
  const profileAids: readonly string[] = [input.userAid, custody.controllerAid, custody.agentAid];
  const personalAgent =
    input.kind === 'provision-local-principals'
      ? await custody.provisionPersonalAgent(input.witnessPolicy, profileAids)
      : await custody.recoverPersonalAgent(input.witnessPolicy, profileAids);

  if (
    input.kind === 'recover-local-principals' &&
    personalAgent.identifier.aid !== input.expectedPersonalAgentAid
  ) {
    return invalidLocalPrincipals('personal-agent AID differs from the local profile');
  }

  const governorDisallowedAids = [...profileAids, personalAgent.identifier.aid];
  const governor =
    input.kind === 'provision-local-principals'
      ? await custody.provisionGovernor(input.witnessPolicy, governorDisallowedAids)
      : await custody.recoverGovernor(input.witnessPolicy, governorDisallowedAids);

  if (
    input.kind === 'recover-local-principals' &&
    governor.identifier.aid !== input.expectedGovernorAid
  ) {
    return invalidLocalPrincipals('Governor AID differs from the local profile');
  }
  if (
    sameAid(personalAgent.identifier.aid, input.userAid) ||
    sameAid(governor.identifier.aid, input.userAid) ||
    sameAid(personalAgent.identifier.aid, governor.identifier.aid)
  ) {
    return invalidLocalPrincipals('user, personal-agent, and Governor AIDs must be distinct');
  }

  return {
    controllerAid: custody.controllerAid,
    agentAid: custody.agentAid,
    userAid: input.userAid,
    personalAgent,
    governor,
  };
}
