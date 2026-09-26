import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { prepareEvidenceArtifact } from '@devrandom/protocol';
import type {
  PortableReferenceExecution,
  PortableReferenceObservation,
} from '../application/evaluate-portable-behavior.js';

const execute = promisify(execFile);
const verifier = `import {readFile} from 'node:fs/promises';
const source = JSON.parse(await readFile('public/format.json', 'utf8'));
const accepted = source.version === 'PUBLIC-V1' && source.mode === 'strict';
process.stdout.write(JSON.stringify({accepted, version: source.version, mode: source.mode}));
process.exitCode = accepted ? 0 : 1;
`;
const identify = (bytes: Uint8Array): string => {
  const prepared = prepareEvidenceArtifact(bytes, 'application/json');
  if (prepared.kind !== 'Prepared') throw new Error('Reference artifact rejected');
  return prepared.artifact.d;
};

/** Executes a fixed public portability reference, with no publisher repository or identity mounts. */
export class NodePortableBehaviorReference implements PortableReferenceExecution {
  async observe(): Promise<PortableReferenceObservation | { readonly kind: 'Unavailable' }> {
    const root = await mkdtemp(join(tmpdir(), 'devrandom-portable-reference-'));
    try {
      await mkdir(join(root, 'public'), { mode: 0o700 });
      await writeFile(join(root, 'verify.mjs'), verifier, { mode: 0o600 });
      const initial = Buffer.from(JSON.stringify({ version: 'PUBLIC-V1', mode: 'lenient' }));
      await writeFile(join(root, 'public/format.json'), initial, { mode: 0o600 });
      const lesson = Buffer.from(
        JSON.stringify({ version: 'PUBLIC-V1', action: 'restore-strict-mode' }),
      );
      await writeFile(join(root, 'public/experience.json'), lesson, { mode: 0o600 });
      const verify = async () => {
        const source = await readFile(join(root, 'public/format.json'));
        let exitCode = 0;
        let stdout: string;
        try {
          const child = await execute(process.execPath, ['verify.mjs'], {
            cwd: root,
            env: { LANG: 'C', NODE_ENV: 'production' },
            timeout: 5000,
            maxBuffer: 4096,
          });
          stdout = child.stdout;
        } catch (cause) {
          if (
            typeof cause !== 'object' ||
            cause === null ||
            !('code' in cause) ||
            cause.code !== 1 ||
            !('stdout' in cause) ||
            typeof cause.stdout !== 'string'
          )
            throw cause;
          exitCode = 1;
          stdout = cause.stdout;
        }
        if (!source.equals(await readFile(join(root, 'public/format.json'))))
          throw new Error('Reference source drift');
        return {
          sourceSaid: identify(source),
          sourceBytesBase64Url: source.toString('base64url'),
          exitCode,
          stdout,
        };
      };
      const negative = await verify();
      // Exact source read and bounded replanning use only this separately-created public lesson.
      const retrieved = await readFile(join(root, 'public/experience.json'));
      if (!retrieved.equals(lesson)) return { kind: 'Unavailable' };
      const parsed: unknown = JSON.parse(retrieved.toString('utf8'));
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !('action' in parsed) ||
        parsed.action !== 'restore-strict-mode'
      )
        return { kind: 'Unavailable' };
      const corrected = Buffer.from(JSON.stringify({ version: 'PUBLIC-V1', mode: 'strict' }));
      await writeFile(join(root, 'public/format.json'), corrected, { mode: 0o600 });
      const positive = await verify();
      return {
        kind: 'Observed',
        negative,
        positive,
        lessonSaid: identify(retrieved),
        lessonBytesBase64Url: retrieved.toString('base64url'),
        verifierSaid: identify(Buffer.from(JSON.stringify({ source: verifier }))),
        verifierBytesBase64Url: Buffer.from(JSON.stringify({ source: verifier })).toString(
          'base64url',
        ),
        stages: ['RetrieveExperience', 'ReadExactSource', 'Replan', 'FreshPublicVerify'],
      };
    } catch {
      return { kind: 'Unavailable' };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}
