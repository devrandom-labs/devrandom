import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { EvaluationCommandFile } from './evaluation-command-file.js';

const taskId = 'bbb13317-1c5e-4472-842e-692da01386cf';
const originRunId = '91d7f67f-d2f9-4fae-87cc-ac827de6f0d1';
const policySaid = `E${'a'.repeat(43)}`;
const evaluationId = '81d7f67f-d2f9-4fae-87cc-ac827de6f0d1';

it('persists one exact command before admission, reconciles it, and never changes its fingerprint', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'devrandom-evaluation-command-'));
  try {
    const commands = new EvaluationCommandFile(
      join(directory, 'state'),
      () => 'da189a7b-a853-4d02-bfd8-e91b595ed359',
    );
    const input = { taskId, originRunId, policySaid };
    const first = await commands.acquire(input);
    expect(first).toMatchObject({
      kind: 'Recorded',
      commandId: 'da189a7b-a853-4d02-bfd8-e91b595ed359',
    });
    if (first.kind !== 'Recorded') throw new Error('command rejected');
    expect(first.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    const stored = JSON.parse(
      await readFile(join(directory, 'state', `${taskId}.${originRunId}.json`), 'utf8'),
    ) as { commandId: string; fingerprint: string };
    expect(stored).toMatchObject({ commandId: first.commandId, fingerprint: first.fingerprint });
    expect(await commands.acquire(input)).toEqual(first);
    expect(await commands.acquire({ ...input, policySaid: `E${'b'.repeat(43)}` })).toEqual({
      kind: 'Conflict',
    });
    expect(await commands.recordAdmission(input, first.commandId, evaluationId)).toEqual({
      kind: 'Recorded',
    });
    expect(await commands.acquire(input)).toMatchObject({
      kind: 'Recorded',
      admittedEvaluationId: evaluationId,
    });
    expect(await commands.recordAdmission(input, first.commandId, evaluationId)).toEqual({
      kind: 'Recorded',
    });
    expect(
      await commands.recordAdmission(
        input,
        first.commandId,
        '71d7f67f-d2f9-4fae-87cc-ac827de6f0d1',
      ),
    ).toEqual({ kind: 'Conflict' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
