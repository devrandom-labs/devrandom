import { mkdtemp, mkdir, writeFile, readFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProtectedCredentials } from '@devrandom/domain';
import {
  SourceCustody,
  type DockerEvaluationCompartment,
  type AuthorizedToolEffect,
} from '@devrandom/runtime';
import { prepareEvidenceArtifact } from '@devrandom/protocol';
import { expect, it } from 'vitest';
import { ManagedWorktreeResources } from '../../run/infrastructure/managed-worktree-tools.js';
import { DockerEvaluationToolEffects } from './docker-evaluation-tool-effects.js';

it('rejects a changed protected source before any tool effect and retains real edit receipts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devrandom-eval-tools-'));
  try {
    const workerRoot = join(root, 'worker');
    await mkdir(join(workerRoot, 'src'), { recursive: true });
    await mkdir(join(workerRoot, 'tests'));
    await writeFile(join(workerRoot, 'src/lib.rs'), 'before');
    await writeFile(join(workerRoot, 'tests/public.rs'), 'protected');
    const source = new SourceCustody(join(root, 'custody'), {
      maximumFiles: 20,
      maximumBytes: 4096,
      maximumPathBytes: 256,
    });
    const clean = await source.capture(workerRoot, () => Promise.resolve(false));
    if (clean.kind !== 'Captured') throw new Error('source');
    const worker = {
      copyDirectoryOut: (_from: string, to: string) => cp(workerRoot, to, { recursive: true }),
      copyInto: (from: string) =>
        cp(from, workerRoot, { recursive: true, force: true }),
    } as unknown as DockerEvaluationCompartment;
    const rules = { protectedPaths: ['tests'], completionCommands: [], toolCommands: [] };
    const resources = new ManagedWorktreeResources({ ...rules, worktree: workerRoot });
    const raws: unknown[] = [];
    const options = {
      worker,
      source,
      cleanSourceSaid: clean.sourceSaid,
      resources,
      resourceRules: rules,
      budget: { changedFiles: 2, changedWorktreeBytes: 32, aggregateChildCommandTimeSeconds: 20 },
      credentials: new ProtectedCredentials(),
      artifacts: {
        record: (input: { bytes: Uint8Array; mediaType: 'application/json' }) => {
          const prepared = prepareEvidenceArtifact(input.bytes, input.mediaType);
          if (prepared.kind !== 'Prepared') throw new Error('raw');
          raws.push(JSON.parse(Buffer.from(input.bytes).toString()));
          return Promise.resolve({ kind: 'Stored' as const, artifact: prepared.artifact });
        },
      },
    };
    const tools = new DockerEvaluationToolEffects(
      options as ConstructorParameters<typeof DockerEvaluationToolEffects>[0],
    );
    const effect: AuthorizedToolEffect = {
      proposal: {
        piSessionId: 'pi',
        modelTurnId: 'turn',
        toolCallId: 'edit',
        proposalIndex: 0,
        input: { kind: 'WriteFile', path: 'src/lib.rs', content: 'after' },
      },
      tool: 'write_file',
      requiredCapability: 'EditRepository',
      resource: 'repository://src/lib.rs',
    };
    expect(await tools.enact(effect, new AbortController().signal)).toMatchObject({
      kind: 'Completed',
    });
    expect(await readFile(join(workerRoot, 'src/lib.rs'), 'utf8')).toBe('after');
    expect(raws).toContainEqual(
      expect.objectContaining({
        kind: 'EvaluationRepositoryEffect',
        inputKind: 'WriteFile',
        sourceBeforeSaid: clean.sourceSaid,
      }),
    );
    await writeFile(join(workerRoot, 'tests/public.rs'), 'tampered');
    expect(
      await tools.enact(
        { ...effect, proposal: { ...effect.proposal, toolCallId: 'next' } },
        new AbortController().signal,
      ),
    ).toEqual({ kind: 'EvidenceIntegrityFailure' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
