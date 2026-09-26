import type {
  AgentAid,
  ControllerAid,
  CredentialRegistryId,
  GovernorAid,
  PersonalAgentAid,
  UserAid,
} from '@devrandom/identity';

export interface LocalGovernanceProfile {
  readonly version: 1;
  readonly revision: number;
  readonly userAid: UserAid;
  readonly controllerAid: ControllerAid;
  readonly keriaAgentAid: AgentAid;
  readonly personalAgentAid: PersonalAgentAid;
  readonly governorAid: GovernorAid;
  readonly mandateRegistryId: CredentialRegistryId;
}
