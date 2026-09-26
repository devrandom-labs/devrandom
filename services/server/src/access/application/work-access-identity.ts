import type { CredentialCapability } from '@devrandom/protocol';

import type { WorkAccessDependency } from './work-access-dependency.js';

export type CurrentWorkAccessCredential =
  | {
      readonly kind: 'CurrentCredential';
      readonly claims: readonly CredentialCapability[];
    }
  | { readonly kind: 'CredentialRejected' }
  | { readonly kind: 'CredentialUnavailable'; readonly dependency: WorkAccessDependency };

export interface WorkAccessCredentialVerification {
  verify(input: {
    readonly userAid: string;
    readonly credentialSaid: string;
  }): Promise<CurrentWorkAccessCredential>;
}
