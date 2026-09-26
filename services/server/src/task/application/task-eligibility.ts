export type TaskCreationEligibility =
  | { readonly kind: 'Eligible' }
  | { readonly kind: 'EligibilityMissing' }
  | { readonly kind: 'CredentialNotCurrent' }
  | {
      readonly kind: 'DependencyUnavailable';
      readonly dependency: 'Keria' | 'Witness';
    };

export interface CurrentTaskCreationEligibility {
  authorize(input: {
    readonly ownerAid: string;
    readonly credentialSaid: string;
  }): Promise<TaskCreationEligibility>;
}
