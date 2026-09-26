export type WorkAccessAttemptQuotaDisposition =
  { readonly kind: 'AttemptQuotaAdmitted' } | { readonly kind: 'AttemptRateExceeded' };

export interface WorkAccessAttemptQuota {
  admit(sourceAddress: string): WorkAccessAttemptQuotaDisposition;
}
