export type MandateUserCredentialDisposition =
  | { readonly kind: 'UserCredentialCurrent' }
  | { readonly kind: 'UserCredentialNotCurrent' }
  | { readonly kind: 'DependencyUnavailable'; readonly dependency: 'Keria' | 'Witness' };

export interface CurrentMandateUserCredential {
  verify(input: {
    readonly ownerAid: string;
    readonly credentialSaid: string;
  }): Promise<MandateUserCredentialDisposition>;
}
