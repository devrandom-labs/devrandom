import type { MandatePresentation } from '../domain/presentation.js';

export interface StoredMandatePresentation {
  readonly revision: number;
  readonly presentation: MandatePresentation;
}

export type MandatePresentationReconciliation =
  | { readonly kind: 'NoPresentation' }
  | { readonly kind: 'ExistingPresentation'; readonly stored: StoredMandatePresentation }
  | { readonly kind: 'PresentationConflict' }
  | { readonly kind: 'DependencyUnavailable'; readonly dependency: 'HostedMongoDB' };

export type MandatePresentationCreation =
  | { readonly kind: 'PresentationCreated'; readonly stored: StoredMandatePresentation }
  | { readonly kind: 'ExistingPresentation'; readonly stored: StoredMandatePresentation }
  | { readonly kind: 'PresentationConflict' }
  | { readonly kind: 'DependencyUnavailable'; readonly dependency: 'HostedMongoDB' };

export type MandatePresentationCommit =
  | { readonly kind: 'PresentationCommitted'; readonly stored: StoredMandatePresentation }
  | { readonly kind: 'PresentationConcurrentlyModified' }
  | { readonly kind: 'DependencyUnavailable'; readonly dependency: 'HostedMongoDB' };

export type AdmittedTaskMandatePresentations =
  | {
      readonly kind: 'AdmittedTaskMandatesFound';
      readonly presentations: readonly StoredMandatePresentation[];
    }
  | { readonly kind: 'NoAdmittedTaskMandate' }
  | { readonly kind: 'DependencyUnavailable'; readonly dependency: 'HostedMongoDB' };

export type MandatePresentationInspection =
  | { readonly kind: 'PresentationFound'; readonly stored: StoredMandatePresentation }
  | { readonly kind: 'PresentationNotFound' }
  | { readonly kind: 'DependencyUnavailable'; readonly dependency: 'HostedMongoDB' };

export interface MandatePresentations {
  reconcile(
    ownerAid: string,
    credentialSaid: string,
    grantSaid: string,
  ): Promise<MandatePresentationReconciliation>;
  create(presentation: MandatePresentation): Promise<MandatePresentationCreation>;
  findAdmittedTaskMandates(
    ownerAid: string,
    taskId: string,
    taskRevisionSaid: string,
  ): Promise<AdmittedTaskMandatePresentations>;
  findByCredential(
    ownerAid: string,
    credentialSaid: string,
  ): Promise<MandatePresentationInspection>;
  commit(
    current: StoredMandatePresentation,
    presentation: MandatePresentation,
  ): Promise<MandatePresentationCommit>;
}
