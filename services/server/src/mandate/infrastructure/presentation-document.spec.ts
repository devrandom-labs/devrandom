import { describe, expect, it } from 'vitest';

import {
  decodeMandatePresentationDocument,
  encodeMandatePresentationDocument,
} from './presentation-document.js';
import type { StoredMandatePresentation } from '../application/presentations.js';

const credentialSaid = `E${'c'.repeat(43)}`;
const pending: StoredMandatePresentation = {
  revision: 1,
  presentation: {
    version: 1,
    binding: {
      ownerAid: `E${'a'.repeat(43)}`,
      userCredentialSaid: `E${'b'.repeat(43)}`,
      mandateKind: 'TaskMandate',
      credentialSaid,
      grantSaid: `E${'d'.repeat(43)}`,
      requestedAt: '2026-09-24T12:00:00.000Z',
      expiresAt: '2026-09-24T12:30:00.000Z',
    },
    acceptedReference: null,
    state: { kind: 'Admitting', operationName: 'operation.123' },
  },
};

describe('Mandate Presentation Mongo document', () => {
  it('round-trips the exact pending binding with a bounded cleanup deadline', () => {
    const document = encodeMandatePresentationDocument(pending);

    expect(document).toMatchObject({
      _id: credentialSaid,
      ownerAid: pending.presentation.binding.ownerAid,
      mandateKind: 'TaskMandate',
      credentialSaid,
      requestedAt: new Date('2026-09-24T12:00:00.000Z'),
      expiresAt: new Date('2026-09-24T12:30:00.000Z'),
      cleanupAt: new Date('2026-09-24T12:30:00.000Z'),
      state: { kind: 'Admitting', operationName: 'operation.123' },
    });
    expect(decodeMandatePresentationDocument(document)).toEqual(pending);
  });

  it('retains an admitted presentation without a pending-record TTL value', () => {
    const admitted: StoredMandatePresentation = {
      revision: 2,
      presentation: {
        ...pending.presentation,
        acceptedReference: {
          issueeAid: `E${'e'.repeat(43)}`,
          registryId: `E${'f'.repeat(43)}`,
          taskId: '4df838a8-5109-49fd-bdad-805880a3ecee',
          taskRevisionSaid: `E${'g'.repeat(43)}`,
        },
        state: {
          kind: 'Admitted',
          credentialSaid,
          admittedAt: '2026-09-24T12:02:00.000Z',
        },
      },
    };

    const document = encodeMandatePresentationDocument(admitted);

    expect('cleanupAt' in document).toBe(false);
    expect(decodeMandatePresentationDocument(document)).toEqual(admitted);
  });

  it('rejects stored identity, state, and TTL drift', () => {
    const document = encodeMandatePresentationDocument(pending);
    const withoutCleanup = { ...document, cleanupAt: undefined };

    expect(() =>
      decodeMandatePresentationDocument({ ...document, _id: `E${'e'.repeat(43)}` }),
    ).toThrow('MandatePresentationDocumentInvalid');
    expect(() => decodeMandatePresentationDocument(withoutCleanup)).toThrow(
      'MandatePresentationDocumentInvalid',
    );
    expect(() =>
      decodeMandatePresentationDocument({
        ...document,
        state: {
          kind: 'Admitted',
          credentialSaid: `E${'e'.repeat(43)}`,
          admittedAt: '2026-09-24T12:02:00.000Z',
        },
      }),
    ).toThrow('MandatePresentationDocumentInvalid');
  });
});
