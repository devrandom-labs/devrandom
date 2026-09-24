import type {
  CredentialRegistryId,
  CredentialSchemaId,
  IssuerAid,
  IssuerOobi,
  WitnessAid,
} from '@devrandom/identity';

export interface UserIdentityConfiguration {
  readonly stateDirectory: string;
  readonly keriaAdminUrl: string;
  readonly keriaBootUrl: string;
  readonly issuerUrl: string;
  readonly registrationSiteUrl: string;
  readonly issuerAid: IssuerAid;
  readonly issuerOobi: IssuerOobi;
  readonly registryId: CredentialRegistryId;
  readonly schemaId: CredentialSchemaId;
  readonly schemaOobi: string;
  readonly witnessAid: WitnessAid;
  readonly witnessOobi: string;
  readonly operationTimeoutMs: number;
  readonly registrationTimeoutMs: number;
}

export const devrandomUserAlias = 'devrandom-user' as const;
