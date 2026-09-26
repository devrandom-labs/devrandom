import type {
  AgentAid,
  ControllerAid,
  CredentialRegistryOutcome,
  EstablishedLocalPrincipals,
  LocalMandateCustody,
  LocalPrincipalEstablishment,
  UserAid,
  WitnessedUserPolicy,
} from '@devrandom/identity';
import { MANDATE_REGISTRY_NAME } from '@devrandom/identity';

import type { LocalGovernanceProfile } from '../domain/local-governance.js';

export interface LocalGovernanceProfiles {
  read(): Promise<LocalGovernanceProfile | undefined>;
  commit(previousRevision: number | undefined, profile: LocalGovernanceProfile): Promise<void>;
}

export interface CurrentLocalUser {
  readonly alias: string;
  readonly userAid: UserAid;
  readonly controllerAid: ControllerAid;
  readonly keriaAgentAid: AgentAid;
  readonly witnessPolicy: WitnessedUserPolicy;
}

export interface MandateRegistryCustody {
  readonly controllerAid: ControllerAid;
  readonly agentAid: AgentAid;
  provisionRegistry: LocalMandateCustody['provisionRegistry'];
}

export interface LocalGovernanceDependencies {
  readonly profiles: LocalGovernanceProfiles;
  readonly establishPrincipals: (
    input: LocalPrincipalEstablishment,
  ) => Promise<EstablishedLocalPrincipals>;
  readonly registry: MandateRegistryCustody;
  readonly operationTimeoutMs: number;
}

export type LocalGovernanceEstablishment =
  | {
      readonly kind: 'Ready';
      readonly recovery: 'GovernanceProvisioned' | 'ExistingGovernanceVerified';
      readonly profile: LocalGovernanceProfile;
      readonly principals: EstablishedLocalPrincipals;
    }
  | {
      readonly kind: 'RecoveryRejected';
      readonly reason: 'UserCustodyChanged' | 'ManagedPrincipalChanged' | 'MandateRegistryChanged';
    };

export class LocalGovernance {
  readonly #dependencies: LocalGovernanceDependencies;

  constructor(dependencies: LocalGovernanceDependencies) {
    this.#dependencies = dependencies;
  }

  async establish(user: CurrentLocalUser): Promise<LocalGovernanceEstablishment> {
    const existing = await this.#dependencies.profiles.read();
    if (existing !== undefined && !profileBelongsToUser(existing, user)) {
      return { kind: 'RecoveryRejected', reason: 'UserCustodyChanged' };
    }
    if (
      this.#dependencies.registry.controllerAid !== user.controllerAid ||
      this.#dependencies.registry.agentAid !== user.keriaAgentAid
    ) {
      return { kind: 'RecoveryRejected', reason: 'UserCustodyChanged' };
    }

    const principals = await this.#dependencies.establishPrincipals(
      existing === undefined
        ? {
            kind: 'provision-local-principals',
            expectedControllerAid: user.controllerAid,
            expectedAgentAid: user.keriaAgentAid,
            userAid: user.userAid,
            witnessPolicy: user.witnessPolicy,
          }
        : {
            kind: 'recover-local-principals',
            expectedControllerAid: user.controllerAid,
            expectedAgentAid: user.keriaAgentAid,
            expectedPersonalAgentAid: existing.personalAgentAid,
            expectedGovernorAid: existing.governorAid,
            userAid: user.userAid,
            witnessPolicy: user.witnessPolicy,
          },
    );
    if (!principalsMatch(principals, user, existing)) {
      return { kind: 'RecoveryRejected', reason: 'ManagedPrincipalChanged' };
    }

    const registry = await this.#dependencies.registry.provisionRegistry({
      userAlias: user.alias,
      userAid: user.userAid,
      policy: { kind: 'backerless' },
      operationTimeoutMs: this.#dependencies.operationTimeoutMs,
    });
    if (!registryMatchesUser(registry, user.userAid)) {
      return { kind: 'RecoveryRejected', reason: 'MandateRegistryChanged' };
    }
    if (existing !== undefined && registry.registry.id !== existing.mandateRegistryId) {
      return { kind: 'RecoveryRejected', reason: 'MandateRegistryChanged' };
    }

    const profile: LocalGovernanceProfile = existing ?? {
      version: 1,
      revision: 0,
      userAid: user.userAid,
      controllerAid: user.controllerAid,
      keriaAgentAid: user.keriaAgentAid,
      personalAgentAid: principals.personalAgent.identifier.aid,
      governorAid: principals.governor.identifier.aid,
      mandateRegistryId: registry.registry.id,
    };
    if (existing === undefined) {
      await this.#dependencies.profiles.commit(undefined, profile);
    }
    return {
      kind: 'Ready',
      recovery: existing === undefined ? 'GovernanceProvisioned' : 'ExistingGovernanceVerified',
      profile,
      principals,
    };
  }
}

function profileBelongsToUser(profile: LocalGovernanceProfile, user: CurrentLocalUser): boolean {
  return (
    profile.userAid === user.userAid &&
    profile.controllerAid === user.controllerAid &&
    profile.keriaAgentAid === user.keriaAgentAid
  );
}

function principalsMatch(
  principals: EstablishedLocalPrincipals,
  user: CurrentLocalUser,
  existing: LocalGovernanceProfile | undefined,
): boolean {
  if (
    principals.userAid !== user.userAid ||
    principals.controllerAid !== user.controllerAid ||
    principals.agentAid !== user.keriaAgentAid ||
    sameAid(principals.personalAgent.identifier.aid, principals.governor.identifier.aid) ||
    sameAid(principals.personalAgent.identifier.aid, user.userAid) ||
    sameAid(principals.governor.identifier.aid, user.userAid)
  ) {
    return false;
  }
  return (
    existing === undefined ||
    (principals.personalAgent.identifier.aid === existing.personalAgentAid &&
      principals.governor.identifier.aid === existing.governorAid)
  );
}

function sameAid(left: string, right: string): boolean {
  return left === right;
}

function registryMatchesUser(
  outcome: CredentialRegistryOutcome<UserAid>,
  expectedUserAid: UserAid,
): boolean {
  return (
    outcome.registry.name === MANDATE_REGISTRY_NAME &&
    outcome.registry.issuerAid === expectedUserAid
  );
}
