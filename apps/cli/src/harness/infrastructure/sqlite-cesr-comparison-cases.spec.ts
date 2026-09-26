import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { SqliteCesrComparisonCases } from './sqlite-cesr-comparison-cases.js';

const said = (letter: string): string => `E${letter.repeat(43)}`;
const binding = {
  ownerAid: said('o'),
  evaluationId: '11111111-1111-4111-8111-111111111111',
  personalAgentAid: said('a'),
  taskId: '22222222-2222-4222-8222-222222222222',
  taskMandateSaid: said('m'),
};

it('reopens the same protected ciphertext under the exact private Evaluation binding', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devrandom-cesr-m-key-'));
  try {
    const cases = new SqliteCesrComparisonCases(root);
    const created = await cases.open({ ...binding, mode: 'Create' });
    expect(created.kind).toBe('Opened');
    if (created.kind !== 'Opened') return;
    const sealed = await created.custody.seal({
      evaluationId: binding.evaluationId,
      objectSaid: said('x'),
      purpose: 'TrialHoldout',
      segment: 0,
      plaintext: new TextEncoder().encode('parent-only trial'),
    });
    expect(sealed.kind).toBe('Sealed');
    created.release();
    expect(await cases.open({ ...binding, mode: 'Create' })).toEqual({ kind: 'Conflict' });
    expect(await cases.open({ ...binding, ownerAid: said('z'), mode: 'Reopen' })).toEqual({
      kind: 'Conflict',
    });
    const reopened = await cases.open({ ...binding, mode: 'Reopen' });
    expect(reopened.kind).toBe('Opened');
    if (reopened.kind !== 'Opened' || sealed.kind !== 'Sealed') return;
    expect(
      await reopened.custody.open({
        artifact: sealed.artifact,
        evaluationId: binding.evaluationId,
        objectSaid: said('x'),
        purpose: 'TrialHoldout',
        segment: 0,
      }),
    ).toMatchObject({ kind: 'Opened' });
    reopened.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
