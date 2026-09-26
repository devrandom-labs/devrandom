import { describe, expect, it } from 'vitest';

import { runCommandFingerprint, runCommandId, runId, runOwnerAid } from '../test/run-fixture.js';
import {
  decodeRunAdmissionDocument,
  encodeAwaitingRunAdmission,
  encodeCompletedRunAdmission,
} from './run-admission-document.js';

const exchangeSaid = `E${'i'.repeat(43)}`;
const reservedAt = '2026-09-24T19:59:00.000Z';

describe('Run admission reservation Mongo document', () => {
  it('preserves pending command idempotency without claiming a Run exists', () => {
    const document = encodeAwaitingRunAdmission({
      ownerAid: runOwnerAid,
      commandId: runCommandId,
      commandFingerprint: runCommandFingerprint,
      admissionExchangeSaid: exchangeSaid,
      reservedAt,
    });

    expect(decodeRunAdmissionDocument(document)).toEqual({
      ownerAid: runOwnerAid,
      commandId: runCommandId,
      commandFingerprint: runCommandFingerprint,
      admissionExchangeSaid: exchangeSaid,
      reservedAt,
      state: { kind: 'AwaitingExchange' },
    });
  });

  it('binds acceptance only to the committed Run and original reservation', () => {
    const awaiting = encodeAwaitingRunAdmission({
      ownerAid: runOwnerAid,
      commandId: runCommandId,
      commandFingerprint: runCommandFingerprint,
      admissionExchangeSaid: exchangeSaid,
      reservedAt,
    });
    const accepted = encodeCompletedRunAdmission(awaiting, {
      runId,
      acceptedAt: '2026-09-24T20:00:00.000Z',
    });

    expect(decodeRunAdmissionDocument(accepted).state).toEqual({
      kind: 'Accepted',
      runId,
      acceptedAt: '2026-09-24T20:00:00.000Z',
    });
  });
});
