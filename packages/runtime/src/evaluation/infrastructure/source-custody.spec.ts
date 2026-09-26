import { chmod, mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepareEvidenceArtifact } from '@devrandom/protocol';

import { SourceCustody } from './source-custody.js';

describe('stopped-writer source capture', () => {
  it('captures exact bytes and rejects a later custody substitution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devrandom-capture-'));
    const source = join(root, 'source');
    await mkdir(join(source, 'src'), { recursive: true });
    await writeFile(join(source, 'src', 'lib.rs'), 'pub fn answer() -> u8 { 7 }\n');
    const custody = new SourceCustody(join(root, 'custody'), {
      maximumFiles: 8,
      maximumBytes: 1024,
      maximumPathBytes: 128,
    });
    const captured = await custody.capture(source, () => Promise.resolve(false));
    expect(captured.kind).toBe('Captured');
    if (captured.kind !== 'Captured') return;
    await expect(custody.capture(source, () => Promise.resolve(false))).resolves.toMatchObject({
      kind: 'Captured',
      sourceSaid: captured.sourceSaid,
    });
    const opened = await custody.open(captured.sourceSaid);
    const manifest = prepareEvidenceArtifact(
      opened?.manifestBytes ?? new Uint8Array(),
      'application/json',
    );
    expect(manifest).toMatchObject({ kind: 'Prepared', artifact: { d: captured.sourceSaid } });
    expect(
      opened?.files.map((file) => ({ path: file.path, bytes: Buffer.from(file.bytes).toString() })),
    ).toEqual([{ path: 'src/lib.rs', bytes: 'pub fn answer() -> u8 { 7 }\n' }]);
    await chmod(join(captured.path, 'src', 'lib.rs'), 0o600);
    await writeFile(join(captured.path, 'src', 'lib.rs'), 'pub fn answer() -> u8 { 8 }\n');
    await expect(custody.open(captured.sourceSaid)).resolves.toBeUndefined();
  });

  it('rejects links and a surviving writer before custody', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devrandom-capture-'));
    const source = join(root, 'source');
    await mkdir(source);
    await writeFile(join(root, 'canary'), 'protected');
    await symlink(join(root, 'canary'), join(source, 'answer'));
    const custody = new SourceCustody(join(root, 'custody'), {
      maximumFiles: 8,
      maximumBytes: 1024,
      maximumPathBytes: 128,
    });
    await expect(custody.capture(source, () => Promise.resolve(false))).resolves.toMatchObject({
      kind: 'Rejected',
      reason: 'UnsafeSource',
    });
    await expect(custody.capture(source, () => Promise.resolve(true))).resolves.toMatchObject({
      kind: 'Rejected',
      reason: 'WriterSurvived',
    });
    expect(await readFile(join(root, 'canary'), 'utf8')).toBe('protected');
  });
});
