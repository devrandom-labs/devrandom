import { mkdtemp, rm, chmod, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunContinuationFile } from './run-continuation-file.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
const runId = '10000000-0000-4000-8000-000000000001';
const checkpoint = 'E' + 'a'.repeat(43);
const command = {
  version: 1 as const,
  expectedRunVersion: 3,
  predecessorCheckpointSaid: checkpoint,
  predecessorSealSaid: 'E' + 'b'.repeat(43),
  predecessorHeadSaid: 'E' + 'c'.repeat(43),
  expectedActivePointerVersion: 2,
  expectedActivationReceiptSaid: 'E' + 'd'.repeat(43),
};
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'run-continuation-'));
  directories.push(root);
  await chmod(root, 0o700);
  return await realpath(root);
}
describe('durable same-Run continuation identity', () => {
  it('reuses both replacement identifiers after process restart and rejects a changed checkpoint command', async () => {
    const root = await directory();
    let ordinal = 1;
    const first = new RunContinuationFile(
      root,
      () => `20000000-0000-4000-8000-${String(ordinal++).padStart(12, '0')}`,
    );
    const admitted = await first.acquire({ runId, command });
    expect(admitted.kind).toBe('Recorded');
    const restarted = new RunContinuationFile(root, () => {
      throw new Error('must reuse durable identities');
    });
    expect(await restarted.acquire({ runId, command })).toEqual(admitted);
    expect(
      await restarted.acquire({ runId, command: { ...command, expectedRunVersion: 4 } }),
    ).toEqual({ kind: 'Rejected' });
    const stored = JSON.parse(
      await readFile(join(root, `${runId}-${checkpoint}.json`), 'utf8'),
    ) as { successorStreamId: string; successorIncarnationId: string };
    expect(stored.successorStreamId).not.toBe(stored.successorIncarnationId);
  });
  it('does not trust world-readable command custody', async () => {
    const root = await directory();
    let ordinal = 1;
    const files = new RunContinuationFile(
      root,
      () => `20000000-0000-4000-8000-${String(ordinal++).padStart(12, '0')}`,
    );
    expect((await files.acquire({ runId, command })).kind).toBe('Recorded');
    await chmod(join(root, `${runId}-${checkpoint}.json`), 0o644);
    expect(await files.acquire({ runId, command })).toEqual({ kind: 'Unavailable' });
  });
});
