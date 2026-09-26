import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { prepareEvidenceArtifact } from '@devrandom/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EvidenceRecorderProcessOutput } from './process-output-evidence.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('process output evidence', () => {
  it.each([
    'Text',
    'BothLong',
    'UnicodeBoundary',
    'NonUtf8',
    'Withheld',
    'StderrWithheld',
  ] as const)(
    'returns bounded, attributable feedback only after safe %s artifacts are admitted',
    async (content) => {
      const root = await mkdtemp(join(tmpdir(), 'devrandom-output-feedback-'));
      roots.push(root);
      const stdout =
        content === 'BothLong'
          ? Buffer.from('a'.repeat(8_192))
          : content === 'UnicodeBoundary'
            ? Buffer.from('a'.repeat(4_095) + '😀' + 'omitted-tail')
            : content === 'NonUtf8'
              ? Buffer.from([255, 0, 1])
              : Buffer.from('expected 3, received 4\n');
      const stderr = Buffer.from(
        content === 'BothLong'
          ? 'test assertion failed\n'.repeat(1_024)
          : 'test assertion failed\n',
      );
      const stdoutPath = join(root, 'stdout');
      const stderrPath = join(root, 'stderr');
      await Promise.all([writeFile(stdoutPath, stdout), writeFile(stderrPath, stderr)]);
      const captured: Uint8Array[] = [];
      const acknowledge = vi.fn(() => Promise.resolve({ kind: 'Cleaned' as const }));
      const recorder = new EvidenceRecorderProcessOutput(
        {
          withhold: vi.fn(),
          storeArtifact(input) {
            if (content === 'Withheld' || (content === 'StderrWithheld' && captured.length === 1))
              return { kind: 'SecretDetected' };
            const prepared = prepareEvidenceArtifact(input.bytes, input.mediaType);
            if (prepared.kind !== 'Prepared') return { kind: 'ArtifactRejected' };
            captured.push(input.bytes);
            return { kind: 'Stored', artifact: prepared.artifact };
          },
        },
        () => '2026-09-24T20:00:03.000Z',
      );
      const outcome = await recorder.record({
        disclosure: { kind: 'Recordable' },
        stdout: { path: stdoutPath, byteLength: stdout.byteLength },
        stderr: { path: stderrPath, byteLength: stderr.byteLength },
        acknowledge,
      });
      if (content === 'Withheld' || content === 'StderrWithheld') {
        expect(outcome).toEqual({ kind: 'SecretDetected' });
        expect(acknowledge).not.toHaveBeenCalled();
        return;
      }
      expect(outcome.kind).toBe('Recorded');
      if (outcome.kind !== 'Recorded') throw new Error('safe output must be recorded');
      const feedback = outcome.feedback;
      expect(feedback).toContain(`stdout [${outcome.stdoutArtifactSaid}]`);
      expect(feedback).toContain(`stderr [${outcome.stderrArtifactSaid}]`);
      expect(feedback).toContain('test assertion failed');
      expect(Buffer.byteLength(feedback)).toBeLessThan(9 * 1_024);
      if (content === 'Text') expect(feedback).toContain('expected 3, received 4');
      else if (content === 'NonUtf8') expect(feedback).toContain('non-UTF-8 output');
      else {
        expect(feedback).toContain('a'.repeat(4_095));
        expect(feedback).toContain('truncated');
        expect(feedback).not.toContain('omitted-tail');
        expect(feedback).not.toContain('�');
      }
      expect(captured).toEqual([stdout, stderr]);
      expect(acknowledge).toHaveBeenCalledOnce();
    },
  );

  it('rejects captures exceeding the combined command limit before storing either artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devrandom-output-evidence-'));
    roots.push(root);
    const stdout = join(root, 'stdout');
    const stderr = join(root, 'stderr');
    const bytes = Buffer.alloc(300 * 1_024, 'a');
    await Promise.all([writeFile(stdout, bytes), writeFile(stderr, bytes)]);
    const acknowledge = vi.fn(() => Promise.resolve({ kind: 'Cleaned' as const }));
    const storeArtifact = vi.fn(() => ({ kind: 'Unavailable' as const }));
    const recorder = new EvidenceRecorderProcessOutput(
      { storeArtifact, withhold: vi.fn() },
      () => '2026-09-24T20:00:03.000Z',
    );

    await expect(
      recorder.record({
        disclosure: { kind: 'Recordable' as const },
        stdout: { path: stdout, byteLength: bytes.byteLength },
        stderr: { path: stderr, byteLength: bytes.byteLength },
        acknowledge,
      }),
    ).resolves.toEqual({ kind: 'EvidenceIntegrityFailure' });
    expect(storeArtifact).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it('acknowledges output custody only after both artifacts are durably stored', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devrandom-output-evidence-'));
    roots.push(root);
    const stdout = join(root, 'stdout');
    const stderr = join(root, 'stderr');
    await Promise.all([writeFile(stdout, 'ok\n'), writeFile(stderr, 'warning\n')]);
    const acknowledge = vi.fn(() => Promise.resolve({ kind: 'Cleaned' as const }));
    const output = {
      disclosure: { kind: 'Recordable' as const },
      stdout: { path: stdout, byteLength: 3 },
      stderr: { path: stderr, byteLength: 8 },
      acknowledge,
    };
    let attempt = 0;
    const recorder = new EvidenceRecorderProcessOutput(
      {
        withhold: vi.fn(),
        storeArtifact(input) {
          attempt += 1;
          if (attempt === 2) return { kind: 'Unavailable' };
          const prepared = prepareEvidenceArtifact(input.bytes, input.mediaType);
          return prepared.kind === 'Prepared'
            ? { kind: 'Stored', artifact: prepared.artifact }
            : { kind: 'ArtifactRejected' };
        },
      },
      () => '2026-09-24T20:00:03.000Z',
    );

    await expect(recorder.record(output)).resolves.toEqual({ kind: 'EvidenceIntegrityFailure' });
    expect(acknowledge).not.toHaveBeenCalled();
  });
});
