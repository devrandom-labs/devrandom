import type { MandatePresentationProjection } from '@devrandom/protocol';

import type { MandatePresentation } from '../domain/presentation.js';

export function projectMandatePresentation(
  presentation: MandatePresentation,
): MandatePresentationProjection {
  const binding = {
    version: 1 as const,
    mandateKind: presentation.binding.mandateKind,
    credentialSaid: presentation.binding.credentialSaid,
    grantSaid: presentation.binding.grantSaid,
    presentationExpiresAt: presentation.binding.expiresAt,
  };
  switch (presentation.state.kind) {
    case 'AwaitingGrant':
      return { ...binding, kind: 'AwaitingGrant' };
    case 'Admitting':
      return {
        ...binding,
        kind: 'Admitting',
        operationName: presentation.state.operationName,
      };
    case 'Admitted':
      return { ...binding, kind: 'Admitted', admittedAt: presentation.state.admittedAt };
    case 'Rejected':
      return { ...binding, kind: 'Rejected', reason: presentation.state.reason };
    case 'Expired':
      return { ...binding, kind: 'Expired' };
  }
}
