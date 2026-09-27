import {
  signifyHarnessPublicationSignatures,
  type HarnessPublicationSignatures,
} from './publication-signature.js';
import {
  promotionMandateSchema,
  promotionMandateV2Schema,
  promotionMandateV3Schema,
  promotionMandateV4Schema,
  promotionMandateV6Schema,
  promotionMandateV5Schema,
  promotionMandateV7Schema,
  taskMandateSchema,
  taskMandateV2Schema,
  taskMandateV3Schema,
  taskMandateV4Schema,
} from '@devrandom/protocol';
import { type EventResult, type OOBIOperation, type SignifyClient } from 'signify-ts';
import Type from 'typebox';
import Value from 'typebox/value';

import {
  signifyAsynchronousIssuerChallengeProof,
  signifyIssuerChallengeProof,
  type AsynchronousIssuerChallengeProof,
  type IssuerChallengeProof,
} from './challenge.js';
import {
  signifyDevrandomUserCredentialDelivery,
  type CredentialPayloadSchema,
  type DevrandomUserCredentialDelivery,
} from './credential-delivery.js';
import {
  signifyIssuerEvidenceSealExchange,
  type IssuerEvidenceSealExchange,
} from './evidence-seal-exchange.js';
import {
  signifyIssuerEvaluationClosureSealExchange,
  type IssuerEvaluationClosureSealExchange,
} from './evaluation-closure-seal-exchange.js';
import {
  signifyIssuerPromotionExchanges,
  type IssuerPromotionExchanges,
} from './promotion-exchange-inspection.js';
import {
  signifyIssuerActivationReceiptExchange,
  type IssuerActivationReceiptExchange,
} from './activation-receipt-exchange.js';
import {
  signifyIssuerCurrentUserCredentialVerification,
  type IssuerCurrentUserCredentialVerification,
} from './credential.js';
import {
  signifyCredentialSchemaAvailability,
  type CredentialSchemaAvailability,
} from './credential-schema.js';
import {
  provisionNamedCredentialRegistry,
  verifyNamedCredentialRegistry,
  type CredentialRegistryPolicy,
} from './credential-registry.js';
import { IdentityFailure, reasonFromUnknown } from './identity-error.js';
import {
  issuerOobi,
  provisionNamedKeriIdentifier,
  verifyNamedKeriIdentifier,
  type AgentAid,
  type ControllerAid,
  type CredentialRegistryId,
  type IdentifierWitnessPolicy,
  type IssuerAid,
  type IssuerOobi,
  credentialSchemaId,
} from './keri-identifier.js';
import { signifyMandateAdmission, type MandateAdmission } from './mandate-exchange.js';
import {
  signifyIssuerRunAdmissionExchange,
  type IssuerRunAdmissionExchange,
} from './run-admission-exchange.js';
import {
  connectOrBootstrapSignifyController,
  connectSignifyController,
  type SignifySecurityTier,
} from './signify-controller.js';
import { completeSignifyOperation } from './signify-operation.js';
import { signifyIssuerUserOobiResolution, type IssuerUserOobiResolution } from './user-oobi.js';

export type IssuerWitnessPolicy = IdentifierWitnessPolicy;

export interface IssuerIdentityBootstrapInput {
  readonly adminUrl: string;
  readonly bootUrl: string;
  readonly bran: string;
  readonly securityTier: SignifySecurityTier;
  readonly issuerAlias: string;
  readonly registryName: string;
  readonly witnessPolicy: IssuerWitnessPolicy;
  readonly registryPolicy: CredentialRegistryPolicy;
  readonly operationTimeoutMs: number;
  readonly oobiAvailabilityTimeoutMs: number;
}

export interface VerifiedIssuerIdentity {
  readonly controllerAid: ControllerAid;
  readonly agentAid: AgentAid;
  readonly issuerAid: IssuerAid;
  readonly registryId: CredentialRegistryId;
  readonly issuerOobi: IssuerOobi;
}

