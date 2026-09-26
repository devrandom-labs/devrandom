import { prepareEvidenceArtifact } from '@devrandom/protocol';
import { expect, it } from 'vitest';

import {
  decodeParentAuditOperation,
  prepareParentAuditOperation,
} from './parent-audit-operation.js';

const said = (letter: string) => `E${letter.repeat(43)}`;
const input = {
  evaluationId: '11111111-1111-4111-8111-111111111111',
  manifestSaid: said('m'),
  scope: 'H1TaskSearch',
  opened: { sequence: 3, headSaid: said('a') },
  closed: { sequence: 8, headSaid: said('b') },
  operation: {
    kind: 'PublicSearchSelection',
    repetition: 1,
    firstArtifactSaid: said('c'),
    secondArtifactSaid: said('d'),
    selectedArtifactSaid: said('c'),
  },
};

it('records bounded immutable selection inputs without accepting a caller audit verdict', () => {
  const prepared = prepareParentAuditOperation(input);
  expect(prepared.kind).toBe('Prepared');
  if (prepared.kind !== 'Prepared') throw new Error('audit capture missing');
  expect(prepared.receipt.role).toBe('Selection');
  expect(decodeParentAuditOperation(prepared.artifact, prepared.bytes)).toMatchObject({
    kind: 'Accepted',
  });
  expect(prepareParentAuditOperation({ ...input, finding: 'Pass' })).toEqual({ kind: 'Rejected' });
  expect(
    prepareParentAuditOperation({
      ...input,
      operation: { ...input.operation, selectedArtifactSaid: said('x') },
    }),
  ).toEqual({ kind: 'Rejected' });
});

it('rejects backward windows, same-position changed heads, and forged role bytes', () => {
  expect(
    prepareParentAuditOperation({ ...input, closed: { sequence: 2, headSaid: said('b') } }),
  ).toEqual({ kind: 'Rejected' });
  expect(
    prepareParentAuditOperation({ ...input, closed: { sequence: 3, headSaid: said('b') } }),
  ).toEqual({ kind: 'Rejected' });
  const prepared = prepareParentAuditOperation(input);
  if (prepared.kind !== 'Prepared') throw new Error('audit capture missing');
  const bytes = Buffer.from(JSON.stringify({ ...prepared.receipt, role: 'Execution' }));
  const artifact = prepareEvidenceArtifact(bytes, 'application/json');
  if (artifact.kind !== 'Prepared') throw new Error('artifact fixture invalid');
  expect(decodeParentAuditOperation(artifact.artifact, bytes)).toEqual({ kind: 'Rejected' });
});
