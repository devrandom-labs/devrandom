import type { EvidenceEvent, VerifiedCheckpoint } from '@devrandom/protocol';
import { describe, expect, it } from 'vitest';

import { privacyCheckpointMarkersMatch } from './run-binding.js';

const said = (character: string) => `E${character.repeat(43)}`;

describe('privacy-withheld checkpoint binding', () => {
  it('requires the exact adjacent final marker pair and matching disclosure', () => {
    const checkpoint = {
      version: 2,
      evidence: { eventCount: 4, finalSequence: 3, chainHeadSaid: said('z') },
      repository: {
        repositoryMeasurement: {
          kind: 'UnavailableBecauseSecret',
          disclosure: { kind: 'WithheldSecret', reason: 'Credential', byteLength: 43 },
          dataWithheldEventSaid: said('w'),
          securityViolationEventSaid: said('z'),
        },
      },
      runId: '1cc482f1-98e9-4454-8e4c-5566cb47ce3d',
      incarnationId: 'ee87e11d-fb5f-46b4-841f-8a7a5faad97c',
    } as Extract<VerifiedCheckpoint, { readonly version: 2 }>;
    const withheld = {
      sequence: 2,
      d: said('w'),
      predecessor: { kind: 'Previous', eventSaid: said('p') },
      runId: checkpoint.runId,
      incarnationId: checkpoint.incarnationId,
      occurredAt: '2026-09-24T20:00:04.000Z',
      producer: { kind: 'EvidenceRecorder' },
      event: {
        kind: 'DataWithheld',
        disposition: checkpoint.repository.repositoryMeasurement.disclosure,
      },
    } as EvidenceEvent;
    const violation = {
      ...withheld,
      sequence: 3,
      d: said('z'),
      predecessor: { kind: 'Previous', eventSaid: said('w') },
      event: { kind: 'SecurityViolation', violation: 'SecretDetected' },
    } as EvidenceEvent;
    expect(privacyCheckpointMarkersMatch(checkpoint, [withheld, violation])).toBe(true);
    expect(privacyCheckpointMarkersMatch(checkpoint, [violation, withheld])).toBe(false);
    expect(
      privacyCheckpointMarkersMatch(checkpoint, [withheld, { ...violation, sequence: 4 }]),
    ).toBe(false);
    expect(
      privacyCheckpointMarkersMatch(checkpoint, [
        {
          ...withheld,
          event: {
            kind: 'DataWithheld',
            disposition: { kind: 'WithheldSecret', reason: 'Credential', byteLength: 44 },
          },
        },
        violation,
      ]),
    ).toBe(false);
  });
});