export type IssuerIdentityBootstrapOutcome =
  | {
      readonly kind: 'issuer-identity-provisioned';
      readonly identity: VerifiedIssuerIdentity;
    }
  | {
      readonly kind: 'existing-issuer-identity-verified';
      readonly identity: VerifiedIssuerIdentity;
    };

export interface IssuerIdentityVerificationInput {
  readonly adminUrl: string;
  readonly bootUrl: string;
  readonly bran: string;
  readonly securityTier: SignifySecurityTier;
  readonly issuerAlias: string;
  readonly registryName: string;
  readonly witnessPolicy: IssuerWitnessPolicy;
  readonly registryPolicy: CredentialRegistryPolicy;
  readonly operationTimeoutMs: number;
  readonly oobiAvailabilityTimeoutMs: number;
}

export interface VerifiedIssuerInfrastructure {
  readonly identity: VerifiedIssuerIdentity;
  readonly challengeProof: IssuerChallengeProof;
  readonly asynchronousChallengeProof: AsynchronousIssuerChallengeProof;
  readonly userOobiResolution: IssuerUserOobiResolution;
  readonly credentialDelivery: DevrandomUserCredentialDelivery;
  readonly currentUserCredentialVerification: IssuerCurrentUserCredentialVerification;
  readonly credentialSchema: CredentialSchemaAvailability;
  readonly taskMandateSchemaAvailability: CredentialSchemaAvailability;
  readonly taskMandateV2SchemaAvailability: CredentialSchemaAvailability;
  readonly taskMandateV3SchemaAvailability: CredentialSchemaAvailability;
  readonly taskMandateV4SchemaAvailability: CredentialSchemaAvailability;
  readonly promotionMandateSchemaAvailability: CredentialSchemaAvailability;
  readonly promotionMandateV2SchemaAvailability: CredentialSchemaAvailability;
  readonly promotionMandateV3SchemaAvailability: CredentialSchemaAvailability;
  readonly promotionMandateV4SchemaAvailability: CredentialSchemaAvailability;
  readonly promotionMandateV6SchemaAvailability: CredentialSchemaAvailability;
  readonly promotionMandateV5SchemaAvailability: CredentialSchemaAvailability;
  readonly promotionMandateV7SchemaAvailability: CredentialSchemaAvailability;
  readonly mandateAdmission: MandateAdmission;
  readonly runAdmissionExchange: IssuerRunAdmissionExchange;
  readonly evidenceSealExchange: IssuerEvidenceSealExchange;
  readonly evaluationClosureSealExchange: IssuerEvaluationClosureSealExchange;
  readonly promotionExchanges: IssuerPromotionExchanges;
  readonly publicationSignatures: HarnessPublicationSignatures;
  readonly activationReceiptExchange: IssuerActivationReceiptExchange;
  readonly readiness: VerifiedIssuerReadiness;
}

export interface VerifiedIssuerReadiness {
  verify(): Promise<void>;
}

interface VerifiedIssuerConnection {
  readonly client: SignifyClient;
  readonly identity: VerifiedIssuerIdentity;
}

type EndRoleOutcome = 'agent-end-role-established' | 'existing-agent-end-role-verified';

const endRoleSchema = Type.Object({
  cid: Type.String({ minLength: 1 }),
  role: Type.String({ minLength: 1 }),
  eid: Type.String({ minLength: 1 }),
});

const endRolesSchema = Type.Array(endRoleSchema);

const agentOobiSchema = Type.Object({
  role: Type.Literal('agent'),
  oobis: Type.Array(Type.String({ minLength: 1 })),
});

const issuerKeyStatesSchema = Type.Array(
  Type.Object({ i: Type.String({ minLength: 1 }) }, { additionalProperties: true }),
);

