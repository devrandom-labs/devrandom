import { mandatePresentationProjectionSchema } from '@devrandom/protocol';
import { Value } from 'typebox/value';
import { describe, expect, it } from 'vitest';

import { projectMandatePresentation } from './presentation-projection.js';
import type { MandatePresentation, MandatePresentationState } from '../domain/presentation.js';

const states: readonly MandatePresentationState[] = [
  { kind: 'AwaitingGrant' },
  { kind: 'Admitting', operationName: 'operation.123' },
  {
    kind: 'Admitted',
    credentialSaid: `E${'c'.repeat(43)}`,
    admittedAt: '2026-09-24T12:02:00.000Z',
  },
  { kind: 'Rejected', reason: 'CredentialBindingInvalid' },
  { kind: 'Expired' },
];

describe('Mandate Presentation projection', () => {
  it.each(states)('projects $kind without owner or user credential authority facts', (state) => {
    const presentation: MandatePresentation = {
      version: 1,
      binding: {
        ownerAid: `E${'a'.repeat(43)}`,
        userCredentialSaid: `E${'b'.repeat(43)}`,
        mandateKind: 'TaskMandate',
        credentialSaid: `E${'c'.repeat(43)}`,
        grantSaid: `E${'d'.repeat(43)}`,
        requestedAt: '2026-09-24T12:00:00.000Z',
        expiresAt: '2026-09-24T12:30:00.000Z',
      },
      acceptedReference:
        state.kind === 'Admitted'
          ? {
              issueeAid: `E${'e'.repeat(43)}`,
              registryId: `E${'f'.repeat(43)}`,
              taskId: '4df838a8-5109-49fd-bdad-805880a3ecee',
              taskRevisionSaid: `E${'g'.repeat(43)}`,
            }
          : null,
      state,
    };

    const projection = projectMandatePresentation(presentation);

    expect(Value.Check(mandatePresentationProjectionSchema, projection)).toBe(true);
    expect('ownerAid' in projection).toBe(false);
    expect('userCredentialSaid' in projection).toBe(false);
  });
});
