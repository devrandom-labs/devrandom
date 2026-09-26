import { describe, expect, it } from 'vitest';

import { prepareEvidenceArtifact } from '../evidence/evidence-artifact.js';
import {
  decodeQualifiedFailureWindow,
  prepareQualifiedFailureWindow,
} from './qualified-failure-window.js';

const said = (letter: string): string => `E${letter.repeat(43)}`;
const taskId = '11111111-1111-4111-8111-111111111111';
const runId = '22222222-2222-4222-8222-222222222222';
const input = () => ({
  version: 1,
  kind: 'QualifiedFailureWindow',
  taskId,
  taskRevisionSaid: said('t'),
  originRunId: runId,
  retainedCheckpointSaid: said('c'),
  retainedSealSaid: said('s'),
  failureEventSaid: said('f'),
  verifierReceiptSaid: said('r'),
  precedingEventSaids: [said('a'), said('b')],
});

describe('qualified public failure window', () => {
  it('returns and verifies exact canonical 32 KiB bounded artifact bytes', () => {
    const prepared = prepareQualifiedFailureWindow(input());
    expect(prepared.kind).toBe('Prepared');
    if (prepared.kind !== 'Prepared') return;
    expect(prepared.artifact.mediaType).toBe('application/json');
    expect(decodeQualifiedFailureWindow(prepared.artifact, prepared.bytes)).toEqual({
      kind: 'Accepted',
      window: prepared.window,
      artifact: prepared.artifact,
      bytes: prepared.bytes,
    });
    const noncanonical = new TextEncoder().encode(` ${new TextDecoder().decode(prepared.bytes)}`);
    const artifact = prepareEvidenceArtifact(noncanonical, 'application/json');
    expect(artifact.kind).toBe('Prepared');
    if (artifact.kind === 'Prepared')
      expect(decodeQualifiedFailureWindow(artifact.artifact, noncanonical)).toEqual({
        kind: 'Rejected',
        reason: 'NoncanonicalBytes',
      });
  });

  it('rejects duplicate/gapped references and changed signed identity', () => {
    expect(
      prepareQualifiedFailureWindow({ ...input(), precedingEventSaids: [said('a'), said('a')] }),
    ).toMatchObject({ kind: 'Rejected' });
    expect(
      prepareQualifiedFailureWindow({ ...input(), precedingEventSaids: [said('f')] }),
    ).toMatchObject({ kind: 'Rejected' });
    const original = prepareQualifiedFailureWindow(input());
    const changed = prepareQualifiedFailureWindow({ ...input(), verifierReceiptSaid: said('z') });
    expect(original.kind).toBe('Prepared');
    expect(changed.kind).toBe('Prepared');
    if (original.kind !== 'Prepared' || changed.kind !== 'Prepared') return;
    expect(original.artifact.d).not.toBe(changed.artifact.d);
    expect(decodeQualifiedFailureWindow(original.artifact, changed.bytes)).toEqual({
      kind: 'Rejected',
      reason: 'ArtifactInvalid',
    });
  });

  it('rejects a prefix whose canonical artifact exceeds 32 KiB', () => {
    const precedingEventSaids = Array.from(
      { length: 700 },
      (_, position) => `E${String(position).padStart(43, '0')}`,
    );
    expect(prepareQualifiedFailureWindow({ ...input(), precedingEventSaids })).toEqual({
      kind: 'Rejected',
      reason: 'ArtifactTooLarge',
    });
  });
});