export function verifyIssuerKeyStateEvidence(evidence: unknown, expectedIssuer: IssuerAid): void {
  if (
    !Value.Check(issuerKeyStatesSchema, evidence) ||
    evidence.length !== 1 ||
    evidence[0]?.i !== expectedIssuer
  ) {
    throw new IdentityFailure({
      kind: 'keria-response-invalid',
      stage: 'issuer readiness',
      reason: 'response does not identify the exact verified issuer',
    });
  }
}

function signifyIssuerReadiness(
  client: SignifyClient,
  expectedIssuer: IssuerAid,
): VerifiedIssuerReadiness {
  return {
    async verify() {
      let evidence: unknown;
      try {
        evidence = await client.keyStates().get(expectedIssuer);
      } catch (cause) {
        throw new IdentityFailure(
          {
            kind: 'keria-unavailable',
            stage: 'issuer readiness',
            reason: reasonFromUnknown(cause),
          },
          cause,
        );
      }
      verifyIssuerKeyStateEvidence(evidence, expectedIssuer);
    },
  };
}

function sameAid(left: string, right: string): boolean {
  return left === right;
}

async function issuerAgentEndRoles(
  client: SignifyClient,
  issuer: IssuerAid,
): Promise<Type.Static<typeof endRolesSchema>> {
  let untrusted: unknown;
  try {
    untrusted = await client.oobis().endroles(issuer, 'agent');
  } catch (cause) {
    throw new IdentityFailure(
      {
        kind: 'keria-unavailable',
        stage: 'issuer agent end-role lookup',
        reason: reasonFromUnknown(cause),
      },
      cause,
    );
  }
  if (!Value.Check(endRolesSchema, untrusted)) {
    throw new IdentityFailure({
      kind: 'keria-response-invalid',
      stage: 'issuer agent end-role lookup',
      reason: 'response does not contain valid end roles',
    });
  }
  return untrusted;
}

function verifyAgentEndRole(
  roles: Type.Static<typeof endRolesSchema>,
  issuer: IssuerAid,
  agent: AgentAid,
): EndRoleOutcome | undefined {
  const issuerAgentRoles = roles.filter((role) => role.cid === issuer && role.role === 'agent');
  if (issuerAgentRoles.length === 0) {
    return undefined;
  }
  if (
    issuerAgentRoles.length !== 1 ||
    issuerAgentRoles[0] === undefined ||
    issuerAgentRoles[0].eid !== agent
  ) {
    throw new IdentityFailure({
      kind: 'end-role-conflict',
      reason: 'issuer agent role names another endpoint or is ambiguous',
    });
  }
  return 'existing-agent-end-role-verified';
}

async function ensureAgentEndRole(
  client: SignifyClient,
  issuerAlias: string,
  issuer: IssuerAid,
  agent: AgentAid,
  operationTimeoutMs: number,
): Promise<EndRoleOutcome> {
  const existing = verifyAgentEndRole(await issuerAgentEndRoles(client, issuer), issuer, agent);
  if (existing !== undefined) {
    return existing;
  }

  let authorization: EventResult;
  try {
    authorization = await client.identifiers().addEndRole(issuerAlias, 'agent', agent);
  } catch (cause) {
    const reconciled = verifyAgentEndRole(await issuerAgentEndRoles(client, issuer), issuer, agent);
    if (reconciled !== undefined) {
      return 'agent-end-role-established';
    }
    throw new IdentityFailure(
      {
        kind: 'keria-unavailable',
        stage: 'issuer agent end-role authorization',
        reason: reasonFromUnknown(cause),
      },
      cause,
    );
  }

  try {
    await completeSignifyOperation(
      client,
      await authorization.op(),
      'issuer agent end-role authorization',
      operationTimeoutMs,
    );
  } catch (cause) {
    const reconciled = verifyAgentEndRole(await issuerAgentEndRoles(client, issuer), issuer, agent);
    if (reconciled !== undefined) {
      return 'agent-end-role-established';
    }
    if (cause instanceof IdentityFailure) {
      throw cause;
    }
    throw new IdentityFailure(
      {
        kind: 'keria-unavailable',
        stage: 'issuer agent end-role operation submission',
        reason: reasonFromUnknown(cause),
      },
      cause,
    );
  }

  const verified = verifyAgentEndRole(await issuerAgentEndRoles(client, issuer), issuer, agent);
  if (verified === undefined) {
    throw new IdentityFailure({
      kind: 'end-role-conflict',
      reason: 'authorized issuer agent role is not visible after operation completion',
    });
  }
  return 'agent-end-role-established';
}

