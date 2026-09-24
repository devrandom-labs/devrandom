import { randomPasscode, ready, SignifyClient, Tier } from 'signify-ts';

import { IdentityFailure, reasonFromUnknown } from './identity-error.js';
import { agentAid, controllerAid, type AgentAid, type ControllerAid } from './keri-identifier.js';

export type SignifySecurityTier = 'low' | 'med' | 'high';

export interface SignifyControllerConfiguration {
  readonly adminUrl: string;
  readonly bootUrl: string;
  readonly bran: string;
  readonly securityTier: SignifySecurityTier;
}

export interface ConnectedSignifyController {
  readonly client: SignifyClient;
  readonly controllerAid: ControllerAid;
  readonly agentAid: AgentAid;
  readonly connection: 'controller-bootstrapped' | 'existing-controller-connected';
}

function signifyTier(tier: SignifySecurityTier): Tier {
  switch (tier) {
    case 'low':
      return Tier.low;
    case 'med':
      return Tier.med;
    case 'high':
      return Tier.high;
  }
}

async function initializeSignify(): Promise<void> {
  try {
    await ready();
  } catch (cause) {
    throw new IdentityFailure(
      {
        kind: 'signify-initialization-failed',
        reason: reasonFromUnknown(cause),
      },
      cause,
    );
  }
}

export async function generateSignifyBran(): Promise<string> {
  await initializeSignify();
  const bran = randomPasscode();
  if (!/^[A-Za-z0-9_-]{21}$/u.test(bran)) {
    throw new IdentityFailure({
      kind: 'signify-initialization-failed',
      reason: 'generated controller passcode has an unexpected representation',
    });
  }
  return bran;
}

function signifyClient(configuration: SignifyControllerConfiguration): SignifyClient {
  return new SignifyClient(
    configuration.adminUrl,
    configuration.bran,
    signifyTier(configuration.securityTier),
    configuration.bootUrl,
  );
}

function missingAgentError(cause: unknown, expectedControllerAid: string): boolean {
  return (
    cause instanceof Error &&
    cause.message === `agent does not exist for controller ${expectedControllerAid}`
  );
}

async function connect(client: SignifyClient, stage: string): Promise<void> {
  try {
    await client.connect();
  } catch (cause) {
    throw new IdentityFailure(
      {
        kind: 'keria-unavailable',
        stage,
        reason: reasonFromUnknown(cause),
      },
      cause,
    );
  }
}

function connectedController(
  client: SignifyClient,
  connection: ConnectedSignifyController['connection'],
): ConnectedSignifyController {
  const agentPrefix = client.agent?.pre;
  if (agentPrefix === undefined) {
    throw new IdentityFailure({
      kind: 'controller-state-invalid',
      reason: 'connected Signify client has no agent AID',
    });
  }

  const controllerPrefixValue = client.controller.pre;
  if (controllerPrefixValue === agentPrefix) {
    throw new IdentityFailure({
      kind: 'controller-state-invalid',
      reason: 'controller and agent AIDs must be distinct',
    });
  }

  const controllerPrefix = controllerAid(controllerPrefixValue);
  const agentPrefixAid = agentAid(agentPrefix);

  return {
    client,
    controllerAid: controllerPrefix,
    agentAid: agentPrefixAid,
    connection,
  };
}

export async function connectOrBootstrapSignifyController(
  configuration: SignifyControllerConfiguration,
): Promise<ConnectedSignifyController> {
  await initializeSignify();
  const client = signifyClient(configuration);
  const expectedControllerAid = client.controller.pre;

  try {
    await client.connect();
    return connectedController(client, 'existing-controller-connected');
  } catch (cause) {
    if (!missingAgentError(cause, expectedControllerAid)) {
      throw new IdentityFailure(
        {
          kind: 'keria-unavailable',
          stage: 'controller connection',
          reason: reasonFromUnknown(cause),
        },
        cause,
      );
    }
  }

  let response: Response;
  try {
    response = await client.boot();
  } catch (bootCause) {
    try {
      await client.connect();
      return connectedController(client, 'controller-bootstrapped');
    } catch (reconciliationCause) {
      const cause = new AggregateError(
        [bootCause, reconciliationCause],
        'controller boot result could not be reconciled',
        { cause: reconciliationCause },
      );
      throw new IdentityFailure(
        {
          kind: 'keria-unavailable',
          stage: 'controller boot result reconciliation',
          reason: reasonFromUnknown(reconciliationCause),
        },
        cause,
      );
    }
  }
  if (!response.ok) {
    throw new IdentityFailure({
      kind: 'controller-boot-rejected',
      status: response.status,
    });
  }

  await connect(client, 'controller connection after boot');
  return connectedController(client, 'controller-bootstrapped');
}

export async function connectSignifyController(
  configuration: SignifyControllerConfiguration,
): Promise<ConnectedSignifyController> {
  await initializeSignify();
  const client = signifyClient(configuration);
  await connect(client, 'existing controller connection');
  return connectedController(client, 'existing-controller-connected');
}