function verifyOobiBinding(value: IssuerOobi, issuer: IssuerAid, agent: AgentAid): void {
  const segments = new URL(value).pathname.split('/').filter((segment) => segment.length > 0);
  if (
    segments.length !== 4 ||
    segments[0] !== 'oobi' ||
    segments[1] !== issuer ||
    segments[2] !== 'agent' ||
    segments[3] !== agent
  ) {
    throw new IdentityFailure({
      kind: 'issuer-oobi-invalid',
      reason: 'URL does not bind the expected issuer and agent AIDs',
    });
  }
}

function issuerOobiNotFound(cause: unknown, alias: string): boolean {
  return (
    cause instanceof Error &&
    cause.message.startsWith(`HTTP GET /identifiers/${alias}/oobis?role=agent - 404 `)
  );
}

async function availableIssuerOobi(
  client: SignifyClient,
  alias: string,
  issuer: IssuerAid,
  agent: AgentAid,
  timeoutMs: number,
): Promise<IssuerOobi> {
  const deadline = Date.now() + timeoutMs;
  do {
    let untrusted: unknown;
    try {
      untrusted = await client.oobis().get(alias, 'agent');
    } catch (cause) {
      if (issuerOobiNotFound(cause, alias) && Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
        continue;
      }
      throw new IdentityFailure(
        {
          kind: 'keria-unavailable',
          stage: 'issuer OOBI retrieval',
          reason: reasonFromUnknown(cause),
        },
        cause,
      );
    }

    if (!Value.Check(agentOobiSchema, untrusted)) {
      throw new IdentityFailure({
        kind: 'keria-response-invalid',
        stage: 'issuer OOBI retrieval',
        reason: 'response does not contain an agent OOBI list',
      });
    }
    if (untrusted.oobis.length > 1) {
      throw new IdentityFailure({
        kind: 'issuer-oobi-invalid',
        reason: 'more than one agent OOBI was returned for the demo issuer',
      });
    }
    const value = untrusted.oobis[0];
    if (value !== undefined) {
      const oobi = issuerOobi(value);
      verifyOobiBinding(oobi, issuer, agent);
      return oobi;
    }
    if (Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
  } while (Date.now() < deadline);

  throw new IdentityFailure({ kind: 'issuer-oobi-unavailable', alias });
}

async function resolveIssuerOobi(
  client: SignifyClient,
  oobi: IssuerOobi,
  timeoutMs: number,
): Promise<void> {
  let operation: OOBIOperation;
  try {
    operation = await client.oobis().resolve(oobi);
  } catch (cause) {
    throw new IdentityFailure(
      {
        kind: 'keria-unavailable',
        stage: 'issuer OOBI resolution',
        reason: reasonFromUnknown(cause),
      },
      cause,
    );
  }
  await completeSignifyOperation(client, operation, 'issuer OOBI resolution', timeoutMs);
}

export async function provisionIssuerIdentity(
  input: IssuerIdentityBootstrapInput,
): Promise<IssuerIdentityBootstrapOutcome> {
  const controller = await connectOrBootstrapSignifyController({
    adminUrl: input.adminUrl,
    bootUrl: input.bootUrl,
    bran: input.bran,
    securityTier: input.securityTier,
  });
  const identifier = await provisionNamedKeriIdentifier(
    controller.client,
    input.issuerAlias,
    input.witnessPolicy,
    input.operationTimeoutMs,
  );
  if (
    sameAid(identifier.identifier.aid, controller.controllerAid) ||
    sameAid(identifier.identifier.aid, controller.agentAid)
  ) {
    throw new IdentityFailure({
      kind: 'identifier-conflict',
      alias: input.issuerAlias,
      reason: 'issuer AID aliases the controller or KERIA agent AID',
    });
  }
  const endRole = await ensureAgentEndRole(
    controller.client,
    input.issuerAlias,
    identifier.identifier.aid,
    controller.agentAid,
    input.operationTimeoutMs,
  );
  const oobi = await availableIssuerOobi(
    controller.client,
    input.issuerAlias,
    identifier.identifier.aid,
    controller.agentAid,
    input.oobiAvailabilityTimeoutMs,
  );
  await resolveIssuerOobi(controller.client, oobi, input.operationTimeoutMs);
  const registry = await provisionNamedCredentialRegistry(
    controller.client,
    input.issuerAlias,
    identifier.identifier.aid,
    input.registryName,
    input.registryPolicy,
    input.operationTimeoutMs,
  );

  const identity = {
    controllerAid: controller.controllerAid,
    agentAid: controller.agentAid,
    issuerAid: identifier.identifier.aid,
    registryId: registry.registry.id,
    issuerOobi: oobi,
  } satisfies VerifiedIssuerIdentity;

  if (
    controller.connection === 'existing-controller-connected' &&
    identifier.kind === 'existing-identifier-verified' &&
    endRole === 'existing-agent-end-role-verified' &&
    registry.kind === 'existing-credential-registry-verified'
  ) {
    return { kind: 'existing-issuer-identity-verified', identity };
  }
  return { kind: 'issuer-identity-provisioned', identity };
}

async function verifyIssuerConnection(
  input: IssuerIdentityVerificationInput,
): Promise<VerifiedIssuerConnection> {
  const controller = await connectSignifyController({
    adminUrl: input.adminUrl,
    bootUrl: input.bootUrl,
    bran: input.bran,
    securityTier: input.securityTier,
  });
  const identifier = await verifyNamedKeriIdentifier(
    controller.client,
    input.issuerAlias,
    input.witnessPolicy,
  );
  if (
    sameAid(identifier.aid, controller.controllerAid) ||
    sameAid(identifier.aid, controller.agentAid)
  ) {
    throw new IdentityFailure({
      kind: 'identifier-conflict',
      alias: input.issuerAlias,
      reason: 'issuer AID aliases the controller or KERIA agent AID',
    });
  }

  const endRole = verifyAgentEndRole(
    await issuerAgentEndRoles(controller.client, identifier.aid),
    identifier.aid,
    controller.agentAid,
  );
  if (endRole === undefined) {
    throw new IdentityFailure({
      kind: 'end-role-conflict',
      reason: 'issuer has no KERIA agent end-role authorization',
    });
  }

  const oobi = await availableIssuerOobi(
    controller.client,
    input.issuerAlias,
    identifier.aid,
    controller.agentAid,
    input.oobiAvailabilityTimeoutMs,
  );
  await resolveIssuerOobi(controller.client, oobi, input.operationTimeoutMs);
  const registry = await verifyNamedCredentialRegistry(
    controller.client,
    input.issuerAlias,
    identifier.aid,
    input.registryName,
    input.registryPolicy,
  );

  return {
    client: controller.client,
    identity: {
      controllerAid: controller.controllerAid,
      agentAid: controller.agentAid,
      issuerAid: identifier.aid,
      registryId: registry.id,
      issuerOobi: oobi,
    },
  };
}

export async function verifyIssuerIdentity(
  input: IssuerIdentityVerificationInput,
): Promise<VerifiedIssuerIdentity> {
  return (await verifyIssuerConnection(input)).identity;
}

export async function connectVerifiedIssuerInfrastructure(
  input: IssuerIdentityVerificationInput,
  credentialPayloadSchema: CredentialPayloadSchema,
): Promise<VerifiedIssuerInfrastructure> {
  const verified = await verifyIssuerConnection(input);
  return {
    identity: verified.identity,
    challengeProof: signifyIssuerChallengeProof(verified.client, verified.identity.issuerAid),
    asynchronousChallengeProof: signifyAsynchronousIssuerChallengeProof(
      verified.client,
      verified.identity.issuerAid,
    ),
    userOobiResolution: signifyIssuerUserOobiResolution(verified.client, input.operationTimeoutMs),
    credentialDelivery: signifyDevrandomUserCredentialDelivery(
      verified.client,
      credentialPayloadSchema,
    ),
    currentUserCredentialVerification: signifyIssuerCurrentUserCredentialVerification(
      verified.client,
      {
        issuerAid: verified.identity.issuerAid,
        registryId: verified.identity.registryId,
        schemaId: credentialSchemaId(credentialPayloadSchema.$id),
        payloadSchema: credentialPayloadSchema,
      },
    ),
    credentialSchema: signifyCredentialSchemaAvailability(
      verified.client,
      credentialPayloadSchema,
      input.operationTimeoutMs,
    ),
    taskMandateSchemaAvailability: signifyCredentialSchemaAvailability(
      verified.client,
      taskMandateSchema,
      input.operationTimeoutMs,
    ),
    taskMandateV2SchemaAvailability: signifyCredentialSchemaAvailability(
      verified.client,
      taskMandateV2Schema,
      input.operationTimeoutMs,
    ),
    taskMandateV3SchemaAvailability: signifyCredentialSchemaAvailability(
      verified.client,
      taskMandateV3Schema,
      input.operationTimeoutMs,
    ),
    taskMandateV4SchemaAvailability: signifyCredentialSchemaAvailability(
      verified.client,
      taskMandateV4Schema,
      input.operationTimeoutMs,
    ),
    promotionMandateSchemaAvailability: signifyCredentialSchemaAvailability(
      verified.client,
      promotionMandateSchema,
      input.operationTimeoutMs,
    ),
    promotionMandateV2SchemaAvailability: signifyCredentialSchemaAvailability(
      verified.client,
      promotionMandateV2Schema,
      input.operationTimeoutMs,
    ),
    promotionMandateV3SchemaAvailability: signifyCredentialSchemaAvailability(
      verified.client,
      promotionMandateV3Schema,
      input.operationTimeoutMs,
    ),
    promotionMandateV4SchemaAvailability: signifyCredentialSchemaAvailability(
      verified.client,
      promotionMandateV4Schema,
      input.operationTimeoutMs,
    ),
    promotionMandateV6SchemaAvailability: signifyCredentialSchemaAvailability(
      verified.client,
      promotionMandateV6Schema,
      input.operationTimeoutMs,
    ),
    promotionMandateV5SchemaAvailability: signifyCredentialSchemaAvailability(
      verified.client,
      promotionMandateV5Schema,
      input.operationTimeoutMs,
    ),
    promotionMandateV7SchemaAvailability: signifyCredentialSchemaAvailability(
      verified.client,
      promotionMandateV7Schema,
      input.operationTimeoutMs,
    ),
    mandateAdmission: signifyMandateAdmission(
      verified.client,
      input.issuerAlias,
      verified.identity.issuerAid,
    ),
    runAdmissionExchange: signifyIssuerRunAdmissionExchange(
      verified.client,
      verified.identity.issuerAid,
    ),
    evidenceSealExchange: signifyIssuerEvidenceSealExchange(verified.client),
    evaluationClosureSealExchange: signifyIssuerEvaluationClosureSealExchange(verified.client),
    promotionExchanges: signifyIssuerPromotionExchanges(verified.client),
    publicationSignatures: signifyHarnessPublicationSignatures(verified.client),
    activationReceiptExchange: signifyIssuerActivationReceiptExchange(verified.client),
    readiness: signifyIssuerReadiness(verified.client, verified.identity.issuerAid),
  };
}
